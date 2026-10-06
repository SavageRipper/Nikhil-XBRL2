// UI helper: carry a dimensional table's previous-year columns (and, optionally, values) into the current year.
// No compliance logic of its own — every step goes through the existing session APIs, exactly like a user doing it
// by hand: columns are checked with Session.validateSlice (the "Add row" path), values are entered with
// Session.setTableValue (the normal cell-entry path: applicability, dimensional validity, calculated-cell lock,
// decimals, recalculation). It never overwrites a current-year value.
//
// Skipped on purpose:
//   - opening-balance rows (periodStart): the current-year opening balance IS the previous-year closing fact (GR-7)
//   - closing-balance rows (periodEnd): this year's closing is opening + changes, never last year's closing
//   - statement figures in a table's total column (the same fact as e.g. a balance-sheet row)
//   - calculated cells: they are recalculated from their children
//   - cells that are not applicable or not valid for the member combination (the session refuses them anyway)
import { tableSlices, nondimRowConcepts } from './views.js';
import { reportingYear } from './periods.js';
import { dimKey } from './model.js';
import { dimensionallyValid } from './dimensions.js';

/** what a carry-forward would do (no changes) */
export function carryForwardPlan(S, tableId) {
  const A = S.A;
  const out = { available: false, reason: '', columns: [], newColumns: [], values: 0 };
  const cy = S.tableStatus(tableId, 'CY'), py = S.tableStatus(tableId, 'PY');
  if (!cy.applicable) { out.reason = 'The current-year table is not applicable.'; return out; }
  if (!py.applicable) { out.reason = 'The previous-year table is not applicable.'; return out; }
  const pyCols = tableSlices(A, S.filing, tableId, 'PY', reportingYear);
  if (!pyCols.length) { out.reason = 'The previous-year table has no columns.'; return out; }
  const have = new Set(tableSlices(A, S.filing, tableId, 'CY', reportingYear).map(dimKey));
  out.available = true;
  out.columns = pyCols;
  out.newColumns = pyCols.filter((d) => !have.has(dimKey(d)));
  out.values = valueCandidates(S, tableId, pyCols).length;
  return out;
}

function valueCandidates(S, tableId, cols) {
  const A = S.A;
  const t = A.table(tableId);
  // opening rows carry over by themselves (GR-7); closing rows are this year's balances (opening + changes), never
  // last year's — they are not copied
  const rows = (S.tableView(tableId).lineItems || []).filter((l) => !l.abstract && l.preferredLabel !== 'periodStartLabel' && l.preferredLabel !== 'periodEndLabel');
  const shared = nondimRowConcepts(A);
  const list = [];
  for (const dims of cols) for (const l of rows) {
    const pf = S.getValue(l.concept, 'PY', dims, l.preferredLabel);
    if (!pf || pf.nil) continue;
    if (!dims.length && shared.has(l.concept)) continue; // a statement figure (e.g. on the balance sheet) is not copied from last year
    if (S.getValue(l.concept, 'CY', dims, l.preferredLabel)) continue; // never overwrite
    if (!dimensionallyValid(A, l.concept, dims).valid || !S.conceptStatus(l.concept, 'CY').applicable) continue;
    if (A.isNumeric(l.concept) && S.calculatedCell(l.concept, 'CY', dims, t.presentationElr, l.preferredLabel)) continue;
    list.push({ dims, row: l, fact: pf });
  }
  return list;
}

/**
 * @returns {{ columns: object[][], values: number, skipped: { reason: string, concept: string }[] }}
 *   columns: current-year columns to show (previous-year member combinations not yet in the current year)
 */
export function carryForward(S, tableId, { values = false } = {}) {
  const plan = carryForwardPlan(S, tableId);
  if (!plan.available) throw new Error(plan.reason);
  const columns = plan.newColumns.map((d) => S.validateSlice(tableId, d));
  const res = { columns, values: 0, skipped: [] };
  if (!values) return res;
  for (const c of valueCandidates(S, tableId, plan.columns)) {
    try {
      S.setTableValue(tableId, 'CY', c.dims, c.row.concept, S.displayOf(c.fact), { preferredLabel: c.row.preferredLabel || null, recalc: true, lockCalculated: true });
      res.values++;
    } catch (e) { res.skipped.push({ reason: e.message, concept: c.row.concept }); }
  }
  return res;
}
