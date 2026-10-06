// Application controller: the only API the UI talks to. Enforces applicability and dimensional
// validity on every write (independently of any disabled UI control).
import { Filing, FactValueError, normDims, dimKey } from './model.js';
import { Applicability, ApplicabilityError } from './applicability.js';
import { checkDimensionSyntax, dimensionallyValid, nextTypedMember, nondimAllowed } from './dimensions.js';
import { buildElrView, buildTableView, tableSlices, totalColumnAllowed, nondimRowConcepts, nondimRowElrs } from './views.js';
import { reportingYear, openingPeriodFor, scopeOf } from './periods.js';
import { carryingRuleFor, carryingTargetOf, rollForwardChangeOf, rollForwardClosingOf } from './derived.js';
import { Gate, exportXml } from './gate.js';
import { RuleEngine } from './rules.js';
import { importInstance, CashFlowChoiceError } from './importer.js';
import { toDisplay } from './scaling.js';
import * as Dec from './decimal.js';

export class DimensionError extends Error { constructor(msg, details) { super(msg); this.details = details; } }
export class CalculatedCellError extends Error {}

// Calculation-network index from the taxonomy calculation linkbase (read-only; the arcs are never changed).
const CALC = new WeakMap();
function calcIndex(A) {
  if (CALC.has(A)) return CALC.get(A);
  const parentsByChild = new Map(), childrenOf = new Map(), byParent = new Map();
  for (const [elr, arcs] of Object.entries(A.json.calculation)) {
    const code = A.json.roles[elr]?.code?.slice(0, 6);
    for (const a of arcs) {
      (parentsByChild.get(a.to) || parentsByChild.set(a.to, []).get(a.to)).push({ elr, code, parent: a.from });
      const k = elr + '|' + a.from;
      (childrenOf.get(k) || childrenOf.set(k, []).get(k)).push(a);
      (byParent.get(a.from) || byParent.set(a.from, []).get(a.from)).push({ elr, code });
    }
  }
  // MCA sheet "Parent child exempt calculation" (rules.js calcExemptions): a total whose parts are ALL exempt (interest
  // expense, equity share warrants, refundable deposits, directors' remuneration, …) need not equal the sum of the parts
  // reported — it is filled from them while empty but stays editable (a "soft" total)
  const ex = new RuleEngine(A).calcExemptions();
  const soft = new Set();
  for (const [k, arcs] of childrenOf) if (arcs.every((a) => ex.has(a.to))) soft.add(k);
  const idx = { parentsByChild, childrenOf, byParent, soft };
  CALC.set(A, idx);
  return idx;
}

// decimals of a calculated total: the parts' lowest decimals (XBRL inferred accuracy), but never fewer than the total's
// own digits need — a part imported at decimals="-4" next to parts at "-3" must not make a total with a non-zero
// thousands digit invalid (Filing Manual #13 non-significant digits)
function totalDecimals(decs, total) {
  if (!decs.length) return 'INF';
  const need = Dec.requiredDecimals(total);
  return String(Math.max(Math.min(...decs), need === Infinity ? -Infinity : need));
}
// the display value a user typed equals what the cell shows (numbers compared as numbers)
function sameDisplay(S, fact, display) {
  if (!fact || fact.nil || display == null) return false;
  const shown = String(S.displayOf(fact)).replace(/,/g, '').trim(), typed = String(display).replace(/,/g, '').trim();
  if (typed === '') return false;
  if (S.A.isNumeric(fact.concept)) return Dec.isDecimalString(typed) && Dec.isDecimalString(shown) && Dec.eq(Dec.parse(typed), Dec.parse(shown));
  return typed === shown;
}
// a total agrees with the sum of its parts when equal after rounding both to the total's decimals (XBRL Calculations 1.1)
function agrees(x, sum) {
  const d = x.decimals == null || x.decimals === 'INF' ? 'INF' : Number(x.decimals);
  return Dec.eq(Dec.round(Dec.parse(x.value), d), Dec.round(sum.total, d));
}

export class Session {
  constructor(A, filing = null) {
    this.A = A;
    this.app = new Applicability(A);
    this.filing = filing || new Filing(A);
    this._views = new Map();
  }

  // ---- filing setup: meta values are mirrored into the general-information facts
  setMeta(patch) {
    const oldCyEnd = this.filing.meta.periods?.cy?.end;
    Object.assign(this.filing.meta, patch);
    if (patch.periods) this.filing.meta.periods = { ...this.filing.meta.periods, ...patch.periods };
    const f = this.filing, A = this.A, P = f.meta.periods;
    // a "Current year only" import treats previous-year-end opening balances as current-year cells; once the
    // current year is moved (next year's filing prepared from it) both years are ordinary filing years
    if (f.meta.yearMode === 'current' && oldCyEnd && P.cy?.end && P.cy.end !== oldCyEnd) f.meta.yearMode = 'both';
    const mirror = (local, value, scopes = ['CY']) => {
      const q = A.qnameOfLocal(local);
      if (!q || value == null || value === '') return;
      for (const s of scopes) { const p = f.period(q, s); if (p) f.setFact({ concept: q, period: p, value, origin: 'meta', lang: A.isNumeric(q) ? null : 'en' }); }
    };
    if (P.cy.start && P.cy.end) {
      mirror('CorporateIdentityNumber', f.meta.cin);
      mirror('NatureOfReportStandaloneConsolidated', f.meta.reportType);
      mirror('LevelOfRoundingUsedInFinancialStatements', f.meta.level);
      mirror('DateOfStartOfReportingPeriod', P.cy.start);
      mirror('DateOfEndOfReportingPeriod', P.cy.end);
      if (!f.meta.firstFinancialYear && P.py.start && P.py.end) {
        const qs = A.qnameOfLocal('DateOfStartOfReportingPeriod'), qe = A.qnameOfLocal('DateOfEndOfReportingPeriod');
        f.setFact({ concept: qs, period: f.period(qs, 'PY'), value: P.py.start, origin: 'meta' });
        f.setFact({ concept: qe, period: f.period(qe, 'PY'), value: P.py.end, origin: 'meta' });
      }
    }
    f.revision++;
  }

  elrView(uri) { if (!this._views.has(uri)) this._views.set(uri, buildElrView(this.A, uri)); return this._views.get(uri); }
  tableView(id) { const k = 'T' + id; if (!this._views.has(k)) this._views.set(k, buildTableView(this.A, id)); return this._views.get(k); }

  elrStatus(uri, scope) { return this.app.elrStatus(this.filing, uri, scope); }
  conceptStatus(q, scope) { return this.app.conceptStatus(this.filing, q, scope); }
  tableStatus(id, scope) { return this.app.tableStatus(this.filing, id, scope); }

  // ---- non-dimensional values
  periodForCell(concept, scope, preferredLabel) {
    const c = this.A.concept(concept);
    if (c.periodType === 'instant' && preferredLabel === 'periodStartLabel') return openingPeriodFor(this.filing.meta.periods, scope);
    return this.filing.period(concept, scope);
  }
  getValue(concept, scope, dims = [], preferredLabel = null) {
    const p = this.periodForCell(concept, scope, preferredLabel);
    return p ? this.filing.get(concept, p, dims) : null;
  }
  displayOf(fact) {
    if (!fact || fact.nil) return '';
    return this.A.dataType(fact.concept) === 'monetary' ? toDisplay(fact.value, this.filing.meta.level) : fact.value;
  }
  // Editing options (UI): tab = the filing tab (ELR) the cell is on — its applicability decides (cellStatus);
  // recalc = re-derive calculated parent cells; override = the tab's "edit calculated cells" option is on.
  setValue(concept, scope, display, { preferredLabel = null, tab = null, recalc = false, override = false } = {}) {
    const st = tab ? this.app.cellStatus(this.filing, tab, concept, scope) : this.app.conceptStatus(this.filing, concept, scope);
    if (!st.applicable) throw new ApplicabilityError(`${concept} is not applicable for ${scope}`, st.reasons);
    if (!nondimAllowed(this.A, concept)) throw new DimensionError(`${concept} can only be reported inside its table`);
    if (tab && !override && this.calculatedCell(concept, scope, [], tab, preferredLabel)) {
      const cur = this.getValue(concept, scope, [], preferredLabel);
      if (sameDisplay(this, cur, display)) return cur; // typing the value it already shows is not an error
      throw new CalculatedCellError(`${this.A.label(concept)} is calculated from its child elements — enable editing of calculated cells for this tab to override it`);
    }
    const p = this.periodForCell(concept, scope, preferredLabel);
    if (!p) throw new FactValueError('Reporting periods are not set');
    const before = this.filing.get(concept, p, []);
    const was = before && !before.nil ? before.value : null;
    const calc = override && tab ? this.calculatedCell(concept, scope, [], tab, preferredLabel) : null;
    const f = this.filing.setDisplayValue({ concept, period: p, display });
    if (f && calc) f.origin = 'override';
    if (recalc) this.recalcFrom(concept, p, [], 0, { before: was, after: f && !f.nil ? f.value : null });
    return f;
  }

  // ---- calculated (auto-populated) cells
  // A cell is calculated when the tab's own calculation network (same ELR code) defines the concept as a parent
  // with at least one child that can be reported in the cell's context, and that network applies to the filing.
  // Locked (read-only, recalculated) only where the arithmetic is required and a part has a value: a total of the
  // tab's own calculation network that is not MCA-exempt, once at least one of its parts has a value in the cell's
  // context; a carrying amount once its gross or accumulated cell has a value. A total without any part entered is an
  // ordinary input cell (e.g. an opening balance whose breakup is not reported) — GR-1 tells when parts are required.
  calculatedCell(concept, scope, dims = [], tabElrUri = null, preferredLabel = null) {
    const A = this.A, f = this.filing;
    const idx = calcIndex(A);
    const code = tabElrUri ? A.elr(tabElrUri)?.code.slice(0, 6) : null;
    const nd = normDims(dims);
    const p = this.periodForCell(concept, scope, preferredLabel);
    if (!p) return null;
    for (const { elr, code: c } of idx.byParent.get(concept) || []) {
      if (code && c !== code) continue;
      if (idx.soft.has(elr + '|' + concept)) continue;
      const pres = A.elrs.find((e) => e.code === c);
      if (pres && !this.app.elrStatus(f, pres.uri, scope).applicable) continue;
      const sum = this.networkSum(elr, concept, p, nd);
      if (!sum.count) continue;
      // maintained by the tool: empty, calculated, or agreeing with its parts; a different figure that was entered
      // or imported is the filer's own and stays editable (GR-1 reports the difference)
      // an empty cell is never locked (the tool fills it as soon as a part changes; until then it can be typed)
      const x = f.get(concept, p, nd);
      if (x && !x.nil && (x.origin === 'calculated' || x.origin === 'override' || agrees(x, sum))) return { elr, children: (idx.childrenOf.get(elr + '|' + concept) || []).map((a) => a.to) };
    }
    return this.derivedCell(concept, scope, dims, preferredLabel, tabElrUri);
  }
  // Locked cells derived outside the calculation linkbase (derived.js): carrying amount = gross − accumulated (MCA
  // SR-L1364-2 / SR-L1380-1 …), when the gross or accumulated cell of the same row/column has a value. The closing
  // balance (opening + changes) is not an MCA rule: it is filled while empty and stays editable (applyDerived soft).
  derivedCell(concept, scope, dims = [], preferredLabel = null, tabElrUri = null) {
    const A = this.A, f = this.filing;
    if (!A.isNumeric(concept)) return null;
    const nd = normDims(dims);
    // a statement figure (e.g. Tangible assets on the balance sheet) is never locked on the statement by a note's
    // derivation: it can always be typed there; the note's MCA rule reports a difference
    if (!nd.length && tabElrUri && nondimRowElrs(A).get(concept)?.has(tabElrUri)) return null;
    const p = this.periodForCell(concept, scope, preferredLabel);
    if (!p) return null;
    if (this.statementFigure(concept, p, nd)) return null;
    const r = carryingRuleFor(A, concept, nd);
    if (r && [...r.plusDims, ...r.minusDims].some((d) => f.get(concept, p, normDims(d)))) {
      // maintained only while empty, calculated or agreeing; a different value that was entered stays editable and
      // MCA SR-L1364-2 / SR-L1380-1 point to it
      const x = f.get(concept, p, nd);
      const v = this.carryingValue(concept, p, nd);
      if (!x || x.nil) return null; // empty: never locked
      if (x.origin !== 'calculated' && x.origin !== 'override' && v && !Dec.eq(Dec.parse(x.value), Dec.parse(v.value))) return null;
      return { derived: 'carrying', rules: r.rules, children: [] };
    }
    return null;
  }
  // Σ(child × weight) of the parts reported for one total of one calculation network
  networkSum(elr, parent, period, nd, override = null) {
    const f = this.filing;
    const kids = (calcIndex(this.A).childrenOf.get(elr + '|' + parent) || []).map((a) => ({ a, fact: override && a.to === override.concept ? override.fact : f.get(a.to, period, nd) })).filter((k) => k.fact && !k.fact.nil);
    const total = Dec.sum(kids.map((k) => Dec.mul(Dec.parse(k.fact.value), Dec.parse(String(k.a.weight)))));
    const decs = kids.map((k) => k.fact.decimals).filter((d) => d != null && d !== 'INF').map(Number);
    return { count: kids.length, total, decimals: totalDecimals(decs, total), unit: kids[0]?.fact.unit, kids };
  }
  // Re-derive the calculation parents of an edited cell (same period and dimensions), bottom-up. The parent is
  // Σ(child × weight) of the children reported in its network. A total FOLLOWS its parts when it is empty, calculated,
  // or agreed with its parts before this edit; a total that was entered or imported with a different value is the
  // filer's own figure and is kept (GR-1 shows the difference at that cell, which stays editable) — so the result does
  // not depend on the order in which totals and parts are typed. A manual override is never replaced.
  // change = { before, after } values of the edited cell; force (explicit Recalculate) makes every total follow.
  recalcFrom(concept, period, dims = [], depth = 0, change = null, { force = false } = {}) {
    if (depth > 40) return;
    const A = this.A, f = this.filing, idx = calcIndex(A);
    const nd = normDims(dims);
    const seen = new Set();
    for (const { elr, code, parent } of idx.parentsByChild.get(concept) || []) {
      if (seen.has(parent)) continue;
      const pc = A.concept(parent);
      if (!pc || (pc.periodType === 'instant') !== (period.type === 'instant')) continue;
      const pres = A.elrs.find((e) => e.code === code);
      const scope = reportingYear(f.meta.periods, period);
      if (scope !== 'CY' && scope !== 'PY') continue;
      if (pres && !this.app.elrStatus(f, pres.uri, scope).applicable) continue;
      if (!this.app.conceptStatus(f, parent, scope).applicable) continue;
      if (nd.length ? !dimensionallyValid(A, parent, nd).valid : !nondimAllowed(A, parent)) continue;
      const existing = f.get(parent, period, nd);
      if (existing && existing.origin === 'override') { seen.add(parent); continue; }
      const now = this.networkSum(elr, parent, period, nd);
      const typed = existing && !existing.nil && existing.origin !== 'calculated';
      if (typed && !force) {
        // an MCA-exempt total keeps a value that was entered (soft); another total keeps it unless it agreed with its
        // parts before this edit
        if (idx.soft.has(elr + '|' + parent)) { seen.add(parent); continue; }
        const old = change && concept !== parent ? this.networkSum(elr, parent, period, nd, { concept, fact: change.before == null ? null : { value: change.before, decimals: 'INF', nil: false } }) : null;
        if (!old || !old.count || !agrees(existing, old)) { seen.add(parent); continue; }
      }
      seen.add(parent);
      if (!now.count) { if (existing && existing.origin === 'calculated') { f.removeFact(existing.key); this.recalcFrom(parent, period, nd, depth + 1, { before: existing.value, after: null }, { force }); } continue; }
      const value = Dec.toString(now.total);
      // an identical value is left as it is (keeps its origin, e.g. an imported total)
      if (!(existing && !existing.nil && existing.value === value && existing.decimals === now.decimals)) f.setFact({ concept: parent, period, dims: nd, value, decimals: now.decimals, unit: now.unit, origin: 'calculated' });
      this.recalcFrom(parent, period, nd, depth + 1, { before: existing && !existing.nil ? existing.value : null, after: value }, { force });
    }
    this.deriveFrom(concept, period, nd, depth, force, change);
  }

  // Re-derive the cells derived from an edited cell (derived.js): the carrying-amount cell of a gross/accumulated
  // cell, and the current-year closing balance of a reconciliation when its net change or opening balance changes.
  deriveFrom(concept, period, nd, depth, force = false, change = null) {
    const A = this.A, f = this.filing;
    if (!A.isNumeric(concept)) return;
    const td = carryingTargetOf(A, concept, nd);
    if (td) {
      const tdn = normDims(td);
      // the carrying amount before this edit: an entered carrying value follows only if it agreed with it
      const prior = () => {
        if (!change) return null;
        const now = this.carryingValue(concept, period, tdn);
        if (!now) return null;
        const r = carryingRuleFor(A, concept, tdn);
        const minus = r.minusDims.some((d) => dimKey(normDims(d)) === dimKey(nd));
        const delta = Dec.sub(change.after == null ? Dec.ZERO : Dec.parse(change.after), change.before == null ? Dec.ZERO : Dec.parse(change.before));
        return minus ? Dec.add(Dec.parse(now.value), delta) : Dec.sub(Dec.parse(now.value), delta);
      };
      this.applyDerived(concept, period, tdn, depth, () => this.carryingValue(concept, period, tdn), { force, prior });
    }
    const P = f.meta.periods;
    const s = scopeOf(P, period);
    const closing = rollForwardClosingOf(A, concept);
    if (closing && s === 'CY' && period.type === 'duration') { const cp = f.period(closing, 'CY'); if (cp) this.applyDerived(closing, cp, nd, depth, () => this.rollForwardValue(closing, nd), { soft: true, force }); }
    if (s === 'PY' && period.type === 'instant' && rollForwardChangeOf(A, concept)) { const cp = f.period(concept, 'CY'); if (cp) this.applyDerived(concept, cp, nd, depth, () => this.rollForwardValue(concept, nd), { soft: true, force }); }
  }
  carryingValue(concept, period, dims) {
    const r = carryingRuleFor(this.A, concept, dims);
    if (!r) return undefined;
    const get = (d) => { const x = this.filing.get(concept, period, normDims(d)); return x && !x.nil ? x : null; };
    const plus = r.plusDims.map(get).filter(Boolean), minus = r.minusDims.map(get).filter(Boolean);
    if (!plus.length && !minus.length) return null;
    const v = Dec.sub(Dec.sum(plus.map((x) => Dec.parse(x.value))), Dec.sum(minus.map((x) => Dec.parse(x.value))));
    return { value: Dec.toString(v), from: [...plus, ...minus] };
  }
  rollForwardValue(concept, dims) {
    const A = this.A, f = this.filing;
    const ch = rollForwardChangeOf(A, concept);
    const cf = f.get(ch, f.period(ch, 'CY'), dims);
    if (!cf || cf.nil) return null;
    // the carrying column of an asset reconciliation follows gross − accumulated when those closings exist
    const r = carryingRuleFor(A, concept, dims);
    if (r && [...r.plusDims, ...r.minusDims].some((d) => f.get(concept, f.period(concept, 'CY'), normDims(d)))) return undefined;
    const open = f.get(concept, f.period(concept, 'PY'), dims);
    const v = Dec.add(open && !open.nil ? Dec.parse(open.value) : Dec.ZERO, Dec.parse(cf.value));
    return { value: Dec.toString(v), from: [cf, ...(open && !open.nil ? [open] : [])] };
  }
  // set (or clear) one derived cell; undefined = another derivation owns the cell, null = no sources left
  applyDerived(concept, period, dims, depth, compute, { soft = false, force = false, prior = null } = {}) {
    const A = this.A, f = this.filing;
    const scope = reportingYear(f.meta.periods, period);
    if (scope !== 'CY' && scope !== 'PY') return;
    if (!this.app.conceptStatus(f, concept, scope).applicable) return;
    if (dims.length ? !dimensionallyValid(A, concept, dims).valid : !nondimAllowed(A, concept)) return;
    const existing = f.get(concept, period, dims);
    if (existing && existing.origin === 'override') return;
    if (this.statementFigure(concept, period, dims)) return;
    // soft (closing balance): an entered value is kept — audited closings may differ from opening + changes by rounding
    if (soft && !force && existing && !existing.nil && existing.origin !== 'calculated') return;
    // an entered value is kept unless it agreed with the derivation before this edit (order-independent, never stuck)
    if (!soft && !force && existing && !existing.nil && existing.origin !== 'calculated') {
      const before = prior ? prior() : null;
      if (!before || !Dec.eq(Dec.parse(existing.value), before)) return;
    }
    const res = compute();
    if (res === undefined) return;
    if (res === null) {
      if (existing && existing.origin === 'calculated') { f.removeFact(existing.key); this.recalcFrom(concept, period, dims, depth + 1, { before: existing.value, after: null }, { force }); }
      return;
    }
    const decs = res.from.map((x) => x.decimals).filter((d) => d != null && d !== 'INF').map(Number);
    const decimals = totalDecimals(decs, Dec.parse(res.value));
    if (existing && !existing.nil && existing.value === res.value && existing.decimals === decimals) return;
    f.setFact({ concept, period, dims, value: res.value, decimals, unit: res.from[0].unit, origin: 'calculated' });
    this.recalcFrom(concept, period, dims, depth + 1, { before: existing && !existing.nil ? existing.value : null, after: res.value }, { force });
  }

  // A figure of a statement (its own non-dimensional row, e.g. Tangible assets / Share capital on the balance sheet)
  // that was entered or imported is kept: a note's total column is the same fact, and the note must agree with the
  // statement — MCA rules SR-L1364-2 / SR-L1381-2 / SR-L374-1 … report a difference at the note. It is derived only
  // while empty or itself calculated.
  statementFigure(concept, period, dims) {
    if (dims.length || !nondimRowConcepts(this.A).has(concept)) return false;
    const x = this.filing.get(concept, period, []);
    return !!x && !x.nil && x.origin !== 'calculated' && x.origin !== 'override';
  }

  // Recalculate every calculated / derived cell of the given scopes from the values entered (explicit user action).
  // Previous-year values (last year's filed figures) are not touched unless 'PY' is asked for. A manual override is
  // never replaced. With apply=false the filing is left unchanged and the changes are only reported.
  recalculateAll({ scopes = ['CY'], apply = true, force = true } = {}) {
    const A = this.A, f = this.filing;
    const before = new Map(f.facts);
    for (let pass = 0; pass < 3; pass++) {
      const rev = f.revision;
      const sources = f.all().filter((x) => !x.nil && A.isNumeric(x.concept) && scopes.includes(f.scopeOf(x.period)));
      for (const x of sources) if (f.facts.get(x.key)) this.recalcFrom(x.concept, x.period, x.dims, 0, null, { force });
      if (f.revision === rev) break;
    }
    const changes = [];
    for (const [k, x] of f.facts) { const b = before.get(k); if (!b) changes.push({ key: k, before: null, after: x }); else if (b !== x && (b.value !== x.value || b.nil !== x.nil)) changes.push({ key: k, before: b, after: x }); }
    for (const [k, b] of before) if (!f.facts.has(k)) changes.push({ key: k, before: b, after: null });
    if (!apply) { f.facts = before; f.revision++; }
    return { changes };
  }

  // ---- tables (authoritative controller layer)
  openTable(tableId, scope) {
    this.app.assertTableOpen(this.filing, tableId, scope);
    const view = this.tableView(tableId);
    const slices = tableSlices(this.A, this.filing, tableId, scope, reportingYear);
    return { view, slices, status: this.app.tableStatus(this.filing, tableId, scope) };
  }
  validateSlice(tableId, dims) {
    const t = this.A.table(tableId);
    const nd = normDims(dims);
    const errs = checkDimensionSyntax(this.A, nd);
    for (const d of nd) if (!t.axes.some((a) => a.axis === d.axis)) errs.push({ code: 'dim.notInTable', msg: `${d.axis} is not an axis of ${t.hypercube}` });
    // every axis at its default = the table's total column (facts without dimensions, as MCA reports table totals)
    if (!nd.length && t.axes.length && !totalColumnAllowed(this.A, tableId)) errs.push({ code: 'dim.none', msg: 'At least one axis member is required for a table row' });
    if (errs.length) throw new DimensionError(errs.map((e) => e.msg).join('; '), errs);
    return nd;
  }
  setTableValue(tableId, scope, dims, concept, display, { preferredLabel = null, recalc = false, override = false, lockCalculated = false } = {}) {
    this.app.assertTableOpen(this.filing, tableId, scope);
    const t = this.A.table(tableId);
    if (!t.lineItems.includes(concept)) throw new DimensionError(`${concept} is not a line item of ${t.hypercube}`);
    const nd = this.validateSlice(tableId, dims);
    const dv = dimensionallyValid(this.A, concept, nd);
    if (!dv.valid) throw new DimensionError(`${concept} is not valid for [${dimKey(nd)}]: ${dv.reason}`);
    const st = this.app.conceptStatus(this.filing, concept, scope);
    if (!st.applicable) throw new ApplicabilityError(`${concept} is not applicable for ${scope}`, st.reasons);
    const calc = lockCalculated || override ? this.calculatedCell(concept, scope, nd, t.presentationElr, preferredLabel) : null;
    if (lockCalculated && !override && calc && sameDisplay(this, this.getValue(concept, scope, nd, preferredLabel), display)) return this.getValue(concept, scope, nd, preferredLabel);
    if (lockCalculated && !override && calc) throw new CalculatedCellError(`${this.A.label(concept)} is calculated from its child elements — enable editing of calculated cells for this tab to override it`);
    const p = this.periodForCell(concept, scope, preferredLabel);
    const before = this.filing.get(concept, p, nd);
    const was = before && !before.nil ? before.value : null;
    const f = this.filing.setDisplayValue({ concept, period: p, dims: nd, display });
    if (f && override && calc) f.origin = 'override';
    if (recalc) this.recalcFrom(concept, p, nd, 0, { before: was, after: f && !f.nil ? f.value : null });
    return f;
  }
  // rename a typed member (edit imported or new typed members) — moves every fact of the slice
  renameTypedMember(tableId, scope, dims, axis, newValue) {
    this.app.assertTableOpen(this.filing, tableId, scope);
    if (!String(newValue).trim()) throw new DimensionError('Typed member value must not be empty');
    const from = dimKey(normDims(dims));
    const to = normDims(dims.map((d) => (d.axis === axis ? { axis, typed: newValue } : d)));
    this.validateSlice(tableId, to);
    const moved = [];
    for (const f of this.filing.all()) {
      if (dimKey(f.dims) !== from || reportingYear(this.filing.meta.periods, f.period) !== scope) continue;
      if (this.filing.get(f.concept, f.period, to)) throw new DimensionError(`A row with ${axis}="${newValue}" already exists`);
      moved.push(f);
    }
    for (const f of moved) {
      this.filing.removeFact(f.key);
      this.filing.setFact({ ...f, dims: to, value: f.value, origin: f.origin === 'import' ? 'edited' : f.origin });
    }
    return to;
  }
  // facts of one table column: only the table's own line items (another table may use the same member combination);
  // for the total column, not the elements that are also rows of a statement/note or of another table's total column
  sliceFacts(tableId, scope, dims) {
    const A = this.A, t = A.table(tableId);
    const k = dimKey(normDims(dims));
    let items = new Set(t.lineItems);
    if (!k) {
      const shared = nondimRowConcepts(A);
      const other = new Set(A.tables.filter((x) => x.id !== tableId && totalColumnAllowed(A, x.id)).flatMap((x) => x.lineItems));
      items = new Set([...items].filter((q) => !shared.has(q) && !other.has(q)));
    }
    return this.filing.all().filter((f) => items.has(f.concept) && dimKey(f.dims) === k && reportingYear(this.filing.meta.periods, f.period) === scope);
  }
  removeSlice(tableId, scope, dims) {
    for (const f of this.sliceFacts(tableId, scope, dims)) this.filing.removeFact(f.key);
  }
  suggestTypedValue(tableId, scope, axis) {
    const view = this.tableView(tableId);
    const ax = view.axes.find((a) => a.axis === axis);
    const prefix = (ax.typedDomain || axis).split(':')[1].replace(/Domain$/, '').replace(/ies$/, 'y').replace(/s$/, '');
    const existing = this.filing.all().flatMap((f) => f.dims.filter((d) => d.axis === axis && d.typed != null).map((d) => d.typed));
    // keep the naming already used on this axis (uniform, sequential member names — Filing Manual §1.3.2(6))
    const used = existing.map((v) => /^(.*?)\d+$/.exec(v)?.[1]).filter((x) => x != null);
    return nextTypedMember(existing, used.length ? used.sort()[0] : prefix);
  }

  // ---- validation / XML
  validate(opts) { return new Gate(this.A).run(this.filing, opts); }
  validateTab(elrUri, opts = {}) { return new Gate(this.A).run(this.filing, { ...opts, tab: elrUri }); }
  cellStatus(elrUri, concept, scope) { return this.app.cellStatus(this.filing, elrUri, concept, scope); }
  dependencies() { return this.app.deps; }
  exportXml(opts) { return exportXml(this.A, this.filing, opts); }
  // Dry run used by the import dialog: year breakdown of the source before the user chooses a mode.
  previewXml(text, opts = {}) {
    let res;
    try { res = importInstance(this.A, text, { ...opts, yearMode: 'both' }); }
    catch (e) {
      if (!(e instanceof CashFlowChoiceError)) throw e;
      // ambiguous cash-flow method: preview with either method to show the year split, then ask the user
      res = importInstance(this.A, text, { ...opts, yearMode: 'both', cashFlowMethod: 'Indirect Method' });
      res.report.cashFlow = { ...e.cashFlow, needsChoice: true };
    }
    const { report } = res;
    return { periods: report.periodDetection, byYear: report.byYear, counts: report.counts, unresolved: report.unresolvedFacts.length, errors: report.errors, cashFlow: report.cashFlow, notApplicable: report.notApplicable.length };
  }
  importXml(text, opts) {
    const { filing, report } = importInstance(this.A, text, opts);
    this.filing = filing;
    this._views.clear();
    // next year's filing: mirror the company information into the new current year (CIN, report type, rounding, dates)
    if (report.yearMode === 'next') this.setMeta({});
    return report;
  }

  // Previous-year opening balances (instants at the day before the previous year starts). A filing prepared by
  // moving last year's current-year-only import forward carries last year's opening balances there; MCA-validated
  // instances report none (INFOBAHN) or report them together with their parents (CHARVAK).
  pyOpeningFacts() { return this.filing.all().filter((f) => this.filing.scopeOf(f.period) === 'PYO'); }
  removePyOpeningFacts() { const list = this.pyOpeningFacts(); for (const f of list) this.filing.removeFact(f.key); return list.length; }
}

export { ApplicabilityError };
