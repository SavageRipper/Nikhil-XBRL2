// UI helper: which cells are mandatory right now, read from the compiled MCA business rules.
// Pure presentation — it evaluates the same rule ASTs and conditions (expr.js) the rule engine uses, but changes
// nothing in the filing, the rules, validation or generation.
//
//   mandatory             "This is a mandatory field", report-type mandatory, "mandatory if Yes / if > 0 …"
//   eachFactOf / entered  "X is mandatory if <trigger> is entered / selected" (cell of X, same row)
//   iffEntered            "mandatory if … is entered and vice-a-versa"
//   lineItemsMandatory    Mandatory Line Items sheet (each row of the table)
//   memberMandatory       "mandatory in case of <member>"
// Rules reported as WARNING because an MCA-validated instance contradicts them (golden-DIVERGENCES.json) are not marked.
import { evalPred } from './expr.js';
import { dimensionallyValid } from './dimensions.js';
import { dimKey } from './model.js';
import { reportingYear } from './periods.js';

const INDEX = new WeakMap();
function index(A) {
  if (INDEX.has(A)) return INDEX.get(A);
  const by = new Map();
  const add = (q, r) => { if (q) (by.get(q) || by.set(q, []).get(q)).push(r); };
  for (const r of A.rules.rules) {
    if (r.status !== 'EXECUTABLE' || !r.ast || r.severity === 'WARNING') continue;
    const a = r.ast;
    if (a.type === 'mandatory' || a.type === 'memberMandatory') add(a.concept, r);
    else if (a.type === 'eachFactOf' && a.assert?.op === 'entered' && a.assert.e?.fact) add(a.assert.e.fact, r);
    else if (a.type === 'iffEntered') a.concepts.forEach((q) => add(q, r));
    else if (a.type === 'lineItemsMandatory') a.concepts.forEach((q) => add(q, r));
  }
  INDEX.set(A, by);
  return by;
}

// per-filing-revision cache of facts by concept
let cache = { filing: null, rev: -1, byConcept: null };
function factsOf(filing, q) {
  if (cache.filing !== filing || cache.rev !== filing.revision) {
    const m = new Map();
    for (const f of filing.all()) (m.get(f.concept) || m.set(f.concept, []).get(f.concept)).push(f);
    cache = { filing, rev: filing.revision, byConcept: m };
  }
  return cache.byConcept.get(q) || [];
}

/**
 * @returns {{ mandatory: boolean, rules: string[], conditional: boolean }}
 */
export function mandatoryCell(S, concept, scope, dims = [], tableId = null) {
  const A = S.A, filing = S.filing;
  const out = { mandatory: false, rules: [], conditional: false };
  if (scope === 'PY' && filing.meta.firstFinancialYear) return out;
  const key = dimKey(dims);
  const env = (extra = {}) => S.app.env(filing, scope, extra);
  const inScope = (f) => !f.nil && reportingYear(filing.meta.periods, f.period) === scope;
  for (const r of index(A).get(concept) || []) {
    if (r.scope?.periods && !r.scope.periods.includes(scope)) continue;
    const a = r.ast;
    let hit = false, cond = false;
    switch (a.type) {
      case 'mandatory':
        if (dims.length) break; // the non-dimensional element
        if (!a.when) hit = true;
        else { cond = a.when.op !== 'reportType'; hit = evalPred(a.when, env()) === true; }
        break;
      case 'eachFactOf': {
        cond = true;
        for (const f of factsOf(filing, a.concept)) {
          if (!inScope(f)) continue;
          if (a.when && evalPred(a.when, env({ self: f, dims: f.dims })) !== true) continue;
          const target = dimensionallyValid(A, concept, f.dims).valid ? f.dims : [];
          if (dimKey(target) === key) { hit = true; break; }
        }
        break;
      }
      case 'iffEntered': {
        cond = true;
        const other = a.concepts.find((q) => q !== concept);
        hit = factsOf(filing, other).some((f) => inScope(f) && dimKey(f.dims) === key);
        break;
      }
      case 'lineItemsMandatory':
        hit = dims.length > 0 && (!tableId || a.tables.includes(tableId)) && dimensionallyValid(A, concept, dims).valid;
        break;
      case 'memberMandatory':
        cond = true;
        hit = dims.some((d) => d.member === a.member) && dimensionallyValid(A, concept, dims).valid;
        break;
      default: break;
    }
    if (hit) { out.mandatory = true; out.rules.push(r.id); if (cond) out.conditional = true; }
  }
  return out;
}
