// Assurance harness: machine checks that the tool never leaves the user with an error he cannot resolve himself.
// Run on the MCA-validated instances (golden-*.xml) by assurance.test.mjs and by the release gate.
//
//   rekey(xml, order)      start from an empty filing and type every fact of the accepted instance through the screen's
//                          own entry path (Session.setValue / setTableValue with tab, label role, recalculation and the
//                          calculated-cell lock, exactly as app.js does), in a given order → every value equal to the
//                          accepted filing, no validation error
//   mistakes(xml, n, seed) make n mistakes through the screen (clear a cell, change a value, flip a Yes/No, pick another
//                          option) → every error raised points to a cell/table the user can open and edit, and typing the
//                          original value back in the same cell restores the filing exactly (no error left behind)
//   lockedCells(xml)       every read-only (calculated) cell shown holds exactly the value the tool derives for it
import { Session } from './session.js';
import { Filing } from './model.js';
import { tablesForFact, dimensionallyValid } from './dimensions.js';
import { tableSlices } from './views.js';
import { reportingYear } from './periods.js';
import { Gate } from './gate.js';

const TODAY = '2025-09-30';
const errorsOf = (S) => S.validate({ today: TODAY }).issues.filter((i) => i.severity === 'ERROR');

function rowsIndex(S) {
  const m = new Map();
  for (const e of S.A.elrs) for (const r of S.elrView(e.uri).rows) if (r.kind === 'item') (m.get(r.concept) || m.set(r.concept, []).get(r.concept)).push({ uri: e.uri, pl: r.preferredLabel });
  return m;
}
// the screen cells that show a fact
function cellsFor(S, rows, f) {
  const A = S.A, out = [], same = (p) => p && JSON.stringify(p) === JSON.stringify(f.period);
  if (!f.dims.length) for (const r of rows.get(f.concept) || []) for (const sc of ['CY', 'PY']) if (same(S.periodForCell(f.concept, sc, r.pl))) out.push({ kind: 'elr', uri: r.uri, pl: r.pl, scope: sc });
  const tables = f.dims.length ? tablesForFact(A, f) : A.tables.filter((t) => t.lineItems.includes(f.concept));
  for (const t of tables) for (const l of S.tableView(t.id).lineItems) if (l.concept === f.concept) for (const sc of ['CY', 'PY']) if (same(S.periodForCell(f.concept, sc, l.preferredLabel))) out.push({ kind: 'table', tableId: t.id, pl: l.preferredLabel, scope: sc });
  return out;
}
function enter(S, f, c, display) {
  const o = { preferredLabel: c.pl || null, recalc: true };
  if (c.kind === 'elr') return S.setValue(f.concept, c.scope, display, { ...o, tab: c.uri });
  return S.setTableValue(c.tableId, c.scope, f.dims, f.concept, display, { ...o, lockCalculated: true });
}
const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

export function rekey(A, xml, { order = 'rank', seed = 1, DOMParserImpl } = {}) {
  const src = new Session(A); src.importXml(xml, { DOMParserImpl, yearMode: 'both' });
  const G = src.filing, m = G.meta;
  const S = new Session(A);
  S.setMeta({ name: m.name, cin: m.cin, reportType: m.reportType, level: m.level, displayPlaces: m.displayPlaces, firstFinancialYear: m.firstFinancialYear, periods: JSON.parse(JSON.stringify(m.periods)) });
  const rows = rowsIndex(S);
  const facts = G.all().filter((f) => !f.nil);
  const r = rng(seed), key = new Map(facts.map((f, i) => [f, order === 'reverse' ? -i : order === 'random' ? r() : i]));
  const answer = (f) => !f.dims.length && ['boolean', 'enum'].includes(A.dataType(f.concept)); // Yes/No and choices first (the screen disables dependent cells until answered)
  facts.sort((a, b) => (answer(b) - answer(a)) || (order === 'rank' ? (a.dims.length > 0) - (b.dims.length > 0) : key.get(a) - key.get(b)));
  const done = new Set();
  for (let pass = 0; pass < 3; pass++) for (const f of facts) {
    if (done.has(f)) continue;
    for (const c of cellsFor(S, rows, f)) { try { enter(S, f, c, S.displayOf(f)); done.add(f); break; } catch { /* calculated or not yet applicable */ } }
  }
  const differing = facts.filter((f) => S.filing.get(f.concept, f.period, f.dims)?.value !== f.value);
  const extra = S.filing.all().filter((g) => !G.get(g.concept, g.period, g.dims));
  return { facts: facts.length, differing, extra, errors: errorsOf(S) };
}

// can the user reach the place an error points to and act on it?
export function reachable(S, loc) {
  const A = S.A;
  if (!loc) return 'no location';
  if (loc.kind === 'general') return null;
  if (loc.kind === 'tab') return 'only a tab, no cell';
  const sc = loc.scope === 'PYO' ? 'PY' : loc.scope;
  if (loc.kind === 'table') return S.tableStatus(loc.tableId, sc).applicable ? null : 'table cannot be opened';
  if (loc.tableId) {
    if (!S.tableStatus(loc.tableId, sc).applicable) return 'table cannot be opened';
    if (!S.tableView(loc.tableId).lineItems.some((l) => l.concept === loc.conceptQName)) return 'row not in the table';
    try { S.validateSlice(loc.tableId, loc.dims || []); } catch (e) { return 'column cannot be added: ' + e.message; }
    if (!dimensionallyValid(A, loc.conceptQName, loc.dims || []).valid) return 'cell not valid for the column';
    if (!S.conceptStatus(loc.conceptQName, sc).applicable) return 'cell not applicable';
    return null;
  }
  if (!loc.elrUri || !S.elrView(loc.elrUri).rows.some((r) => r.concept === loc.conceptQName)) return 'row not on the tab';
  return S.cellStatus(loc.elrUri, loc.conceptQName, sc).applicable ? null : 'cell disabled';
}

export function mistakes(A, xml, { n = 100, seed = 7, DOMParserImpl } = {}) {
  const base = new Session(A); base.importXml(xml, { DOMParserImpl, yearMode: 'both' });
  const json = JSON.stringify(base.filing.toJSON());
  const fresh = () => new Session(A, Filing.fromJSON(A, JSON.parse(json)));
  const S0 = fresh(), rows = rowsIndex(S0), r = rng(seed);
  const baseline = errorsOf(S0).map((e) => e.message).sort().join('\n');
  const facts = S0.filing.all().filter((f) => !f.nil && f.origin !== 'calculated' && cellsFor(S0, rows, f).length);
  const out = { made: 0, errorsRaised: 0, unreachable: [], notRestored: [], restoreRefused: [] };
  for (let i = 0; i < n; i++) {
    const S = fresh();
    const f0 = facts[Math.floor(r() * facts.length)];
    const f = S.filing.get(f0.concept, f0.period, f0.dims);
    const cells = cellsFor(S, rows, f), c = cells[Math.floor(r() * cells.length)];
    const t = A.dataType(f.concept), orig = S.displayOf(f), k = r();
    let bad;
    if (t === 'boolean') bad = orig === 'true' ? 'false' : 'true';
    else if (t === 'enum') { const en = A.enumerations(f.concept).filter((x) => x !== orig); bad = en.length ? en[Math.floor(r() * en.length)] : ''; }
    else if (k < 0.4) bad = '';
    else if (A.isNumeric(f.concept)) bad = String(Number(String(orig).replace(/,/g, '')) + (k < 0.7 ? 1 : 1000));
    else if (t === 'date') bad = '2025-01-01';
    else bad = 'changed text';
    try { enter(S, f, c, bad); } catch { continue; } // a calculated cell: the screen refuses typing there
    out.made++;
    const what = `${f.concept}${f.dims.length ? ' [dims]' : ''} ${c.scope} → '${bad}'`;
    for (const e of errorsOf(S)) { out.errorsRaised++; const why = reachable(S, e.location); if (why) out.unreachable.push(`${what}: ${e.message.slice(0, 120)} — ${why}`); }
    try { enter(S, f, c, orig); } catch (e) { out.restoreRefused.push(`${what}: ${e.message}`); continue; }
    const now = errorsOf(S).map((e) => e.message).sort().join('\n');
    const changed = S0.filing.all().filter((g) => S.filing.get(g.concept, g.period, g.dims)?.value !== g.value);
    if (now !== baseline || changed.length) out.notRestored.push(`${what}: ${changed.length} value(s) differ, errors ${now === baseline ? 'unchanged' : 'differ'}`);
  }
  return out;
}

export function lockedCells(A, xml, { DOMParserImpl } = {}) {
  const S = new Session(A); S.importXml(xml, { DOMParserImpl, yearMode: 'both' });
  const T = new Session(A, Filing.fromJSON(A, JSON.parse(JSON.stringify(S.filing.toJSON()))));
  T.recalculateAll({ scopes: ['CY', 'PY'], force: false });
  const wrong = [];
  let locked = 0;
  const chk = (q, sc, dims, tab, pl) => {
    if (!A.isNumeric(q) || !S.calculatedCell(q, sc, dims, tab, pl)) return;
    locked++;
    const p = S.periodForCell(q, sc, pl), a = S.filing.get(q, p, dims), b = T.filing.get(q, p, dims);
    if (!a || a.nil) wrong.push(`${q} ${sc}: locked and empty`);
    else if (a.value !== b?.value) wrong.push(`${q} ${sc} [${dims.length}]: shows ${a.value}, derives ${b?.value}`);
  };
  for (const e of A.elrs) for (const r of S.elrView(e.uri).rows) if (r.kind === 'item') for (const sc of ['CY', 'PY']) chk(r.concept, sc, [], e.uri, r.preferredLabel);
  for (const t of A.tables) for (const sc of ['CY', 'PY']) {
    if (!S.tableStatus(t.id, sc).applicable) continue;
    for (const d of t.axes.length ? tableSlices(A, S.filing, t.id, sc, reportingYear) : [[]]) for (const l of S.tableView(t.id).lineItems) if (!l.abstract) chk(l.concept, sc, d, t.presentationElr, l.preferredLabel);
  }
  return { locked, wrong };
}

// every element an executable MCA rule names resolves, for both years, to a cell or table the user can open — so any
// error that rule raises can be clicked through to a place to fix it
export function ruleLocations(A, filings) {
  const g = new Gate(A);
  const missing = [];
  let checked = 0;
  for (const f of filings) for (const r of A.rules.rules) {
    if (r.status !== 'EXECUTABLE') continue;
    for (const c of [r.subject, r.ast?.concept, ...(r.ast?.concepts || [])].filter((x) => typeof x === 'string')) for (const sc of ['CY', 'PY']) {
      checked++;
      const l = g.checked(g.locate(f, { concept: c, scope: sc, ruleId: r.id, code: 'rule.' + r.id }));
      if (!l || l.kind === 'tab') missing.push(`${r.id} ${c} ${sc}`);
    }
  }
  return { checked, missing };
}
