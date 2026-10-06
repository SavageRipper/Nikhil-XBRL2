// Applicability engine: which ELRs, concepts and tables apply to a filing, per scope (CY/PY).
// Sources: generic rules GR-11..GR-14 (report type / previous year), table rules from the
// specific-rules sheet ("table is mandatory in case ..."), and the cash-flow statement type.
// This is the AUTHORITATIVE gate: the UI reads it to disable controls, and the controller and the
// XML gate enforce it independently.
import { evalPred } from './expr.js';
import { reportingYear } from './periods.js';
import { tablesForFact, nondimAllowed } from './dimensions.js';
import { nondimRowConcepts, totalColumnAllowed } from './views.js';

const CASHFLOW = { '100300': 'Direct Method', '100400': 'Indirect Method' };

// concepts presented with an opening-balance (periodStart) row — the GR-7 common opening/closing element
const OPENING = new WeakMap();
export function openingConcepts(A) {
  if (OPENING.has(A)) return OPENING.get(A);
  const set = new Set();
  for (const arcs of Object.values(A.json?.presentation || {})) for (const a of arcs) if (/periodStartLabel$/.test(a.preferredLabel || '') && A.concept(a.to)?.periodType === 'instant') set.add(a.to);
  OPENING.set(A, set);
  return set;
}

export class ApplicabilityError extends Error {
  constructor(msg, reasons) { super(msg); this.reasons = reasons; }
}

export class Applicability {
  constructor(A) {
    this.A = A;
    const g = (n) => A.rules.rules.find((r) => r.id === `GR-${n}`)?.ast || {};
    this.gr11 = new Set(g(11).codes || []);
    this.gr12 = new Set(g(12).codes || []);
    this.gr12ex = g(12).exceptions || {};
    this.gr13 = new Set(g(13).allowed || []);
    this.gr14 = new Set(g(14).codes || []);
    this.countries = new Set((A.rules.countries || []).map((c) => c.toUpperCase()));
    // Yes/No dependencies compiled from the MCA conditional rules (rule-formalizer.mjs → booleanDependencies)
    this.deps = A.rules.booleanDependencies || [];
    this.depsByChild = new Map();
    for (const d of this.deps) for (const c of d.childConcepts) (this.depsByChild.get(c) || this.depsByChild.set(c, []).get(c)).push(d);
  }

  // Boolean dependency state of a child concept: not applicable when its parent Yes/No element is answered with
  // the opposite of the condition under which the MCA rule requires the child.
  dependencyStatus(filing, concept, scope) {
    const reasons = [];
    for (const d of this.depsByChild.get(concept) || []) {
      const v = filing.value(d.parentConcept, scope, []);
      if (v == null) continue;
      if ((v === 'true') !== d.condition) reasons.push(`DEP: '${this.A.label(d.parentConcept)}' is ${v === 'true' ? 'Yes' : 'No'} — applies only when ${d.condition ? 'Yes' : 'No'} (${d.rules.join(', ')})`);
    }
    return { applicable: reasons.length === 0, reasons };
  }

  env(filing, scope, extra = {}) {
    return { filing, A: this.A, scope, dims: [], today: new Date().toISOString().slice(0, 10), countries: this.countries, ...extra };
  }

  cashFlowType(filing) {
    const q = this.A.qnameOfLocal('TypeOfCashFlowStatement');
    return filing.value(q, 'CY', []);
  }

  // ---- ELR level
  elrStatus(filing, elrUri, scope) {
    const e = this.A.elr(elrUri);
    if (!e) return { applicable: false, reasons: ['Unknown ELR'] };
    const code = e.code.slice(0, 6);
    const reasons = [];
    const rt = filing.meta.reportType;
    if (rt === 'Consolidated' && this.gr11.has(code)) reasons.push(`GR-11: [${code}] not applicable to a consolidated instance`);
    if (rt === 'Standalone' && this.gr14.has(code)) reasons.push(`GR-14: [${code}] not applicable to a standalone instance`);
    if (scope !== 'CY' && this.gr12.has(code)) reasons.push(`GR-12: [${code}] not applicable for the previous year`);
    if (scope !== 'CY' && filing.meta.firstFinancialYear) reasons.push('First financial year: no previous-year figures');
    if (CASHFLOW[code]) {
      const t = this.cashFlowType(filing);
      if (t && t !== CASHFLOW[code]) reasons.push(`TypeOfCashFlowStatement is '${t}'`);
    }
    return { applicable: reasons.length === 0, reasons, partialExceptions: scope !== 'CY' ? this.gr12ex[code] || null : null };
  }

  // ---- concept level: applicable if at least one of its presentation ELRs applies
  conceptStatus(filing, concept, scope) {
    const elrs = this.A.conceptElrs(concept);
    if (!elrs.length) return { applicable: true, reasons: [] };
    const local = this.A.concept(concept).name;
    const reasons = [];
    for (const uri of elrs) {
      const st = this.elrStatus(filing, uri, scope);
      const code = this.A.elr(uri).code.slice(0, 6);
      let ok = st.applicable;
      // GR-12 element exceptions for the previous year
      if (!ok && scope !== 'CY' && !filing.meta.firstFinancialYear && st.reasons.every((r) => r.startsWith('GR-12')) && (this.gr12ex[code] || []).includes(local)) ok = true;
      // GR-13: general information in a consolidated instance only for listed elements
      if (ok && filing.meta.reportType === 'Consolidated' && code === '400100' && !this.gr13.has(local)) { ok = false; st.reasons.push(`GR-13: '${local}' not applicable in a consolidated instance`); }
      if (ok) return this.dependencyStatus(filing, concept, scope);
      reasons.push(...st.reasons);
    }
    return { applicable: false, reasons: [...new Set(reasons)] };
  }

  // ---- cell level: one cell = (filing tab / ELR, concept, scope). The single decision used by the UI (enable,
  // display), the importer (keep/drop), the gate (emit/exclude) and generation.
  cellStatus(filing, elrUri, concept, scope) {
    const st = this.elrStatus(filing, elrUri, scope);
    if (!st.applicable) {
      const code = this.A.elr(elrUri)?.code.slice(0, 6);
      const local = this.A.concept(concept)?.name;
      const gr12only = scope !== 'CY' && !filing.meta.firstFinancialYear && st.reasons.every((r) => r.startsWith('GR-12')) && (this.gr12ex[code] || []).includes(local);
      if (!gr12only) return { applicable: false, reasons: st.reasons };
    }
    return this.conceptStatus(filing, concept, scope);
  }

  // ---- fact level: which facts of a filing are filing data (emit) and which are not applicable (excluded)
  planFacts(filing) {
    const emit = [], excluded = [];
    const P = filing.meta.periods;
    const opening = filing.meta.yearMode === 'current' ? openingConcepts(this.A) : null;
    for (const f of filing.all()) {
      let y = reportingYear(P, f.period);
      if (y !== 'CY' && y !== 'PY') { emit.push(f); continue; } // reported by period checks
      // current-year-only filing: a previous-year-end instant of an opening-balance concept is the current-year
      // opening balance (GR-7), so it is a current-year cell
      if (opening && y === 'PY' && f.period.type === 'instant' && opening.has(f.concept)) y = 'CY';
      const cs = this.conceptStatus(filing, f.concept, y);
      if (!cs.applicable) { excluded.push({ fact: f, reasons: cs.reasons }); continue; }
      if (f.dims.length) {
        const ts = tablesForFact(this.A, f);
        if (ts.length && !ts.some((t) => this.tableStatus(filing, t.id, y).applicable)) {
          excluded.push({ fact: f, reasons: ts.flatMap((t) => this.tableStatus(filing, t.id, y).reasons) });
          continue;
        }
      }
      emit.push(f);
    }
    return { emit, excluded };
  }

  // ---- table level
  tableStatus(filing, tableId, scope) {
    const t = this.A.table(tableId);
    if (!t) return { applicable: false, reasons: ['Unknown table'] };
    if (t.presentationElr) {
      const st = this.elrStatus(filing, t.presentationElr, scope);
      if (!st.applicable) {
        // previous-year ELR exceptions may keep individual line items alive (GR-12)
        const ex = st.partialExceptions || [];
        if (!(st.reasons.every((r) => r.startsWith('GR-12')) && t.lineItems.some((q) => ex.includes(this.A.concept(q).name)))) return { applicable: false, reasons: st.reasons };
      }
    }
    const conds = this.A.rules.tableApplicability[tableId] || [];
    const bonds = this.A.rules.rules.find((r) => r.status === 'EXECUTABLE' && r.ast?.type === 'tableIffMembers' && r.ast.tables.includes(tableId));
    if (!conds.length && !bonds) return { applicable: true, reasons: [], conditional: false };
    const env = this.env(filing, scope);
    const met = [];
    const unmet = [];
    for (const c of conds) {
      const v = evalPred(c.when, env);
      if (v === true) met.push(`${c.rule}: condition met`);
      // a condition on a total that the taxonomy calculates from this table's own line items (e.g. trade receivables
      // = gross − allowance of the receivables table) cannot close the table while it holds values: clearing a value
      // in the table would otherwise switch the table off and it could never be entered again
      else if (this.circular(tableId, c.when) && this.tableHasOwnData(filing, t, scope)) met.push(`${c.rule}: condition depends on this table's own values, which are entered`);
      else unmet.push(`${c.rule}: ${v === null ? 'condition not determinable (fact not entered)' : 'condition false'}`);
    }
    if (bonds) {
      const has = this.membersHaveData(filing, scope, bonds.ast.otherTables, bonds.ast.axis, bonds.ast.members);
      (has ? met : unmet).push(`${bonds.id}: ${has ? 'Bonds/Debentures borrowings reported' : 'no BondsMember/DebenturesMember borrowings reported'}`);
    }
    if (met.length) return { applicable: true, mandatory: true, conditional: true, reasons: met };
    return { applicable: false, conditional: true, reasons: unmet };
  }

  // the condition reads a total that is a calculation parent of one of the table's line items
  circular(tableId, when) {
    const m = (this._circ ||= new Map());
    const k = tableId + JSON.stringify(when);
    if (m.has(k)) return m.get(k);
    const facts = new Set();
    const walk = (x) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) { x.forEach(walk); return; } if (typeof x.fact === 'string') facts.add(x.fact); for (const v of Object.values(x)) walk(v); };
    walk(when);
    const items = new Set(this.A.table(tableId).lineItems);
    let r = false;
    for (const arcs of Object.values(this.A.json.calculation || {})) for (const a of arcs) if (facts.has(a.from) && items.has(a.to)) r = true;
    // or the condition's figure is itself a cell of this table (its total column, e.g. share capital at end of period)
    if (totalColumnAllowed(this.A, tableId) && [...facts].some((q) => items.has(q) && nondimAllowed(this.A, q))) r = true;
    m.set(k, r);
    return r;
  }
  tableHasOwnData(filing, t, scope) {
    const items = new Set(t.lineItems), axes = new Set(t.axes.map((a) => a.axis));
    // values of the table itself: member columns, or the total column of elements that are not a statement row
    const rows = nondimRowConcepts(this.A);
    return filing.all().some((f) => items.has(f.concept) && !f.nil && f.dims.every((d) => axes.has(d.axis)) && reportingYear(filing.meta.periods, f.period) === scope && (f.dims.length > 0 || !rows.has(f.concept)));
  }

  membersHaveData(filing, scope, tableIds, axis, members) {
    const tables = tableIds.map((id) => this.A.table(id));
    const lineItems = new Set(tables.flatMap((t) => t.lineItems));
    return filing.all().some((f) => lineItems.has(f.concept) && filing.scopeOf(f.period) === scope && f.dims.some((d) => d.axis === axis && members.includes(d.member)) && !f.nil);
  }

  // Authoritative controller check: throws when a table may not be opened/edited.
  assertTableOpen(filing, tableId, scope) {
    const st = this.tableStatus(filing, tableId, scope);
    if (!st.applicable) throw new ApplicabilityError(`Table ${tableId} is not applicable for ${scope}`, st.reasons);
    return st;
  }
}
