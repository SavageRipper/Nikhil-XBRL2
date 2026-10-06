// UI helper (explicit action): fill EMPTY total cells of a dimensional table from their part columns.
// Same scope as the totals hints (member-hints.js): only on axes the MCA business rules themselves add up (sumAxis),
// only amounts and share counts. A total is the parent member's column (GR-3 parent, e.g. OtherReservesMember over
// GeneralReserveMember) or the table's total column (every axis at its default = no dimensions, totalColumnAllowed).
// Every value goes through Session.setTableValue — the normal cell-entry path (applicability, dimensional validity,
// calculated-cell lock, decimals, recalculation). Never overwrites a value; calculated cells are left to their
// calculation; opening-balance rows (= previous-year closing, GR-7) are not touched.
import * as Dec from './decimal.js';
import { dimKey } from './model.js';
import { dimensionallyValid } from './dimensions.js';
import { tableSlices, totalColumnAllowed } from './views.js';
import { reportingYear } from './periods.js';
import { additiveAxes } from './member-hints.js';
import { toDisplay } from './scaling.js';

const SUMMABLE = new Set(['monetary', 'shares']);

function axisDefault(A, ax) { return A.dimensionDefault(ax.axis) || null; }
function memberOf(A, ax, dims) { return dims.find((d) => d.axis === ax.axis)?.member || axisDefault(A, ax); }
function withMember(A, ax, dims, member) {
  const rest = dims.filter((d) => d.axis !== ax.axis);
  return member && member === axisDefault(A, ax) ? rest : [...rest, { axis: ax.axis, member }];
}
const depthOf = (A, t, dims) => t.axes.reduce((n, ax) => { let d = 0; const ms = new Map((ax.members || []).map((m) => [m.member, m])); for (let p = ms.get(memberOf(A, ax, dims))?.parent; p; p = ms.get(p)?.parent) d++; return n + d; }, 0);

/** what a fill would do: [{ dims, concept, preferredLabel, value }] (no changes) */
export function fillTotalsPlan(S, tableId, scope) {
  const A = S.A, filing = S.filing;
  const t = A.table(tableId);
  const add = additiveAxes(A);
  const axes = t.axes.filter((ax) => !ax.typed && add.has(ax.axis));
  if (!axes.length || !S.tableStatus(tableId, scope).applicable) return [];
  const rows = (S.tableView(tableId).lineItems || []).filter((l) => !l.abstract && l.preferredLabel !== 'periodStartLabel' && SUMMABLE.has(A.dataType(l.concept)));
  // target columns: the columns already in the table (a parent column added for GR-3 included), plus the table's
  // total column when the other year reports it (the previous-year filing's layout; GR-6 pairs those totals). No
  // other column is created: MCA-validated filings do not report every intermediate total, and a created column
  // brings its own mandatory elements (e.g. nature of security for a secured-borrowings column).
  const cols = tableSlices(A, filing, tableId, scope, reportingYear);
  const other = scope === 'CY' ? 'PY' : 'CY';
  const targets = new Map(cols.map((d) => [dimKey(d), d]));
  if (!targets.has('') && totalColumnAllowed(A, tableId) && tableSlices(A, filing, tableId, other, reportingYear).some((d) => !d.length)) targets.set('', []);
  const plan = [];
  const planned = new Map(); // planned values, so a higher total can use a lower total filled in the same run
  const valueAt = (q, per, dims) => { const k = `${q}#${dimKey(dims)}`; if (planned.has(k)) return planned.get(k); const f = filing.get(q, per, dims); return f && !f.nil ? Dec.parse(f.value) : null; };
  const ordered = [...targets.values()].sort((a, b) => depthOf(A, t, b) - depthOf(A, t, a)); // deepest totals first
  for (const pd of ordered) {
    for (const l of rows) {
      const q = l.concept;
      if (!(pd.length ? dimensionallyValid(A, q, pd).valid : true) || !S.conceptStatus(q, scope).applicable) continue;
      if (!pd.length && !dimensionallyValid(A, q, []).valid) continue;
      const per = S.periodForCell(q, scope, l.preferredLabel);
      if (!per || valueAt(q, per, pd) != null) continue;
      if (S.calculatedCell(q, scope, pd, t.presentationElr, l.preferredLabel)) continue;
      // the parts: children of the total's member on one additive axis; every axis that has parts must agree
      const sums = [];
      for (const ax of axes) {
        const m = memberOf(A, ax, pd);
        const kids = (ax.members || []).filter((x) => x.parent === m && x.usable !== false).map((x) => withMember(A, ax, pd, x.member));
        const vals = kids.map((kd) => valueAt(q, per, kd)).filter((v) => v != null);
        if (vals.length) sums.push(Dec.sum(vals));
      }
      if (!sums.length || sums.some((x) => !Dec.eq(x, sums[0]))) continue;
      planned.set(`${q}#${dimKey(pd)}`, sums[0]);
      plan.push({ dims: pd, concept: q, preferredLabel: l.preferredLabel || null, value: Dec.toString(sums[0]) });
    }
  }
  return plan;
}

/** @returns {{ filled: number, columns: number, skipped: {concept: string, reason: string}[] }} */
export function fillTotals(S, tableId, scope) {
  const A = S.A;
  const plan = fillTotalsPlan(S, tableId, scope);
  const res = { filled: 0, columns: new Set(plan.map((p) => dimKey(p.dims))).size, skipped: [] };
  for (const p of plan) {
    const display = A.dataType(p.concept) === 'monetary' ? toDisplay(p.value, S.filing.meta.level) : p.value;
    // filling a part of a reconciliation can make its closing a calculated cell — then it is left to the calculation
    const t = A.table(tableId);
    if (S.calculatedCell(p.concept, scope, p.dims, t.presentationElr, p.preferredLabel)) continue;
    try { S.setTableValue(tableId, scope, p.dims, p.concept, display, { preferredLabel: p.preferredLabel, recalc: true, lockCalculated: true }); res.filled++; }
    catch (e) { res.skipped.push({ concept: p.concept, reason: e.message }); }
  }
  return res;
}
