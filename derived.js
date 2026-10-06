// Derived cells beyond the calculation linkbase — read from the taxonomy and the compiled MCA rules, no table-specific
// code. Used by the Session to auto-populate (and lock) cells exactly like calculation parents.
//
//   carrying amount   MCA rules SR-L1364-2 / SR-L1380-1 / SR-L1484-2 / SR-L1504-1 (pattern member-difference):
//                     CarryingAmountMember (the axis default = the column without that axis) =
//                     GrossCarryingAmountMember − AccumulatedDepreciation/AmortisationAndImpairmentMember.
//                     Applied to every monetary line item of the tables carrying that axis: both MCA-validated
//                     instances satisfy it for every movement row (480 of 480 complete triples), and where only the
//                     gross column is reported (e.g. additions) carrying = gross (missing side = 0).
//   roll-forward      a reconciliation presents one instant concept twice — opening (periodStartLabel) and closing
//                     (periodEndLabel) — around its net-change total (tangible/intangible assets, reserves, share
//                     capital, shares outstanding, other provisions, defined benefit obligation, plan assets, cash
//                     and cash equivalents of the cash flow statement …): closing(CY) = opening(CY) + change(CY), the
//                     opening being the previous-year closing fact (GR-7). Only for the current year: the previous-year
//                     opening is normally not reported (MCA-validated INFOBAHN instance), so the previous-year closing
//                     is entered/imported. Amounts and share counts only; the Directors' report shareholding tables
//                     (400400, per-person typed rows, percentages) are not derived.
// A derived value never replaces a manual override (origin 'override'), as for calculation parents.
import { dimensionallyValid } from './dimensions.js';

const CACHE = new WeakMap();
const NUMERIC_KINDS = new Set(['monetary', 'shares']);

export function derivations(A) {
  if (CACHE.has(A)) return CACHE.get(A);
  // ---- carrying = gross − accumulated (axes from the compiled member-difference rules)
  const arith = new Map(); // axis -> { axis, target, plus, minus, concepts:Set }
  for (const r of A.rules.rules) {
    const a = r.ast;
    if (r.status !== 'EXECUTABLE' || a?.type !== 'memberArith') continue;
    if (a.target !== A.dimensionDefault(a.axis)) continue; // the target column is the column without the axis
    if (!arith.has(a.axis)) {
      const concepts = new Set();
      for (const t of A.tables) if (t.axes.some((x) => x.axis === a.axis)) for (const q of t.lineItems) if (!A.concept(q)?.abstract && A.dataType(q) === 'monetary') concepts.add(q);
      arith.set(a.axis, { axis: a.axis, target: a.target, plus: a.plus, minus: a.minus, concepts, rules: [] });
    }
    arith.get(a.axis).rules.push(r.id);
  }
  // ---- roll-forwards from the presentation linkbase
  const kind = (q) => A.dataType(q);
  const byClosing = new Map(); // closing concept -> change concept
  const byChange = new Map(); // change concept -> closing concepts
  const seenChange = new Map();
  for (const [elr, arcs] of Object.entries(A.json.presentation)) {
    const code = A.json.roles[elr]?.code?.slice(0, 6);
    if (code === '400400') continue;
    const kids = new Map();
    for (const x of arcs) (kids.get(x.from) || kids.set(x.from, []).get(x.from)).push(x);
    for (const list of kids.values()) list.sort((p, q) => p.order - q.order);
    const lastTotal = (q) => { const t = (kids.get(q) || []).filter((x) => /totalLabel$/.test(x.preferredLabel || '')); return t.length ? t[t.length - 1].to : null; };
    for (const list of kids.values()) {
      for (const s of list) {
        if (!/periodStartLabel$/.test(s.preferredLabel || '')) continue;
        const e = list.find((x) => x.to === s.to && /periodEndLabel$/.test(x.preferredLabel || ''));
        if (!e || A.concept(s.to)?.periodType !== 'instant' || !NUMERIC_KINDS.has(kind(s.to))) continue;
        const cands = [];
        for (const x of list) {
          if (x.order <= s.order || x.order >= e.order) continue;
          const c = A.concept(x.to);
          if (!c) continue;
          if (c.abstract) { const t = lastTotal(x.to); if (t) cands.push(t); }
          else if (c.periodType === 'duration' && kind(x.to) === kind(s.to)) cands.push(x.to);
        }
        const uniq = [...new Set(cands)];
        if (uniq.length !== 1) continue;
        const ch = uniq[0];
        if (A.concept(ch)?.periodType !== 'duration') continue;
        if (byClosing.has(s.to) && byClosing.get(s.to) !== ch) { byClosing.set(s.to, null); continue; } // ambiguous
        byClosing.set(s.to, ch);
        (seenChange.get(ch) || seenChange.set(ch, new Set()).get(ch)).add(s.to);
      }
    }
  }
  for (const [x, ch] of [...byClosing]) if (!ch || seenChange.get(ch).size !== 1) byClosing.delete(x); // one change per balance
  for (const [x, ch] of byClosing) byChange.set(ch, x);
  const out = { arith, byClosing, byChange };
  CACHE.set(A, out);
  return out;
}

// carrying-amount derivation that targets (concept, dims) — the carrying column has no member on the axis
export function carryingRuleFor(A, concept, dims) {
  for (const d of derivations(A).arith.values()) {
    if (!d.concepts.has(concept) || dims.some((x) => x.axis === d.axis)) continue;
    // a side may be excluded for a line item (notAll: e.g. depreciation has no gross-carrying-amount cell) — it is 0
    const plus = d.plus.map((m) => [...dims, { axis: d.axis, member: m }]).filter((x) => dimensionallyValid(A, concept, x).valid);
    const minus = d.minus.map((m) => [...dims, { axis: d.axis, member: m }]).filter((x) => dimensionallyValid(A, concept, x).valid);
    if (!plus.length && !minus.length) continue;
    return { ...d, plusDims: plus, minusDims: minus };
  }
  return null;
}
// the carrying cell(s) a gross / accumulated cell feeds
export function carryingTargetOf(A, concept, dims) {
  for (const d of derivations(A).arith.values()) {
    if (!d.concepts.has(concept)) continue;
    const m = dims.find((x) => x.axis === d.axis);
    if (!m || ![...d.plus, ...d.minus].includes(m.member)) continue;
    return dims.filter((x) => x.axis !== d.axis);
  }
  return null;
}
export const rollForwardChangeOf = (A, concept) => derivations(A).byClosing.get(concept) || null;
export const rollForwardClosingOf = (A, change) => derivations(A).byChange.get(change) || null;
