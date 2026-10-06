// v11 audit regressions: closing-balance rows (compiler arc equivalence), table total columns, derived cells
// (carrying amount, current-year closing balance), statement figures kept, previous-year opening facts, next-year
// import, fill-empty-totals scope, table-scoped column removal, and cell coverage of the MCA-validated instances.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { authority, newSession, importSession, q } from './helpers.mjs';
import { Session } from './session.js';
import { tableSlices, totalColumnAllowed } from './views.js';
import { reportingYear, scopeOf } from './periods.js';
import { factKey } from './model.js';
import { derivations } from './derived.js';
import { fillTotalsPlan, fillTotals } from './totals-fill.js';

const A = authority();
const golden = (n) => readFileSync(new URL(`./golden-${n}_2024-25.xml`, import.meta.url), 'utf8');
const TA = {
  table: '201000:DisclosureOfTangibleAssetsTable',
  classes: q('ClassesOfTangibleAssetsAxis'), sub: q('SubClassesOfTangibleAssetsAxis'), carry: q('CarryingAmountAccumulatedDepreciationAndGrossCarryingAmountAxis'),
};
const col = (cls, carry) => [{ axis: TA.classes, member: q(cls) }, ...(carry ? [{ axis: TA.carry, member: q(carry) }] : [])];

test('compiler keeps both reconciliation arcs: opening (periodStartLabel) and closing (periodEndLabel) — XBRL 2.1 §3.5.3.9.7.4', () => {
  const pres = Object.entries(A.json.presentation).find(([e]) => A.json.roles[e]?.code?.startsWith('201000'))[1];
  const arcs = pres.filter((a) => a.from === q('ReconciliationOfChangesInTangibleAssetsAbstract') && a.to === q('TangibleAssets'));
  assert.deepEqual(arcs.map((a) => a.preferredLabel).sort(), ['periodEndLabel', 'periodStartLabel']);
  const closings = Object.values(A.json.presentation).flat().filter((a) => a.preferredLabel === 'periodEndLabel').length;
  assert.ok(closings >= 31, `closing arcs ${closings}`);
});

test('table views show the closing row of every reconciliation (tangible, intangible, reserves, share capital, shares outstanding)', () => {
  const s = newSession();
  for (const [id, c] of [[TA.table, 'TangibleAssets'], ['201100:DisclosureOfIntangibleAssetsTable', 'IntangibleAssets'], ['200200:StatementOfChangesInReservesTable', 'Reserves'], ['200100:DisclosureOfClassesOfShareCapitalTable', 'ShareCapital'], ['200100:DisclosureOfClassesOfShareCapitalTable', 'NumberOfSharesOutstanding']]) {
    const rows = s.tableView(id).lineItems.filter((l) => l.concept === q(c)).map((l) => l.preferredLabel);
    assert.deepEqual(rows, ['periodStartLabel', 'periodEndLabel'], `${id} ${c}`);
  }
  const cf = s.elrView(A.elrs.find((e) => e.code.startsWith('100400')).uri).rows.filter((r) => r.concept === q('CashAndCashEquivalentsCashFlowStatement')).map((r) => r.preferredLabel);
  assert.deepEqual(cf, ['periodStartLabel', 'periodEndLabel']);
});

test('every fact of the MCA-validated instances has a visible cell (row × column); only CHARVAK balance-sheet totals at the previous-year opening date have none', () => {
  for (const [n, allowed] of [['INFOBAHN', 0], ['CHARVAK', 7]]) {
    const { s } = importSession(golden(n));
    const cells = new Set();
    for (const e of A.elrs) for (const r of s.elrView(e.uri).rows) if (r.kind === 'item') for (const sc of ['CY', 'PY']) { const p = s.periodForCell(r.concept, sc, r.preferredLabel); if (p) cells.add(factKey(r.concept, p, [])); }
    for (const t of A.tables) for (const sc of ['CY', 'PY']) {
      const cols = t.axes.length ? tableSlices(A, s.filing, t.id, sc, reportingYear) : [[]];
      for (const l of s.tableView(t.id).lineItems) { if (l.abstract) continue; const p = s.periodForCell(l.concept, sc, l.preferredLabel); if (p) for (const d of cols) cells.add(factKey(l.concept, p, d)); }
    }
    const miss = s.filing.all().filter((f) => !cells.has(f.key));
    assert.equal(miss.length, allowed, `${n}: ${miss.map((f) => f.concept).join(', ')}`);
    assert.ok(miss.every((f) => scopeOf(s.filing.meta.periods, f.period) === 'PYO' && !f.dims.length));
  }
});

test('total column: allowed where every axis has a default; listed first; written without dimensions; not in typed-axis tables', () => {
  assert.equal(totalColumnAllowed(A, '200100:DisclosureOfClassesOfShareCapitalTable'), true);
  assert.equal(totalColumnAllowed(A, TA.table), true);
  assert.equal(totalColumnAllowed(A, '201600:DisclosureOfRelationshipAndTransactionsBetweenRelatedPartiesTable'), false);
  const { s } = importSession(golden('INFOBAHN'));
  const cols = tableSlices(A, s.filing, '200100:DisclosureOfClassesOfShareCapitalTable', 'CY', reportingYear);
  assert.deepEqual(cols[0], []);
  assert.equal(s.getValue(q('ValueOfSharesAuthorised'), 'CY', [])?.value, '10000000');
});

test('a column of another table is not shown in a table whose axes include its axes (share class column vs shareholders table)', () => {
  const { s } = importSession(golden('INFOBAHN'));
  const cols = tableSlices(A, s.filing, '200100a:DisclosureOfShareholdingMoreThanFivePerCentInCompanyTable', 'CY', reportingYear);
  assert.ok(cols.length > 0);
  assert.ok(cols.every((d) => !d.length || d.some((x) => x.axis === q('NameOfShareholderAxis'))), JSON.stringify(cols));
});

test('removing a table column deletes only that table\'s facts; removing the total column keeps statement figures', () => {
  const s = newSession();
  const LT = [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('LongTermMember') }];
  s.setValue(q('LongTermBorrowings'), 'CY', '100');
  s.setTableValue('200300:ClassificationOfBorrowingsTable', 'CY', LT, q('Borrowings'), '100');
  s.setValue(q('LongTermProvisions'), 'CY', '50');
  s.setTableValue('200600:DisclosureOfBreakupOfProvisionsTable', 'CY', LT, q('ProvisionGratuity'), '50');
  s.removeSlice('200600:DisclosureOfBreakupOfProvisionsTable', 'CY', LT);
  assert.equal(s.getValue(q('ProvisionGratuity'), 'CY', LT), null);
  assert.equal(s.getValue(q('Borrowings'), 'CY', LT)?.value, '100', 'borrowings column of the same member must survive');
  s.setValue(q('TangibleAssets'), 'CY', '900');
  s.setTableValue(TA.table, 'CY', [], q('AdditionsOtherThanThroughBusinessCombinationsTangibleAssets'), '10');
  s.removeSlice(TA.table, 'CY', []);
  assert.equal(s.getValue(q('AdditionsOtherThanThroughBusinessCombinationsTangibleAssets'), 'CY', []), null);
  assert.equal(s.getValue(q('TangibleAssets'), 'CY', [])?.value, '900', 'balance-sheet figure must survive');
});

test('derivations discovered from the taxonomy and the MCA member-difference rules', () => {
  const d = derivations(A);
  for (const [x, ch] of [['TangibleAssets', 'ChangesInTangibleAssets'], ['IntangibleAssets', 'ChangesInIntangibleAssets'], ['Reserves', 'ChangesInReserves'], ['ShareCapital', 'IncreaseDecreaseInShareCapital'], ['NumberOfSharesOutstanding', 'IncreaseDecreaseInNumberOfSharesOutstanding'], ['OtherProvisions', 'ChangesInOtherProvisions']]) assert.equal(d.byClosing.get(q(x)), q(ch), x);
  assert.equal(d.byClosing.has(q('CashAndCashEquivalentsCashFlowStatement')), false, 'cash-flow closing cash is entered, not derived');
  assert.deepEqual([...d.arith.keys()].sort(), [q('CarryingAmountAccumulatedAmortizationAndImpairmentAndGrossCarryingAmountAxis'), TA.carry].sort());
});

test('carrying amount = gross − accumulated for every movement row (depreciation has no gross cell); closing = opening + changes; both locked', () => {
  const s = newSession();
  const id = TA.table;
  // previous-year closings (= current-year openings)
  s.setTableValue(id, 'PY', col('LandMember', 'GrossCarryingAmountMember'), q('TangibleAssets'), '1000');
  s.setTableValue(id, 'PY', col('LandMember', 'AccumulatedDepreciationAndImpairmentMember'), q('TangibleAssets'), '300');
  s.setTableValue(id, 'PY', col('LandMember'), q('TangibleAssets'), '700');
  // current-year movements in the gross and accumulated columns only
  s.setTableValue(id, 'CY', col('LandMember', 'GrossCarryingAmountMember'), q('AdditionsOtherThanThroughBusinessCombinationsTangibleAssets'), '250', { recalc: true });
  s.setTableValue(id, 'CY', col('LandMember', 'AccumulatedDepreciationAndImpairmentMember'), q('DepreciationTangibleAssets'), '80', { recalc: true });
  const v = (c, sc, dims) => s.getValue(q(c), sc, dims, c === 'TangibleAssets' ? 'periodEndLabel' : null)?.value;
  assert.equal(v('DepreciationTangibleAssets', 'CY', col('LandMember')), '-80');
  assert.equal(v('AdditionsOtherThanThroughBusinessCombinationsTangibleAssets', 'CY', col('LandMember')), '250');
  assert.equal(v('ChangesInTangibleAssets', 'CY', col('LandMember')), '170');
  assert.equal(v('TangibleAssets', 'CY', col('LandMember', 'GrossCarryingAmountMember')), '1250');
  assert.equal(v('TangibleAssets', 'CY', col('LandMember', 'AccumulatedDepreciationAndImpairmentMember')), '380');
  assert.equal(v('TangibleAssets', 'CY', col('LandMember')), '870');
  assert.ok(s.calculatedCell(q('TangibleAssets'), 'CY', col('LandMember'), null, 'periodEndLabel'));
  assert.ok(s.calculatedCell(q('DepreciationTangibleAssets'), 'CY', col('LandMember')));
  assert.equal(s.calculatedCell(q('TangibleAssets'), 'CY', col('LandMember', 'GrossCarryingAmountMember'), null, 'periodStartLabel'), null, 'the opening row is the previous-year closing — never locked by the roll-forward');
  // MCA SR-L1364-2 / SR-L1380-1 hold and the Mandatory Line Items ML-14 closing is present
  const r = s.validate();
  for (const id2 of ['SR-L1364-2', 'SR-L1380-1', 'ML-14']) assert.ok(!r.issues.some((i) => i.severity === 'ERROR' && i.code === `rule.${id2}` && i.scope === 'CY'), id2);
});

test('a statement figure that was entered is kept: the note must agree (SR-L1364-2 reports it), never silently overwritten', () => {
  const s = newSession();
  s.setValue(q('TangibleAssets'), 'CY', '999');
  s.setTableValue(TA.table, 'CY', [{ axis: TA.carry, member: q('GrossCarryingAmountMember') }], q('TangibleAssets'), '1000', { preferredLabel: 'periodEndLabel', recalc: true });
  assert.equal(s.getValue(q('TangibleAssets'), 'CY', [])?.value, '999');
  assert.equal(s.calculatedCell(q('TangibleAssets'), 'CY', [], null, 'periodEndLabel'), null);
  s.setValue(q('TangibleAssets'), 'CY', '');
  s.recalculateAll();
  assert.equal(s.getValue(q('TangibleAssets'), 'CY', [])?.value, '1000', 'derived again once the statement cell is empty');
});

test('a manual override of a derived cell is never replaced; recalculateAll previews without changing', () => {
  const s = newSession();
  s.setTableValue(TA.table, 'CY', col('LandMember', 'AccumulatedDepreciationAndImpairmentMember'), q('DepreciationTangibleAssets'), '80', { recalc: true });
  s.setTableValue(TA.table, 'CY', col('LandMember'), q('DepreciationTangibleAssets'), '-75', { override: true });
  s.setTableValue(TA.table, 'CY', col('LandMember', 'AccumulatedDepreciationAndImpairmentMember'), q('DepreciationTangibleAssets'), '90', { recalc: true });
  assert.equal(s.getValue(q('DepreciationTangibleAssets'), 'CY', col('LandMember'))?.value, '-75');
  const f = s.filing.get(q('DepreciationTangibleAssets'), s.filing.period(q('DepreciationTangibleAssets'), 'CY'), col('LandMember'));
  f.origin = 'user'; f.value = '-1'; // a stale value typed before the cell became calculated
  const rev = s.filing.revision;
  const prev = s.recalculateAll({ apply: false });
  assert.equal(prev.changes.length, 1);
  assert.equal(s.getValue(q('DepreciationTangibleAssets'), 'CY', col('LandMember'))?.value, '-1', 'preview leaves the filing unchanged');
  assert.ok(s.filing.revision > rev);
  s.recalculateAll();
  assert.equal(s.getValue(q('DepreciationTangibleAssets'), 'CY', col('LandMember'))?.value, '-90');
});

test('previous-year opening facts: listed and removable; moving the current year resets the current-year-only import mode', () => {
  const { s } = importSession(golden('INFOBAHN'));
  s.filing.meta.yearMode = 'current';
  s.setMeta({ periods: { cy: { start: '2025-04-01', end: '2026-03-31' }, py: { start: '2024-04-01', end: '2025-03-31' } } });
  assert.equal(s.filing.meta.yearMode, 'both');
  const n = s.pyOpeningFacts().length;
  assert.ok(n > 0);
  assert.equal(s.removePyOpeningFacts(), n);
  assert.equal(s.pyOpeningFacts().length, 0);
});

test('a v10 project moved forward from a "Current year only" import opens as an ordinary two-year filing', async () => {
  const { Filing } = await import('./model.js');
  const { s } = importSession(golden('INFOBAHN'));
  const j = JSON.parse(JSON.stringify(s.filing.toJSON()));
  const filed = JSON.parse(JSON.stringify(j.meta.periods));
  j.meta.yearMode = 'current';
  j.meta.periods = { cy: { start: '2025-04-01', end: '2026-03-31' }, py: { start: '2024-04-01', end: '2025-03-31' } };
  assert.equal(Filing.fromJSON(A, j).meta.yearMode, 'both');
  j.meta.periods = filed; // not moved: unchanged
  assert.equal(Filing.fromJSON(A, j).meta.yearMode, 'current');
});

test('next year\'s filing: the filed current year becomes the previous year, periods set, cash flow method kept, GR-12 elements not carried', () => {
  const S = new Session(A);
  const rep = S.importXml(golden('INFOBAHN'), { DOMParserImpl: DOMParser, yearMode: 'next' });
  assert.deepEqual(S.filing.meta.periods, { cy: { start: '2025-04-01', end: '2026-03-31' }, py: { start: '2024-04-01', end: '2025-03-31' } });
  assert.equal(S.filing.meta.firstFinancialYear, false);
  const ref = importSession(golden('INFOBAHN')).s;
  let same = 0;
  for (const f of ref.filing.all()) {
    if (ref.filing.scopeOf(f.period) !== 'CY') continue;
    const g = S.filing.get(f.concept, f.period, f.dims);
    if (g) { assert.equal(g.value, f.value, f.key); same++; }
  }
  assert.equal(same, rep.byYear.previous);
  assert.ok(same > 1300);
  assert.equal(S.filing.all().filter((f) => S.filing.scopeOf(f.period) === 'PYO').length, 0);
  assert.equal(S.filing.value(q('TypeOfCashFlowStatement'), 'CY'), 'Indirect Method');
  assert.equal(S.filing.value(q('CorporateIdentityNumber'), 'CY'), 'U72100MH2000PTC125382');
  assert.ok(rep.notApplicable.some((x) => A.conceptElrs(x.concept).some((u) => A.elr(u).code.startsWith('400200'))), 'auditors\' report not carried as previous year');
  assert.equal(S.validate().issues.filter((i) => i.severity === 'ERROR' && /PY|previous/.test(i.scope || '') && i.code === 'rule.GR-1').length, 0);
});

test('fill empty totals: existing columns and the total column only when the other year reports it; never overwrites', () => {
  const S = new Session(A);
  S.importXml(golden('INFOBAHN'), { DOMParserImpl: DOMParser, yearMode: 'next' });
  const id = '200200:StatementOfChangesInReservesTable';
  S.setValue(q('ReservesAndSurplus'), 'CY', '4000');
  const comp = (m) => [{ axis: q('ComponentsOfReservesAxis'), member: q(m) }];
  for (const m of ['SurplusMember', 'GeneralReserveMember']) S.setTableValue(id, 'CY', comp(m), q('OtherAdditionsToReserves'), m === 'SurplusMember' ? '5' : '2', { recalc: true });
  S.setTableValue(id, 'CY', comp('OtherReservesMember'), q('OtherAppropriations'), '0');
  const plan = fillTotalsPlan(S, id, 'CY');
  const at = (m) => plan.find((p) => p.concept === q('OtherAdditionsToReserves') && JSON.stringify(p.dims) === JSON.stringify(m ? comp(m) : []));
  assert.equal(at('OtherReservesMember')?.value, '200000', 'GR-3 parent member column filled from its child');
  assert.equal(at(null)?.value, '700000', 'total column (reported last year) = first-level members');
  S.setTableValue(id, 'CY', [], q('OtherAdditionsToReserves'), '1');
  fillTotals(S, id, 'CY');
  assert.equal(S.getValue(q('OtherAdditionsToReserves'), 'CY', [])?.value, '100000', 'an entered total is never overwritten (Lakhs: 1 = 100000)');
  // a table whose total column was not reported last year gets no new column
  const prov = '200600:DisclosureOfBreakupOfProvisionsTable';
  assert.ok(fillTotalsPlan(S, prov, 'CY').every((p) => p.dims.length > 0));
});
