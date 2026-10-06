// Suite: business-rule execution, rule by rule.
// For every EXECUTABLE rule of the generic pattern families a positive case (rule PASSes / does not fire)
// and a negative case (rule FAILs) are constructed from the taxonomy and executed in isolation.
// Curated and generic-handler rules are exercised by the named targeted tests listed in TARGETED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority } from './helpers.mjs';
import { Filing } from './model.js';
import { RuleEngine } from './rules.js';
import { dimensionallyValid, nondimAllowed } from './dimensions.js';
import { q as qq } from './helpers.mjs';
const q = qq;

const A = authority();
const engine = new RuleEngine(A);
const PERIODS = { cy: { start: '2016-04-01', end: '2017-03-31' }, py: { start: '2015-04-01', end: '2016-03-31' } };
const today = '2017-06-30';

function contexts(concept) {
  const out = [];
  if (nondimAllowed(A, concept)) out.push([]);
  for (const t of A.tablesForConcept(concept)) {
    let combos = [[]];
    for (const ax of t.axes) {
      const opts = ax.typed ? [{ axis: ax.axis, typed: 'Member1' }] : [...(A.dimensionDefault(ax.axis) ? [null] : []), ...ax.members.filter((m) => m.usable && m.member !== A.dimensionDefault(ax.axis)).slice(0, 6).map((m) => ({ axis: ax.axis, member: m.member }))];
      const next = [];
      for (const c of combos) for (const o of opts) { next.push(o ? [...c, o] : c); if (next.length > 600) break; }
      combos = next;
    }
    for (const c of combos) if (c.length && dimensionallyValid(A, concept, c).valid) out.push(c);
  }
  return out;
}
function sample(q) {
  const f = A.typeFacets(q);
  if (f?.pattern?.startsWith('[A-Z][A-Z][A-Z][A-Z][A-Z]')) return 'ABCDE1234F';
  if (A.concept(q).type === 'in-ca-types:CINNumber') return 'U72200KA2010PTC123456';
  switch (A.dataType(q)) {
    case 'monetary': return '100'; case 'shares': return '10'; case 'perShare': return '1'; case 'percent': return '0.5';
    case 'decimal': case 'pure': return '1'; case 'date': return '2017-01-01'; case 'boolean': return 'true';
    case 'enum': return A.enumerations(q)[0]; case 'textBlock': return '<p>Text</p>'; default: return 'Text';
  }
}
function filing(meta = {}) { return new Filing(A, { cin: 'U72200KA2010PTC123456', periods: PERIODS, ...meta }); }
function put(f, q, value, dims = [], scope = 'CY') { return f.setFact({ concept: q, period: f.period(q, scope), dims, value: String(value), decimals: A.isNumeric(q) ? 'INF' : undefined }); }
function exec(f, rule) { return engine.run(f, { today, only: new Set([rule.id]) }).results.filter((r) => r.ruleId === rule.id); }
const fails = (res, scope = 'CY') => res.filter((r) => (r.status === 'FAIL' || r.status === 'WARN') && (r.scope === scope || r.scope == null));
const passes = (res) => res.filter((r) => r.status === 'PASS');
function applicableMeta(q) {
  for (const reportType of ['Standalone', 'Consolidated']) {
    const f = filing({ reportType });
    if (engine.app.conceptStatus(f, q, 'CY').applicable) return { reportType };
  }
  return null;
}

// family -> builder returning { pos: Filing, neg: Filing } or null when not constructible
const B = {
  mandatory(r) {
    const meta = applicableMeta(r.ast.concept); if (!meta) return null;
    const ctx = contexts(r.ast.concept)[0]; if (!ctx) return null;
    const pos = filing(meta); put(pos, r.ast.concept, sample(r.ast.concept), ctx);
    return { pos, neg: filing(meta) };
  },
  sign(r, bad, good) {
    const ctx = contexts(r.ast.concept)[0]; if (!ctx) return null;
    const meta = applicableMeta(r.ast.concept) || {};
    const pos = filing(meta); put(pos, r.ast.concept, good, ctx);
    const neg = filing(meta); put(neg, r.ast.concept, bad, ctx);
    return { pos, neg };
  },
  ref(r, mk) {
    const ref = r.ast.assert.r.fact;
    const ctx = contexts(r.ast.concept).find((c) => dimensionallyValid(A, ref, c).valid); if (!ctx) return null;
    const [pv, pr, nv, nr] = mk;
    const pos = filing(); put(pos, r.ast.concept, pv, ctx); put(pos, ref, pr, ctx);
    const neg = filing(); put(neg, r.ast.concept, nv, ctx); put(neg, ref, nr, ctx);
    return { pos, neg };
  },
};

function build(r) {
  const impl = r.implementation.split(':')[1];
  const a = r.ast;
  switch (impl) {
    case 'mandatory': return B.mandatory(r);
    case 'gte0': return B.sign(r, '-1', '0');
    case 'gt0': return B.sign(r, '0', '1');
    case 'lte100pct': return B.sign(r, '1.5', '1');
    case 'lte-today': return B.sign(r, '2099-01-01', '2016-01-01');
    case 'format-cin': return B.sign(r, 'X123', 'U72200KA2010PTC123456');
    case 'format-pan': return B.sign(r, 'ABC', 'ABCDE1234F');
    case 'format-country': return B.sign(r, 'ATLANTIS', 'INDIA');
    case 'lte-ref': return B.ref(r, ['5', '10', '10', '5']);
    case 'eq-ref': return B.ref(r, ['10', '10', '10', '5']);
    case 'eq-product': {
      const [x, y] = a.assert.r.mul.map((m) => m.fact);
      const ctx = contexts(a.concept).find((c) => dimensionallyValid(A, x, c).valid && dimensionallyValid(A, y, c).valid); if (!ctx) return null;
      const pos = filing(); put(pos, a.concept, '20', ctx); put(pos, x, '4', ctx); put(pos, y, '5', ctx);
      const neg = filing(); put(neg, a.concept, '21', ctx); put(neg, x, '4', ctx); put(neg, y, '5', ctx);
      return { pos, neg };
    }
    case 'mandatory-consolidated': case 'mandatory-standalone': {
      const reportType = a.when.value;
      const neg = filing({ reportType });
      if (!engine.app.conceptStatus(neg, a.concept, 'CY').applicable) return null;
      const pos = filing({ reportType }); put(pos, a.concept, sample(a.concept), contexts(a.concept)[0]);
      return { pos, neg, alsoQuiet: filing({ reportType: reportType === 'Standalone' ? 'Consolidated' : 'Standalone' }) };
    }
    case 'mandatory-if-yes': case 'mandatory-if-gt0': case 'mandatory-if-ne0': case 'change-date-mandatory': {
      if (a.type === 'eachFactOf') {
        // trigger reported with dimensions; the subject is reported in the same context or without dimensions
        const trig = a.concept, subj = a.assert.e.fact;
        const ctx = contexts(trig).find((c) => c.length) || contexts(trig)[0]; if (!ctx) return null;
        const sctx = dimensionallyValid(A, subj, ctx).valid ? ctx : [];
        const val = impl === 'mandatory-if-yes' ? ['true', 'false'] : ['5', '0'];
        const neg = filing(); put(neg, trig, val[0], ctx);
        const pos = filing(); put(pos, trig, val[0], ctx); put(pos, subj, sample(subj), sctx);
        const quiet = filing(); put(quiet, trig, val[1], ctx);
        return { pos, neg, alsoQuiet: quiet };
      }
      const meta = applicableMeta(a.concept); if (!meta) return null;
      const trig = a.when.l.fact;
      const on = impl === 'mandatory-if-yes' ? 'true' : impl === 'change-date-mandatory' ? null : '5';
      const off = impl === 'mandatory-if-yes' ? 'false' : impl === 'change-date-mandatory' ? null : '0';
      const mk = (val) => {
        if (impl === 'change-date-mandatory') return filing({ ...meta, periods: val ? { cy: { start: '2019-04-01', end: '2020-03-31' }, py: { start: '2018-04-01', end: '2019-03-31' } } : PERIODS });
        const f = filing(meta); put(f, trig, val, []); return f;
      };
      const neg = mk(impl === 'change-date-mandatory' ? true : on);
      if (impl === 'change-date-mandatory') put(neg, trig, neg.meta.periods.cy.start, []);
      const pos = mk(impl === 'change-date-mandatory' ? true : on);
      if (impl === 'change-date-mandatory') put(pos, trig, pos.meta.periods.cy.start, []);
      const ctx = contexts(a.concept)[0]; if (!ctx) return null;
      put(pos, a.concept, sample(a.concept), ctx);
      const quiet = mk(impl === 'change-date-mandatory' ? false : off);
      if (impl === 'change-date-mandatory') put(quiet, trig, PERIODS.cy.start, []);
      return { pos, neg, alsoQuiet: quiet };
    }
    case 'mandatory-iff-entered': case 'amount-number-pair': {
      const [p, q2] = a.concepts;
      const ctx = contexts(p).find((c) => dimensionallyValid(A, q2, c).valid); if (!ctx) return null;
      const pos = filing(); put(pos, p, sample(p), ctx); put(pos, q2, sample(q2), ctx);
      const neg = filing(); put(neg, p, sample(p), ctx);
      const neg2 = filing(); put(neg2, q2, sample(q2), ctx);
      return { pos, neg, neg2 };
    }
    case 'mandatory-if-entered': case 'continuing-default': {
      const trig = a.concept; const subj = a.assert.e.fact;
      const ctx = contexts(trig)[0]; if (!ctx) return null;
      const sctx = dimensionallyValid(A, subj, ctx).valid ? ctx : [];
      const pos = filing(); put(pos, trig, sample(trig), ctx); put(pos, subj, sample(subj), sctx);
      const neg = filing(); put(neg, trig, sample(trig), ctx);
      return { pos, neg };
    }
    // ---- families added with the complete V1.3 workbook
    case 'mandatory-current-year': case 'mandatory-current-year-standalone': return B.mandatory(r);
    case 'lt-today': return B.sign(r, '2099-01-01', '2016-01-01');
    case 'min-age-18': return B.sign(r, '2010-01-01', '1970-01-01');
    case 'gte-date': return B.sign(r, '2014-03-31', '2014-04-01');
    case 'eq-const': { const v = a.assert.r.const; const en = A.enumerations(a.concept); return B.sign(r, en ? en.find((e) => e.toUpperCase() !== v.toUpperCase()) : 'USD', v); }
    case 'ne-filing-cin': case 'ne-filing-pan': case 'ne-filing-pan-auditor': {
      const company = impl === 'ne-filing-cin' ? q('CorporateIdentityNumber') : q('PermanentAccountNumberOfEntity');
      const own = impl === 'ne-filing-cin' ? 'U72200KA2010PTC123456' : 'AAACT1234A';
      const other = impl === 'ne-filing-cin' ? 'U72200KA2010PTC654321' : 'ABCDE1234F';
      const ctx = contexts(a.concept)[0]; if (!ctx) return null;
      const mk = (v) => { const f = filing(); put(f, company, own, []); put(f, a.concept, v, ctx); return f; };
      const out = { pos: mk(other), neg: mk(own) };
      if (impl === 'ne-filing-pan-auditor') {
        const aud = q('PermanentAccountNumberOfAuditorOrAuditorsFirm');
        const n2 = mk('PQRST1234Z'); put(n2, aud, 'PQRST1234Z', [{ axis: A.tablesForConcept(aud)[0].axes[0].axis, typed: 'Auditor1' }]);
        out.neg2 = n2;
      }
      return out;
    }
    case 'unique-across-members': {
      const t = A.table(a.tables[0]);
      if (!t.axes.every((x) => x.typed)) return null;
      const d = (i) => t.axes.map((x) => ({ axis: x.axis, typed: `Member${i}` }));
      const v = sample(a.concept);
      const pos = filing(); put(pos, a.concept, v, d(1)); put(pos, a.concept, v.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), d(2));
      const neg = filing(); put(neg, a.concept, v, d(1)); put(neg, a.concept, v, d(2));
      return { pos, neg };
    }
    case 'gte-ref': {
      const ref = a.assert.r.fact; const nd = a.assert.r.ctx === 'nondim';
      const ctx = contexts(a.concept).find((c) => nd || dimensionallyValid(A, ref, c).valid); if (!ctx) return null;
      const mk = (v, w) => { const f = filing(); put(f, a.concept, v, ctx); put(f, ref, w, nd ? [] : ctx); return f; };
      return { pos: mk('2017-05-02', '2017-05-01'), neg: mk('2017-04-30', '2017-05-01') };
    }
    case 'max-18-months': {
      const st = q('DateOfStartOfReportingPeriod');
      const mk = (v) => { const f = filing(); put(f, st, '2016-04-01', []); put(f, a.concept, v, []); return f; };
      return { pos: mk('2017-09-30'), neg: mk('2017-10-01') };
    }
    case 'py-end-before-cy-start': {
      const st = q('DateOfStartOfReportingPeriod');
      const mk = (v) => { const f = filing(); put(f, st, '2016-04-01', [], 'CY'); put(f, a.concept, v, [], 'PY'); return f; };
      return { pos: mk('2016-03-31'), neg: mk('2016-03-30'), scope: 'PY' };
    }
    case 'mandatory-line-item': {
      const t = A.table(a.tables[0]);
      const ctx = t.axes.map((x) => ({ axis: x.axis, typed: 'Member1' }));
      if (!t.axes.every((x) => x.typed)) return null;
      const other = t.lineItems.find((c) => c !== a.concepts[0] && !A.concept(c).abstract);
      const neg = filing(); put(neg, other, sample(other), ctx);
      const pos = filing(); put(pos, other, sample(other), ctx); put(pos, a.concepts[0], sample(a.concepts[0]), ctx);
      return { pos, neg };
    }
    case 'cin-or-pan-if-india': case 'mandatory-if-india': {
      const country = a.concept;
      const ctx = contexts(country).find((c) => c.length); if (!ctx) return null;
      const subj = a.assert.op === 'or' ? a.assert.args[0].e.fact : a.assert.e.fact;
      const mk = (cv, withSubj) => { const f = filing(); put(f, country, cv, ctx); if (withSubj) put(f, subj, sample(subj), ctx); return f; };
      const out = { pos: mk('INDIA', true), neg: mk('India', false), alsoQuiet: mk('JAPAN', false) };
      if (a.assert.op === 'or') { const p2 = mk('INDIA', false); const other = a.assert.args[1].e.fact; put(p2, other, sample(other), ctx); out.pos2 = p2; }
      return out;
    }
    case 'mandatory-if-entered-and-yes': {
      const trig = a.concept; const cin = a.when.args[1].e.fact; const subj = a.assert.e.fact; const on = String(a.when.args[0].r.const);
      const ctx = contexts(trig).find((c) => c.length); if (!ctx) return null;
      const mk = (v, withSubj) => { const f = filing(); put(f, trig, v, ctx); put(f, cin, 'U72200KA2010PTC654321', ctx); if (withSubj) put(f, subj, sample(subj), ctx); return f; };
      return { pos: mk(on, true), neg: mk(on, false), alsoQuiet: mk(on === 'true' ? 'false' : 'true', false) };
    }
    case 'mandatory-conditional': {
      const tv = triggerValues(a.when, a.type === 'eachFactOf' ? a.concept : null);
      if (!tv) return null;
      if (a.type === 'eachFactOf') {
        const subj = a.assert.e.fact;
        const ctx = contexts(tv.concept).find((c) => c.length) || contexts(tv.concept)[0]; if (!ctx) return null;
        const sctx = dimensionallyValid(A, subj, ctx).valid ? ctx : [];
        const mk = (v, withSubj) => { const f = filing(); if (v != null) put(f, tv.concept, v, ctx); if (withSubj) put(f, subj, sample(subj), sctx); return f; };
        return { pos: mk(tv.on, true), neg: mk(tv.on, false), alsoQuiet: mk(tv.off, false) };
      }
      const meta = applicableMeta(a.concept); if (!meta) return null;
      const ctx = contexts(a.concept)[0]; if (!ctx) return null;
      const mk = (v, withSubj) => { const f = filing(meta); if (v != null) put(f, tv.concept, v, []); for (const [c, x] of tv.extra || []) put(f, c, x, []); if (withSubj) put(f, a.concept, sample(a.concept), ctx); return f; };
      return { pos: mk(tv.on, true), neg: mk(tv.on, false), alsoQuiet: mk(tv.off, false) };
    }
    default: return undefined; // not a generic pattern family
  }
}

// On/off values of the (single) trigger element of a condition: the condition is true for `on`, false
// (or not determinable) for `off` (null = trigger not entered).
function triggerValues(p, self = null) {
  if (!p) return null;
  if (p.op === 'or') return triggerValues(p.args[0], self);
  const operand = (e) => (e.upper ? e.upper : e);
  if (p.op === 'entered') { const c = p.e.fact || (p.e.self ? self : null); return c ? { concept: c, on: sample(c), off: null } : null; }
  if (p.op !== 'cmp') return null;
  const l = operand(p.l); const c = l.fact || (l.self ? self : null); if (!c) return null;
  const k = p.r.const;
  if (typeof k === 'boolean') return { concept: c, on: String(k), off: String(!k) };
  if (p.r.kind === 'date') { const d = new Date(Date.parse(k + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10); return p.cmp === '>' ? { concept: c, on: d, off: k } : null; }
  if (typeof k === 'number') return p.cmp === '>' || p.cmp === '!=' ? { concept: c, on: '5', off: '0' } : null;
  if (typeof k === 'string') {
    const en = A.enumerations(c) || [];
    const v = en.find((e) => e.toUpperCase() === k), other = en.find((e) => e.toUpperCase() !== k);
    if (!v || !other) return null;
    return p.cmp === '==' ? { concept: c, on: v, off: other } : { concept: c, on: other, off: v };
  }
  return null;
}

// Families exercised by named targeted tests (file#test) — asserted to exist below.
const TARGETED = {
  'mandatory-for-member': 'rules.test.mjs: member: NatureOfSecurity mandatory for SecuredBorrowingsMember',
  'table-if-gt0': 'release-200500.test.mjs + applicability.test.mjs', 'table-if-any': 'rule-families.test.mjs: table rules', 'table-if-ne0': 'rule-families.test.mjs: table rules', 'table-if-yes': 'applicability.test.mjs: Yes/No-driven table',
  'bonds-debentures-iff': 'rules.test.mjs: tables', 'sharecapital-lte-subscribed': 'rule-families.test.mjs: curated sums', 'sharecapital-classes-sum': 'rule-families.test.mjs: curated sums',
  'reserves-first-level': 'rule-families.test.mjs: curated sums', 'borrowings-first-level': 'rules.test.mjs: sums: borrowings', 'typed-members-sum': 'rules.test.mjs: sums: Σ current-investment', 'sum-two-eq': 'rule-families.test.mjs: curated sums',
  'provisions-term-sum': 'rule-families.test.mjs: curated sums', 'loansandadvances-term-sum': 'rule-families.test.mjs: curated sums', 'shareholder-cin-or-pan': 'rule-families.test.mjs: curated sums',
  'shareholders-lte-paidup': 'rule-families.test.mjs: curated sums', 'shareholding-pct-lte-100': 'rule-families.test.mjs: curated sums', 'private-placement-persons': 'rule-families.test.mjs: curated sums', 'public-offering-yes': 'rule-families.test.mjs: curated sums',
  'table-mandatory': 'rule-families.test.mjs: table families of the complete corpus', 'table-conditional': 'rule-families.test.mjs: table families of the complete corpus',
  'table-only-if-yes': 'rule-families.test.mjs: table families of the complete corpus', 'table-one-complete-member': 'rule-families.test.mjs: table families of the complete corpus',
  'line-item-single-member': 'rule-families.test.mjs: table families of the complete corpus', 'cash-flow-method': 'rule-families.test.mjs: cross-element families of the complete corpus',
  'member-difference': 'rule-families.test.mjs: cross-element families of the complete corpus', 'listed-members-sum': 'rule-families.test.mjs: cross-element families of the complete corpus',
  'eq-table-total': 'rule-families.test.mjs: CSR families', 'eq-average-of-members': 'rule-families.test.mjs: CSR families', 'eq-2pct-average': 'rule-families.test.mjs: CSR families',
  'fy1-eq-py-pbt': 'rule-families.test.mjs: CSR families', 'csr-fy1-member': 'rule-families.test.mjs: CSR families', 'gte-latest-of': 'rule-families.test.mjs: cross-element families of the complete corpus',
  'holding-iff-subsidiary': 'rule-families.test.mjs: cross-element families of the complete corpus',
  'mandatory-line-items-list': 'rule-families.test.mjs: mandatory line items', 'mandatory-line-items-all': 'rule-families.test.mjs: mandatory line items', 'mandatory-line-items-all-except': 'rule-families.test.mjs: mandatory line items',
};

test('every executable pattern rule: positive passes, negative fails (rule by rule)', () => {
  const report = { tested: 0, families: {}, notConstructible: [] };
  const perRule = (x) => x.implementation?.startsWith('pattern:') || ['curated:amount-number-pair', 'curated:continuing-default'].includes(x.implementation);
  for (const r of A.rules.rules.filter((x) => x.status === 'EXECUTABLE' && x.ast && perRule(x))) {
    const impl = r.implementation.split(':')[1];
    let c;
    try { c = build(r); } catch (e) { throw new Error(`${r.id} (${impl}) builder: ${e.stack}`); }
    if (c === undefined) { assert.ok(TARGETED[impl], `${r.id} (${impl}) has neither a generic builder nor a targeted test`); continue; }
    if (c === null) { report.notConstructible.push(`${r.id} ${impl}`); continue; }
    const sc = c.scope || 'CY';
    const pos = exec(c.pos, r), neg = exec(c.neg, r);
    assert.equal(fails(pos, sc).length, 0, `${r.id} positive should not fail: ${JSON.stringify(fails(pos, sc))}`);
    assert.ok(passes(pos).length > 0, `${r.id} (${impl}) positive must be evaluated (PASS), got ${JSON.stringify(pos)}`);
    assert.ok(fails(neg, sc).length > 0, `${r.id} (${impl}) negative should fail; got ${JSON.stringify(neg)}`);
    if (c.neg2) assert.ok(fails(exec(c.neg2, r), sc).length > 0, `${r.id} reverse direction should fail`);
    if (c.pos2) assert.equal(fails(exec(c.pos2, r), sc).length, 0, `${r.id} alternative operand satisfies`);
    if (c.alsoQuiet) assert.equal(fails(exec(c.alsoQuiet, r), sc).length, 0, `${r.id} must not fire when its condition is false`);
    report.tested++; report.families[impl] = (report.families[impl] || 0) + 1;
  }
  console.log('# per-rule tests', JSON.stringify(report));
  assert.ok(report.tested > 200);
  assert.deepEqual(report.notConstructible, [], 'every pattern rule is constructible from the taxonomy');
});

test('every executable curated/generic/data rule maps to an existing targeted test', async () => {
  const { readFileSync } = await import('node:fs');
  const sources = Object.fromEntries(['rules.test.mjs', 'applicability.test.mjs', 'rule-families.test.mjs', 'release-200500.test.mjs', 'typed.test.mjs', 'calculation.test.mjs', 'io.test.mjs'].map((f) => [f, readFileSync(f, 'utf8')]));
  for (const r of A.rules.rules.filter((x) => x.status === 'EXECUTABLE' && !x.implementation.startsWith('pattern:'))) {
    assert.ok(r.implementation, r.id);
  }
  for (const [impl, where] of Object.entries(TARGETED)) {
    const [file, name] = where.split(':').map((x) => x.trim());
    const f = file.split(' + ')[0];
    assert.ok(sources[f], `${impl}: ${f} exists`);
    if (name) assert.ok(sources[f].includes(name.split(':')[0]), `${impl}: test "${name}" present in ${f}`);
  }
});

// ---------------------------------------------------------------- targeted families
import { baseSession, withCurrentInvestments } from './fixtures.mjs';
const runRule = (s, id) => engine.run(s.filing, { today, only: new Set([id]) }).results.filter((r) => r.ruleId === id);
const byImpl = (impl) => A.rules.rules.filter((r) => r.implementation === impl);

test('table rules: table-if-any / table-if-ne0 (OR conditions, current and prior)', () => {
  for (const r of [...byImpl('pattern:table-if-any'), ...byImpl('pattern:table-if-ne0')]) {
    const s = baseSession();
    assert.equal(fails(runRule(s, r.id)).length, 0, `${r.id} quiet when amounts are zero`);
    const trig = r.ast.when.op === 'or' ? r.ast.when.args[0].l.fact : r.ast.when.l.fact;
    s.filing.setFact({ concept: trig, period: s.filing.period(trig, 'PY'), value: '7', decimals: '0' });
    const res = runRule(s, r.id);
    assert.ok(res.some((x) => x.status === 'FAIL' && x.scope === 'PY'), `${r.id} fires for PY only`);
    assert.ok(!res.some((x) => x.status === 'FAIL' && x.scope === 'CY'));
  }
});

test('mandatory line items: every ML rule fires on an incomplete row and passes on a complete one', () => {
  let n = 0;
  for (const r of A.rules.rules.filter((x) => x.id.startsWith('ML-') && x.status === 'EXECUTABLE' && x.ast?.type === 'lineItemsMandatory')) {
    const t = A.table(r.ast.tables[0]);
    if (!t.axes.length) continue;
    // a member combination in which at least one mandatory element is valid
    const ctx = contexts(r.ast.concepts[0] || t.lineItems[0]).find((c) => c.length && c.every((d) => t.axes.some((x) => x.axis === d.axis)));
    if (!ctx) continue;
    const reportType = A.conceptElrs(t.lineItems[0]).some((u) => A.elr(u).code.startsWith('2026')) ? 'Consolidated' : 'Standalone';
    const must = r.ast.concepts.filter((c) => dimensionallyValid(A, c, ctx).valid);
    if (must.length < 1) continue;
    // a conditional table is opened by its own MCA condition (e.g. the Yes/No element) first
    const cond = (A.rules.tableApplicability[t.id] || [])[0];
    const tv = cond ? triggerValues(cond.when) : null;
    const open = (f) => { if (tv) put(f, tv.concept, tv.on, []); return f; };
    const neg = open(filing({ reportType }));
    const other = t.lineItems.find((c) => !must.includes(c) && dimensionallyValid(A, c, ctx).valid) || must[0];
    put(neg, other, sample(other), ctx);
    if (other === must[0] && must.length === 1) continue;
    const pos = open(filing({ reportType }));
    for (const c of must) put(pos, c, sample(c), ctx);
    for (const g of r.ast.atLeastOne || []) { const v = g.find((c) => dimensionallyValid(A, c, ctx).valid); if (v) put(pos, v, sample(v), ctx); }
    const tableOpen = engine.app.tableStatus(neg, t.id, 'CY').applicable;
    if (!tableOpen) continue; // conditional tables are covered by the table rules
    assert.ok(fails(exec(neg, r)).length > 0, `${r.id} incomplete row must fail`);
    assert.equal(fails(exec(pos, r)).length, 0, `${r.id} complete row must pass: ${JSON.stringify(fails(exec(pos, r)))}`);
    n++;
  }
  console.log(`# mandatory line items: ${n} tables exercised`);
  assert.ok(n >= 20);
});

test('curated sums and cross-element rules: positive and negative', () => {
  const T = (id) => A.rules.rules.find((r) => r.id === id);
  const one = (impl) => byImpl('curated:' + impl);
  // sum-two-eq: quoted + unquoted = BS current investments
  {
    const r = byImpl('pattern:sum-two-eq').find((x) => /Current/.test(x.text));
    const s = withCurrentInvestments(baseSession());
    assert.equal(fails(runRule(s, r.id)).length, 0);
    s.setValue(q('AggregateAmountOfQuotedCurrentInvestments'), 'CY', '5');
    assert.equal(fails(runRule(s, r.id)).length, 1);
  }
  // reserves first-level
  {
    const r = one('reserves-first-level')[0];
    const s = baseSession();
    s.setValue(q('ReservesAndSurplus'), 'CY', '100');
    const T2 = '200200:StatementOfChangesInReservesTable';
    s.setTableValue(T2, 'CY', [{ axis: q('ComponentsOfReservesAxis'), member: q('GeneralReserveMember') }], q('Reserves'), '100');
    assert.equal(fails(runRule(s, r.id)).length, 0, 'lower-level member used when first level absent');
    s.setTableValue(T2, 'CY', [{ axis: q('ComponentsOfReservesAxis'), member: q('SurplusMember') }], q('Reserves'), '1');
    assert.equal(fails(runRule(s, r.id)).length, 1);
  }
  // provisions / loans by term
  for (const [impl, table, item, lt, st] of [['provisions-term-sum', '200600:DisclosureOfBreakupOfProvisionsTable', 'Provisions', 'LongTermProvisions', 'ShortTermProvisions']]) {
    const r = one(impl)[0];
    const s = baseSession();
    s.setValue(q(lt), 'CY', '10'); s.setValue(q(st), 'CY', '0');
    s.setTableValue(table, 'CY', [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('LongTermMember') }], q(item), '10');
    s.setTableValue(table, 'CY', [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('ShortTermMember') }], q(item), '0');
    assert.equal(fails(runRule(s, r.id)).length, 0);
    s.setValue(q(lt), 'CY', '11');
    assert.equal(fails(runRule(s, r.id)).length, 1);
  }
  {
    const r = one('loansandadvances-term-sum')[0];
    const s = baseSession();
    s.setValue(q('LongTermLoansAndAdvances'), 'CY', '10'); s.setValue(q('ShortTermLoansAndAdvances'), 'CY', '0');
    s.setTableValue('200600c:LoansAndAdvancesTable', 'CY', [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('LongTermMember') }, { axis: q('ClassificationOfLoansAndAdvancesAxis'), member: q('CapitalAdvancesMember') }], q('LoansAndAdvances'), '10');
    assert.equal(fails(runRule(s, r.id)).length, 0);
    s.setValue(q('LongTermLoansAndAdvances'), 'CY', '12');
    assert.equal(fails(runRule(s, r.id)).length, 1);
  }
  // share capital classes sum + ShareCapital <= subscribed
  {
    const s = baseSession();
    s.setValue(q('ShareCapital'), 'CY', '100');
    const SC = '200100:DisclosureOfClassesOfShareCapitalTable';
    const eq1 = [{ axis: q('ClassesOfShareCapitalAxis'), member: q('EquityShares1Member') }];
    const eq = [{ axis: q('ClassesOfShareCapitalAxis'), member: q('EquitySharesMember') }];
    s.setTableValue(SC, 'CY', eq1, q('ValueOfSharesPaidUp'), '100');
    s.setTableValue(SC, 'CY', eq1, q('ShareCapital'), '100');
    s.setTableValue(SC, 'CY', eq, q('ValueOfSharesSubscribed'), '100');
    for (const r of one('sharecapital-classes-sum')) assert.equal(fails(runRule(s, r.id)).length, 0, r.id);
    for (const r of one('sharecapital-lte-subscribed')) assert.equal(fails(runRule(s, r.id)).length, 0, r.id);
    s.setValue(q('ShareCapital'), 'CY', '150');
    for (const r of one('sharecapital-classes-sum')) assert.equal(fails(runRule(s, r.id)).length, 1, r.id);
    for (const r of one('sharecapital-lte-subscribed')) assert.equal(fails(runRule(s, r.id)).length, 1, r.id);
  }
  // shareholders: CIN-or-PAN, Σ held <= paid up, Σ % <= 100
  {
    const s = baseSession();
    s.setValue(q('WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany'), 'CY', 'true');
    const SH = '200100a:DisclosureOfShareholdingMoreThanFivePerCentInCompanyTable';
    const d = (n) => [{ axis: q('ClassesOfShareCapitalAxis'), member: q('EquityShares1Member') }, { axis: q('NameOfShareholderAxis'), member: q(`Shareholder${n}Member`) }];
    s.setTableValue(SH, 'CY', d(1), q('CountryOfIncorporationOrResidenceOfShareholder'), 'INDIA');
    const cinpan = one('shareholder-cin-or-pan')[0];
    assert.equal(fails(runRule(s, cinpan.id)).length, 1, 'Indian shareholder without CIN/PAN');
    s.setTableValue(SH, 'CY', d(1), q('PANOfShareholder'), 'ABCDE1234F');
    assert.equal(fails(runRule(s, cinpan.id)).length, 0);
    s.setTableValue(SH, 'CY', d(1), q('PercentageOfShareholdingInCompany'), '0.6');
    s.setTableValue(SH, 'CY', d(2), q('PercentageOfShareholdingInCompany'), '0.3');
    const pct = one('shareholding-pct-lte-100').find((r) => /equity/.test(r.text));
    assert.equal(fails(runRule(s, pct.id)).length, 0);
    s.setTableValue(SH, 'CY', d(2), q('PercentageOfShareholdingInCompany'), '0.7');
    assert.equal(fails(runRule(s, pct.id)).length, 1);
    // percentages are accurate to their decimals: rounded shares of exactly 100% (MCA-validated CHARVAK:
    // 0.2193 + 0.193 + 0.1832 + 0.0611 + 0.3435 = 1.0001 from 219250 + 192950 + 183222 + 61078 + 343500 = 1,000,000 shares)
    const pctAt = (vals) => {
      const f = s.filing;
      for (const [i, [v, dec]] of vals.entries()) f.setFact({ concept: q('PercentageOfShareholdingInCompany'), period: f.period(q('PercentageOfShareholdingInCompany'), 'CY'), dims: d(i + 1), value: v, decimals: dec });
      for (let i = vals.length + 1; i <= 6; i++) { const k = f.get(q('PercentageOfShareholdingInCompany'), f.period(q('PercentageOfShareholdingInCompany'), 'CY'), d(i)); if (k) f.removeFact(k.key); }
      return fails(runRule(s, pct.id)).length;
    };
    assert.equal(pctAt([['0.2193', '4'], ['0.193', '3'], ['0.1832', '4'], ['0.0611', '4'], ['0.3435', '4']]), 0, 'within rounding of the reported decimals');
    assert.equal(pctAt([['0.2193', '4'], ['0.194', '3'], ['0.1832', '4'], ['0.0611', '4'], ['0.3435', '4']]), 1, '1.0011 exceeds the rounding interval (0.0007)');
    assert.equal(pctAt([['0.6', 'INF'], ['0.4001', 'INF']]), 1, 'exact values: no tolerance');
    const held = one('shareholders-lte-paidup')[0];
    s.setValue(q('ShareCapital'), 'CY', '1000');
    s.setTableValue('200100:DisclosureOfClassesOfShareCapitalTable', 'CY', [{ axis: q('ClassesOfShareCapitalAxis'), member: q('EquityShares1Member') }], q('NumberOfSharesPaidUp'), '1000');
    s.setTableValue(SH, 'CY', d(1), q('NumberOfSharesHeldInCompany'), '600');
    assert.equal(fails(runRule(s, held.id)).length, 0);
    s.setTableValue(SH, 'CY', d(2), q('NumberOfSharesHeldInCompany'), '600');
    assert.equal(fails(runRule(s, held.id)).length, 1);
  }
  // private placement persons and public-offering YES (AND/OR conditions over dimensional triggers)
  {
    const s = baseSession();
    const SC = '200100:DisclosureOfClassesOfShareCapitalTable';
    const eq1 = [{ axis: q('ClassesOfShareCapitalAxis'), member: q('EquityShares1Member') }];
    s.setValue(q('ShareCapital'), 'CY', '1');
    s.setTableValue(SC, 'CY', eq1, q('NumberOfSharesIssuedInOtherPrivatePlacement'), '10');
    const pp = one('private-placement-persons')[0];
    assert.equal(fails(runRule(s, pp.id)).length, 1);
    s.setValue(q('NumberOfPersonsOnPrivatePlacementOfPreferenceShare'), 'CY', '3');
    assert.equal(fails(runRule(s, pp.id)).length, 0, 'either element satisfies the OR');
    const po = one('public-offering-yes')[0];
    s.setTableValue(SC, 'CY', eq1, q('AmountOfPublicIssueDuringPeriod'), '50');
    s.setValue(q('WhetherMoneyRaisedFromPublicOfferingDuringYear'), 'CY', 'false');
    assert.equal(fails(runRule(s, po.id)).length, 1);
    s.setValue(q('WhetherMoneyRaisedFromPublicOfferingDuringYear'), 'CY', 'true');
    assert.equal(fails(runRule(s, po.id)).length, 0);
    void T;
  }
});

// ---------------------------------------------------------------- predicate logic used by all rule families
import { evalPred } from './expr.js';
test('predicate logic: AND / OR / NOT, entered / not entered, = 0, > 0, comparisons, three-valued unknowns', () => {
  const s = baseSession();
  const env = (scope = 'CY') => ({ filing: s.filing, A, scope, dims: [], today, countries: new Set(['INDIA']) });
  const fact = (l) => ({ fact: q(l), ctx: 'nondim' });
  const c = (cmp, l, v) => ({ op: 'cmp', cmp, l: fact(l), r: { const: v } });
  s.setValue(q('OtherIncome'), 'CY', '0');
  s.setValue(q('RevenueFromOperations'), 'CY', '25');
  assert.equal(evalPred(c('==', 'OtherIncome', 0), env()), true, '= 0');
  assert.equal(evalPred(c('>', 'RevenueFromOperations', 0), env()), true, '> 0');
  assert.equal(evalPred(c('>', 'OtherIncome', 0), env()), false);
  assert.equal(evalPred(c('<=', 'RevenueFromOperations', 25), env()), true);
  assert.equal(evalPred(c('!=', 'RevenueFromOperations', 25), env()), false);
  assert.equal(evalPred({ op: 'entered', e: fact('OtherIncome') }, env()), true, 'entered (zero counts as entered)');
  assert.equal(evalPred({ op: 'not', arg: { op: 'entered', e: fact('ExceptionalItemsBeforeTax') } }, env()), true, 'not entered');
  const T = c('==', 'OtherIncome', 0), F = c('>', 'OtherIncome', 0), U = c('>', 'ExceptionalItemsBeforeTax', 0);
  assert.equal(evalPred({ op: 'and', args: [T, T] }, env()), true);
  assert.equal(evalPred({ op: 'and', args: [T, F] }, env()), false);
  assert.equal(evalPred({ op: 'or', args: [F, T] }, env()), true);
  assert.equal(evalPred({ op: 'or', args: [F, F] }, env()), false);
  assert.equal(evalPred({ op: 'and', args: [T, U] }, env()), null, 'unknown operand -> not determinable, never PASS');
  assert.equal(evalPred({ op: 'or', args: [T, U] }, env()), true);
  assert.equal(evalPred({ op: 'reportType', value: 'Standalone' }, env()), true);
  assert.equal(evalPred(c('==', 'OtherIncome', 0), env('PY')), true, 'prior year evaluated on its own fact');
});

test('GR-15 mandatory axes: listed axes present or defaulted; generic rule executes', () => {
  const s = baseSession();
  for (const [l, v] of [['LongTermBorrowings', 300], ['NoncurrentLiabilities', 300], ['EquityAndLiabilities', 300], ['CashAndBankBalances', 300], ['CurrentAssets', 300], ['Assets', 300]]) s.setValue(q(l), 'CY', String(v));
  s.setTableValue('200300:ClassificationOfBorrowingsTable', 'CY', [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('LongTermMember') }, { axis: q('ClassificationOfBorrowingsAxis'), member: q('TermLoansFromBanksMember') }], q('Borrowings'), '300');
  const res = runRule(s, 'GR-15');
  assert.equal(fails(res).length, 0, 'SubclassificationOfBorrowingsAxis absent but defaulted (rule text: "complied by using default member")');
  // every axis GR-15 lists exists in the taxonomy and has a default or must be reported
  for (const axes of Object.values(A.rules.rules.find((r) => r.id === 'GR-15').ast.tables)) for (const al of axes) assert.ok(A.qnameOfLocal(al), al);
});

// ---------------------------------------------------------------- families added with the complete V1.3 workbook
const tableRow = (f, tableId, i, values, scope = 'CY') => {
  const t = A.table(tableId);
  const dims = t.axes.map((x) => (x.typed ? { axis: x.axis, typed: `Member${i}` } : null)).filter(Boolean);
  for (const [c, v] of values) put(f, c, v, dims, scope);
  return dims;
};
const metaFor = (tableId) => applicableMeta(A.table(tableId).lineItems.find((c) => !A.concept(c).abstract)) || {};

test('table families of the complete corpus: table families of the complete corpus', () => {
  // unconditional mandatory tables
  let tm = 0;
  for (const r of byImpl('pattern:table-mandatory')) {
    const id = r.ast.tables[0]; const meta = metaFor(id);
    const neg = filing(meta);
    if (!engine.app.elrStatus(neg, A.table(id).presentationElr, 'CY').applicable) continue;
    assert.ok(fails(exec(neg, r)).length > 0, `${r.id} empty mandatory table fails`);
    const pos = filing(meta);
    const item = A.table(id).lineItems.find((c) => !A.concept(c).abstract && A.table(id).axes.every((x) => x.typed));
    if (!item) continue;
    tableRow(pos, id, 1, [[item, sample(item)]]);
    assert.equal(fails(exec(pos, r)).length, 0, `${r.id} table with a row passes`);
    tm++;
  }
  console.log(`# unconditional mandatory tables exercised: ${tm}/${byImpl('pattern:table-mandatory').length}`);
  assert.ok(tm >= byImpl('pattern:table-mandatory').length - 1, 'at most the consolidated-only table is skipped in a standalone filing');
  // conditional tables: quiet when the condition is false, fails when true and empty, passes with a row
  let n = 0; const skipped = [];
  for (const r of byImpl('pattern:table-conditional')) {
    const id = r.ast.tables[0]; const meta = metaFor(id);
    const when = r.ast.when.op === 'anyFact' ? null : r.ast.when;
    const tv = when ? triggerValues(when) : null;
    if (!tv) { skipped.push(`${r.id}: ${r.ast.when.op}`); continue; }
    const mk = (v) => { const f = filing(meta); if (v != null) put(f, tv.concept, v, []); return f; };
    let item = null, ctx = null;
    for (const c of A.table(id).lineItems.filter((x) => !A.concept(x).abstract)) {
      ctx = contexts(c).find((x) => x.length && x.every((d) => A.table(id).axes.some((ax) => ax.axis === d.axis)));
      if (ctx) { item = c; break; }
    }
    if (!ctx) { skipped.push(`${r.id}: no context`); continue; }
    if (!engine.app.elrStatus(mk(tv.on), A.table(id).presentationElr, 'CY').applicable) { skipped.push(`${r.id}: ELR n/a`); continue; }
    assert.equal(fails(exec(mk(tv.off), r)).length, 0, `${r.id} quiet when condition false`);
    assert.ok(fails(exec(mk(tv.on), r)).length > 0, `${r.id} fails when condition true and table empty`);
    const pos = mk(tv.on); put(pos, item, sample(item), ctx);
    assert.equal(fails(exec(pos, r)).length, 0, `${r.id} passes with a row`);
    // "mandatory only if" restricts the table to the condition; plain "mandatory if" only requires it
    assert.equal(engine.app.tableStatus(mk(tv.off), id, 'CY').applicable, r.ast.gate === false, `${r.id}: availability while condition false (gate=${r.ast.gate})`);
    n++;
  }
  console.log(`# conditional tables exercised: ${n}/${byImpl('pattern:table-conditional').length}; skipped ${JSON.stringify(skipped)}`);
  assert.deepEqual(skipped, [], 'every conditional table rule exercised');
  // subsidiary details only if Yes
  {
    const r = byImpl('pattern:table-only-if-yes')[0];
    const id = r.ast.when.tables[0];
    const yes = q('WhetherCompanyHasSubsidiaryCompanies');
    const f = filing(); put(f, yes, 'false', []); tableRow(f, id, 1, [[q('NameOfSubsidiary'), 'Sub Pvt Ltd']]);
    assert.ok(fails(exec(f, r)).length > 0, 'details with No fail');
    const g = filing(); put(g, yes, 'true', []); tableRow(g, id, 1, [[q('NameOfSubsidiary'), 'Sub Pvt Ltd']]);
    assert.equal(fails(exec(g, r)).length, 0);
  }
  // at least one complete member
  for (const r of byImpl('pattern:table-one-complete-member')) {
    const id = r.ast.tables[0]; const t = A.table(id); const meta = metaFor(id);
    const items = t.lineItems.filter((c) => !A.concept(c).abstract && !(r.ast.except || []).includes(c));
    const neg = filing(meta); tableRow(neg, id, 1, items.slice(1).map((c) => [c, sample(c)]));
    assert.ok(fails(exec(neg, r)).length > 0, `${r.id} incomplete member fails`);
    const pos = filing(meta); tableRow(pos, id, 1, items.slice(1).map((c) => [c, sample(c)])); tableRow(pos, id, 2, items.map((c) => [c, sample(c)]));
    assert.equal(fails(exec(pos, r)).length, 0, `${r.id} one complete member passes`);
  }
  // a line item against one member only
  for (const r of byImpl('pattern:line-item-single-member')) {
    const id = r.ast.tables[0]; const t = A.table(id);
    const item = t.lineItems.find((c) => !A.concept(c).abstract);
    const mems = t.axes[0].members.filter((m) => m.usable && dimensionallyValid(A, item, [{ axis: t.axes[0].axis, member: m.member }]).valid).slice(0, 2);
    const mk = (n) => { const f = filing(metaFor(id)); mems.slice(0, n).forEach((m) => put(f, item, sample(item), [{ axis: t.axes[0].axis, member: m.member }])); return f; };
    assert.equal(fails(exec(mk(1), r)).length, 0);
    assert.ok(fails(exec(mk(2), r)).length > 0, `${r.id} same line item against two members fails`);
  }
});

test('cross-element families of the complete corpus: cross-element families of the complete corpus', () => {
  // cash flow method
  {
    const r = byImpl('pattern:cash-flow-method')[0];
    const indirectOnly = Object.keys(A.json.concepts).find((c) => { const codes = A.conceptElrs(c).map((u) => A.elr(u).code.slice(0, 6)); return codes.length && codes.every((x) => x === '100400') && A.isNumeric(c) && !A.concept(c).abstract; });
    const f = filing(); put(f, q('TypeOfCashFlowStatement'), 'Direct Method', []); put(f, indirectOnly, '5', []);
    assert.ok(fails(exec(f, r)).length > 0, 'indirect-method element in a direct-method filing fails');
    const g = filing(); put(g, q('TypeOfCashFlowStatement'), 'Indirect Method', []); put(g, indirectOnly, '5', []);
    assert.equal(fails(exec(g, r)).length, 0);
  }
  // carrying amount = gross − accumulated
  for (const r of byImpl('pattern:member-difference')) {
    const t = A.tablesForConcept(r.ast.concept).find((x) => x.axes.some((a) => a.axis === r.ast.axis));
    const cls = t.axes.find((a) => a.axis !== r.ast.axis && a.members.length > 1);
    const m1 = cls.members.find((m) => m.depth === 1).member;
    const base = [{ axis: cls.axis, member: m1 }];
    const mk = (carry) => { const f = filing(); put(f, r.ast.concept, carry, base); put(f, r.ast.concept, '100', [...base, { axis: r.ast.axis, member: r.ast.plus[0] }]); put(f, r.ast.concept, '30', [...base, { axis: r.ast.axis, member: r.ast.minus[0] }]); return f; };
    const ok = exec(mk('70'), r);
    assert.ok(passes(ok).length > 0 && fails(ok).length === 0, `${r.id} 100 − 30 = 70 passes`);
    assert.ok(fails(exec(mk('71'), r)).length > 0, `${r.id} mismatch fails`);
  }
  // Σ listed members = balance-sheet total
  for (const r of byImpl('pattern:listed-members-sum')) {
    const spec = r.ast.assert.l.sumAxis; const total = r.ast.assert.r.fact;
    const mk = (v) => { const f = filing(); put(f, total, '30', []); put(f, spec.concept, '10', [{ axis: spec.axis, member: spec.members[0] }]); put(f, spec.concept, v, [{ axis: spec.axis, member: spec.members[1] }]); return f; };
    assert.equal(fails(exec(mk('20'), r)).length, 0, `${r.id} 10 + 20 = 30`);
    assert.ok(fails(exec(mk('21'), r)).length > 0, `${r.id} mismatch fails`);
  }
  // auditor's signing date >= latest signing date of director / secretary / manager
  {
    const r = byImpl('pattern:gte-latest-of')[0];
    const dir = q('DateOfSigningOfFinancialStatementsByDirector'), cs = q('DateOfSigningOfFinancialStatementsByCompanySecretary');
    const mk = (aud) => { const f = filing(); tableRow(f, A.tablesForConcept(dir)[0].id, 1, [[dir, '2017-05-01']]); tableRow(f, A.tablesForConcept(dir)[0].id, 2, [[dir, '2017-05-05']]); put(f, cs, '2017-05-03', []); tableRow(f, A.tablesForConcept(r.ast.concept)[0].id, 1, [[r.ast.concept, aud]]); return f; };
    assert.equal(fails(exec(mk('2017-05-05'), r)).length, 0, 'equal to the latest date');
    assert.ok(fails(exec(mk('2017-05-04'), r)).length > 0, 'before the latest of multiple dates fails');
  }
  // holding company relationship iff the company is a subsidiary
  {
    const r = A.rules.rules.find((x) => x.implementation === 'curated:holding-iff-subsidiary');
    const RP = A.tablesForConcept(r.ast.assert.args[1].concept)[0].id;
    const mk = (sub, nature) => { const f = filing(); put(f, q('WhetherCompanyIsSubsidiaryCompany'), sub, []); tableRow(f, RP, 1, [[r.ast.assert.args[1].concept, nature]]); return f; };
    assert.equal(fails(exec(mk('true', 'Holding company'), r)).length, 0);
    assert.equal(fails(exec(mk('false', 'Associate'), r)).length, 0);
    assert.ok(fails(exec(mk('true', 'Associate'), r)).length > 0, 'subsidiary without a holding-company party fails');
    assert.ok(fails(exec(mk('false', 'Ultimate Holding company'), r)).length > 0, 'and vice-a-versa');
  }
});

test('CSR families: CSR families', () => {
  const NP = A.tablesForConcept(q('NetProfitComputedUnderSection198AndAdjustedAsPerRule21FOfCompaniesCSRPolicyRules2014'))[0];
  const ax = NP.axes[0].axis;
  const fy = (i) => [{ axis: ax, member: q(`FinancialYearMember${i}`) }];
  const npq = q('NetProfitComputedUnderSection198AndAdjustedAsPerRule21FOfCompaniesCSRPolicyRules2014');
  const base = () => { const f = filing(); put(f, q('WhetherProvisionsOfCorporateSocialResponsibilityAreApplicableOnCompany'), 'true', []); for (const [i, v] of [[1, '100'], [2, '200'], [3, '400']]) put(f, npq, v, fy(i)); return f; };
  {
    const r = byImpl('pattern:eq-average-of-members')[0];
    const f = base(); put(f, r.ast.concept, '233.33', []); f.get(r.ast.concept, f.period(r.ast.concept, 'CY'), []).decimals = '2';
    assert.equal(fails(exec(f, r)).length, 0, '(100 + 200 + 400) / 3 = 233.33 at 2 decimals');
    const g = base(); put(g, r.ast.concept, '240', []);
    assert.ok(fails(exec(g, r)).length > 0);
  }
  {
    const r = byImpl('pattern:eq-2pct-average')[0];
    const avg = q('AverageNetProfitForLastThreeFinancialYears');
    const mk = (a, v) => { const f = filing(); put(f, avg, a, []); put(f, r.ast.concept, v, []); return f; };
    assert.equal(fails(exec(mk('1000', '20'), r)).length, 0);
    assert.ok(fails(exec(mk('1000', '25'), r)).length > 0);
    assert.equal(fails(exec(mk('-1000', '0'), r)).length, 0, 'not applicable when the average is not positive');
  }
  {
    const r = byImpl('pattern:eq-table-total')[0];
    const spend = q('AmountSpentOnProjectsOrPrograms'); const T = A.tablesForConcept(spend)[0].id;
    const mk = (v) => { const f = filing(); tableRow(f, T, 1, [[spend, '30']]); tableRow(f, T, 2, [[spend, '20']]); put(f, r.ast.concept, v, []); return f; };
    assert.equal(fails(exec(mk('50'), r)).length, 0);
    assert.ok(fails(exec(mk('45'), r)).length > 0);
  }
  {
    const r = byImpl('pattern:fy1-eq-py-pbt')[0];
    const mk = (v) => { const f = filing(); put(f, q('ProfitBeforeTax'), '500', [], 'PY'); put(f, r.ast.concept, v, fy(1)); put(f, r.ast.concept, '1', fy(2)); return f; };
    assert.equal(fails(exec(mk('500'), r)).length, 0, 'FY member 1 = previous-year profit before tax; other members not compared');
    assert.ok(fails(exec(mk('499'), r)).length > 0);
  }
  {
    const r = A.rules.rules.find((x) => x.implementation === 'curated:csr-fy1-member');
    const f = filing(); put(f, q('WhetherProvisionsOfCorporateSocialResponsibilityAreApplicableOnCompany'), 'true', []); put(f, npq, '1', fy(2));
    assert.ok(fails(exec(f, r)).length > 0, 'year-one member missing');
    put(f, npq, '1', fy(1));
    assert.equal(fails(exec(f, r)).length, 0);
  }
});
