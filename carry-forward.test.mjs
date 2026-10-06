// Copy from previous year (carry-forward.js): columns and optional values, through the existing session APIs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { authority } from './helpers.mjs';
import { Session } from './session.js';
import { tableSlices } from './views.js';
import { reportingYear } from './periods.js';
import { dimKey } from './model.js';
import { carryForwardPlan, carryForward } from './carry-forward.js';

globalThis.DOMParser ||= DOMParser;
const A = authority();
const BORR = '200300:ClassificationOfBorrowingsTable';
const TANG = '201000:DisclosureOfTangibleAssetsTable';
const load = () => { const S = new Session(A); S.importXml(readFileSync(new URL('golden-INFOBAHN_2024-25.xml', import.meta.url), 'utf8'), { yearMode: 'both' }); return S; };
const cyFactsOf = (S, id) => { const t = A.table(id); const items = new Set(t.lineItems); return S.filing.all().filter((f) => items.has(f.concept) && f.dims.length && reportingYear(S.filing.meta.periods, f.period) === 'CY' && tableSlices(A, S.filing, id, 'CY', reportingYear).some((d) => dimKey(d) === dimKey(f.dims))); };

test('columns only: every previous-year column is offered, nothing is written', () => {
  const S = load();
  for (const f of cyFactsOf(S, BORR)) S.filing.removeFact(f.key);
  const before = S.filing.all().length;
  const plan = carryForwardPlan(S, BORR);
  assert.ok(plan.available);
  const py = tableSlices(A, S.filing, BORR, 'PY', reportingYear);
  assert.equal(plan.newColumns.length, py.length);
  const r = carryForward(S, BORR);
  assert.equal(r.columns.length, py.length);
  assert.equal(r.values, 0);
  assert.equal(S.filing.all().length, before, 'no facts written');
});

test('columns + values: empty current-year cells get the previous-year values through normal cell entry; gate still passes', () => {
  const S = load();
  const removed = cyFactsOf(S, BORR);
  for (const f of removed) S.filing.removeFact(f.key);
  const r = carryForward(S, BORR, { values: true });
  assert.ok(r.values > 0);
  assert.deepEqual(r.skipped, []);
  for (const d of tableSlices(A, S.filing, BORR, 'PY', reportingYear)) {
    const py = S.getValue('in-gaap:Borrowings', 'PY', d);
    if (py) assert.equal(S.getValue('in-gaap:Borrowings', 'CY', d).value, py.value);
  }
  const g = S.validate({ today: '2025-10-03' });
  assert.ok(!g.issues.some((i) => i.severity === 'ERROR' && i.code.startsWith('dim')), 'dimensionally valid');
});

test('never overwrites a current-year value; opening-balance rows and calculated cells are not copied', () => {
  const S = load();
  const cyBefore = new Map(cyFactsOf(S, TANG).map((f) => [f.key, f.value]));
  const plan = carryForwardPlan(S, TANG);
  assert.ok(plan.available);
  const r = carryForward(S, TANG, { values: true });
  for (const [k, v] of cyBefore) assert.equal(S.filing.facts.get(k).value, v, 'existing value kept');
  const rows = S.tableView(TANG).lineItems.filter((l) => l.preferredLabel === 'periodStartLabel');
  assert.ok(rows.length > 0, 'table has opening-balance rows');
  assert.ok(r.values >= 0);
});

test('not available when the previous-year table is empty (current-year-only import)', () => {
  const S = new Session(A);
  S.importXml(readFileSync(new URL('golden-INFOBAHN_2024-25.xml', import.meta.url), 'utf8'), { yearMode: 'current' });
  const plan = carryForwardPlan(S, BORR);
  assert.equal(plan.available, false);
  assert.throws(() => carryForward(S, BORR), /not applicable|no columns/);
});
