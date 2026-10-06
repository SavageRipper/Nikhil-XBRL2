// Total/part guidance on dimensional tables (member-hints.js) — display only, tool guidance (not an MCA rule).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { authority } from './helpers.mjs';
import { Session } from './session.js';
import { tableSlices } from './views.js';
import { reportingYear } from './periods.js';
import { additiveAxes, memberInfo, sortSlices, missingParents, totalsHints, allTotalsHints } from './member-hints.js';
import { dimKey } from './model.js';

globalThis.DOMParser ||= DOMParser;
const A = authority();
const load = (g) => { const S = new Session(A); S.importXml(readFileSync(new URL(g, import.meta.url), 'utf8'), { yearMode: 'both' }); return S; };
const GOLDEN = ['golden-INFOBAHN_2024-25.xml', 'golden-CHARVAK_2024-25.xml'];
const BORR = '200300:ClassificationOfBorrowingsTable';

test('additive axes are exactly those the MCA business rules add up (sumAxis); gross/accumulated axes are not', () => {
  const ax = additiveAxes(A);
  for (const q of ['in-gaap:ClassificationOfBorrowingsAxis', 'in-gaap:ClassesOfTangibleAssetsAxis', 'in-gaap:ClassesOfIntangibleAssetsAxis']) assert.ok(ax.has(q), q);
  assert.ok(ax.get('in-gaap:ClassificationOfBorrowingsAxis').includes('SR-L632-1'));
  assert.ok(!ax.has('in-gaap:CarryingAmountAccumulatedDepreciationAndGrossCarryingAmountAxis'), 'carrying = gross − accumulated (SR-L1364), not a sum');
  assert.ok(!ax.has('in-gaap:SubclassificationOfBorrowingsAxis'));
});

test('memberInfo: where a member sits (path to the total, children)', () => {
  const t = A.table('201000:DisclosureOfTangibleAssetsTable');
  const ax = t.axes.find((a) => a.axis === 'in-gaap:ClassesOfTangibleAssetsAxis');
  const air = memberInfo(A, ax, 'in-gaap:AircraftsHelicoptersMember');
  assert.deepEqual(air.path, ['in-gaap:VehiclesMember', 'in-gaap:CompanyTotalTangibleAssetsMember']);
  assert.equal(air.isTotal, false);
  const veh = memberInfo(A, ax, 'in-gaap:VehiclesMember');
  assert.ok(veh.isTotal && veh.children.includes('in-gaap:AircraftsHelicoptersMember'));
  assert.ok(memberInfo(A, ax, 'in-gaap:CompanyTotalTangibleAssetsMember').isDefault);
});

test('MCA-validated filings: zero totals hints and zero missing parent columns, with hundreds of totals actually compared', () => {
  for (const g of GOLDEN) {
    const S = load(g);
    assert.deepEqual(allTotalsHints(S), [], `${g}: totals hints`);
    let compared = 0;
    for (const t of A.tables) for (const sc of ['CY', 'PY']) {
      if (!S.tableStatus(t.id, sc).applicable) continue;
      const sl = tableSlices(A, S.filing, t.id, sc, reportingYear);
      assert.deepEqual(missingParents(A, t.id, sl), [], `${g} ${t.id} ${sc}: missing parents`);
      compared += totalsHints(S, t.id, sc, sl, { includeMatches: true }).length;
    }
    assert.ok(compared > 100, `${g}: ${compared} total cells compared`);
  }
});

test('a total that differs from its parts is hinted (rounded like Calculations 1.1); hints change nothing in the filing or the gate', () => {
  const S = load('golden-INFOBAHN_2024-25.xml');
  const before = JSON.stringify(S.filing.toJSON());
  const gate0 = S.validate();
  const sl = tableSlices(A, S.filing, BORR, 'CY', reportingYear);
  const P = sl.find((d) => d.some((x) => x.member === 'in-gaap:TermLoansMember') && d.some((x) => x.member === 'in-gaap:LongTermMember'));
  const f = S.filing.get('in-gaap:Borrowings', S.filing.period('in-gaap:Borrowings', 'CY'), P);
  assert.equal(f.value, '68895000');
  assert.deepEqual(totalsHints(S, BORR, 'CY', sl), []);
  f.value = '68900000';
  const h = totalsHints(S, BORR, 'CY', sl);
  assert.equal(h.length, 1);
  assert.equal(h[0].childrenSum, '68895000');
  assert.equal(h[0].difference, '5000');
  assert.deepEqual(h[0].children.map((c) => c.member), ['in-gaap:TermLoansFromBanksMember']);
  assert.ok(h[0].missingChildren.includes('in-gaap:TermLoansFromOthersMember'));
  f.value = '68895400'; // within decimals=-3 of the parts: equal after rounding
  assert.deepEqual(totalsHints(S, BORR, 'CY', sl), []);
  f.value = '68895000';
  assert.equal(JSON.stringify(S.filing.toJSON()), before, 'computing hints does not modify the filing');
  const gate1 = S.validate();
  assert.equal(gate1.ok, gate0.ok);
  assert.equal(gate1.issues.length, gate0.issues.length, 'hints are not gate issues');
});

test('missing parent columns use the GR-3 rule engine decision (same parent the rule reports)', () => {
  const S = load('golden-INFOBAHN_2024-25.xml');
  // remove the "Term loans from banks" columns: their child "Rupee term loans from banks" remains
  for (const f of S.filing.all()) if (f.dims.some((d) => d.member === 'in-gaap:TermLoansFromBanksMember')) S.filing.removeFact(f.key);
  const sl = tableSlices(A, S.filing, BORR, 'CY', reportingYear);
  const mp = missingParents(A, BORR, sl);
  assert.ok(mp.length >= 1);
  assert.ok(mp.every((m) => m.child === 'in-gaap:RupeeTermLoansFromBanksMember' && m.parents[0].member === 'in-gaap:TermLoansFromBanksMember'));
  const gr3 = S.validate().issues.filter((i) => /parent member \{TermLoansFromBanksMember\}/.test(i.message));
  assert.ok(gr3.length >= 1, 'GR-3 reports the same parent');
});

test('taxonomy column order: each total before its parts; typed members keep their order', () => {
  const t = A.table(BORR);
  const L = { axis: 'in-gaap:ClassificationBasedOnTimePeriodAxis', member: 'in-gaap:LongTermMember' };
  const S2 = { axis: 'in-gaap:SubclassificationOfBorrowingsAxis', member: 'in-gaap:SecuredBorrowingsMember' };
  const c = (m) => [L, { axis: 'in-gaap:ClassificationOfBorrowingsAxis', member: m }, S2];
  const entered = [c('in-gaap:RupeeTermLoansFromBanksMember'), c('in-gaap:OtherLoansAndAdvancesMember'), c('in-gaap:TermLoansMember'), c('in-gaap:TermLoansFromBanksMember')];
  const sorted = sortSlices(A, t.id, entered).map((d) => d[1].member.split(':')[1]);
  assert.deepEqual(sorted, ['TermLoansMember', 'TermLoansFromBanksMember', 'RupeeTermLoansFromBanksMember', 'OtherLoansAndAdvancesMember']);
  assert.equal(new Set(sortSlices(A, t.id, entered).map(dimKey)).size, 4);
});
