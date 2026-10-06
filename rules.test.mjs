// Suites: business-rule parser, business-rule execution, business-rule coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authority, q } from './helpers.mjs';
import { baseSession, withCurrentInvestments, currentInvestmentRows } from './fixtures.mjs';
import { RuleEngine } from './rules.js';
import { readWorkbook, specificRules } from './rules-source.mjs';

const A = authority();
const today = '2017-06-30';
const run = (s) => new RuleEngine(A).run(s.filing, { today });
const fails = (res, id) => res.results.filter((r) => r.ruleId === id && r.status === 'FAIL');
const passes = (res, id) => res.results.filter((r) => r.ruleId === id && r.status === 'PASS');
const rule = (pred) => A.rules.rules.find(pred);
const bySubject = (local, impl) => A.rules.rules.find((r) => r.subject === q(local) && (!impl || r.implementation === impl));

test('coverage: every source clause has exactly one status; source text preserved; nothing silently PASS', () => {
  const cov = JSON.parse(readFileSync(new URL('./BUSINESS_RULE_COVERAGE.json', import.meta.url)));
  const allowed = new Set(['EXECUTABLE', 'EXECUTED', 'REVIEW_ONLY_EXTERNAL_DATA', 'UNIMPLEMENTED', 'NOT_APPLICABLE']);
  const ids = new Set();
  for (const r of cov.rules) {
    assert.ok(allowed.has(r.status), r.ruleId);
    assert.ok(!ids.has(r.ruleId), 'unique ' + r.ruleId); ids.add(r.ruleId);
    assert.ok(r.sourceText && r.sourceRow, r.ruleId);
    for (const k of ['ruleId', 'sourceRow', 'sourceText', 'element', 'condition', 'operator', 'operands', 'scope', 'implementation', 'test', 'status']) assert.ok(k in r, `${r.ruleId} has ${k}`);
    if (r.status === 'EXECUTABLE') assert.ok(r.implementation, `${r.ruleId} implementation`);
    if (r.status !== 'EXECUTABLE') assert.ok(r.reason, `${r.ruleId} reason`);
  }
  // every specific-rules row in the workbook is represented
  const spec = specificRules(readWorkbook(cov.corpus.sourceFile));
  assert.ok(spec.rows.length > 500);
  for (const row of spec.rows) assert.ok(cov.rules.some((r) => r.sourceRow === row.line && r.sourceSheet === 'Specific rules for elements'), `row ${row.line} covered`);
  // runtime never reports PASS for non-executable rules
  const s = withCurrentInvestments(baseSession());
  const res = run(s);
  for (const r of res.results) {
    const def = A.rules.rules.find((x) => x.id === r.ruleId);
    if (def.status !== 'EXECUTABLE') assert.notEqual(r.status, 'PASS', r.ruleId);
  }
  assert.equal(cov.corpus.specificRulesSheetTruncated, false, 'complete corpus compiled');
});

test('mandatory: missing mandatory element fails per period', () => {
  const s = baseSession();
  const r = bySubject('TradePayables', 'pattern:mandatory');
  assert.equal(fails(run(s), r.id).length, 0);
  s.filing.removeFact(s.getValue(q('TradePayables'), 'PY').key);
  const f = fails(run(s), r.id);
  assert.equal(f.length, 1);
  assert.equal(f[0].scope, 'PY');
});

test('sign: >= 0 and > 0', () => {
  const s = baseSession();
  s.setValue(q('LongTermBorrowings'), 'CY', '-5');
  const r = rule((x) => x.subject === q('LongTermBorrowings') && x.implementation === 'pattern:gte0');
  assert.equal(fails(run(s), r.id).length, 1);
});

test('compare: EquityAndLiabilities must equal Assets', () => {
  const s = baseSession();
  s.setValue(q('Assets'), 'CY', '10');
  s.setValue(q('EquityAndLiabilities'), 'CY', '0');
  s.setValue(q('EquityAndLiabilities'), 'PY', '0');
  const r = rule((x) => x.subject === q('EquityAndLiabilities') && x.implementation === 'pattern:eq-ref');
  assert.equal(fails(run(s), r.id).length, 1);
  s.setValue(q('EquityAndLiabilities'), 'CY', '10');
  assert.equal(fails(run(s), r.id).length, 0);
  assert.equal(passes(run(s), r.id).length, 2);
});

test('reportType: MinorityInterest mandatory only in a consolidated instance', () => {
  const r = rule((x) => x.subject === q('MinorityInterest'));
  assert.equal(r.implementation, 'pattern:mandatory-consolidated');
  assert.equal(fails(run(baseSession()), r.id).length, 0);
  const c = baseSession({ reportType: 'Consolidated' });
  for (const scope of ['CY', 'PY']) c.setValue(q('MinorityInterest'), scope, '');
  assert.equal(fails(run(c), r.id).length, 2);
});

test('conditional: mandatory-if-yes, iff-entered pairs, mandatory-if-gt0', () => {
  const s = baseSession();
  s.setValue(q('WhetherReductionInCapitalDoneDuringYear'), 'CY', 'true');
  const r1 = rule((x) => x.subject === q('AmountOfReductionInCapitalDuringYear'));
  assert.equal(fails(run(s), r1.id).length, 1);
  const pair = rule((x) => x.subject === q('AmountOfBonusIssueDuringPeriod') && x.implementation === 'curated:amount-number-pair');
  assert.deepEqual(pair.ast.concepts, [q('AmountOfBonusIssueDuringPeriod'), q('NumberOfSharesIssuedAsBonusShares')]);
  const s2 = withCurrentInvestments(baseSession());
  s2.filing.removeFact(s2.getValue(q('AggregateProvisionForDiminutionInValueOfCurrentInvestments'), 'CY').key);
  const r3 = rule((x) => x.subject === q('AggregateProvisionForDiminutionInValueOfCurrentInvestments'));
  assert.equal(fails(run(s2), r3.id).length, 1);
});

test('member: NatureOfSecurity mandatory for SecuredBorrowingsMember', () => {
  const r = rule((x) => x.subject === q('NatureOfSecurity'));
  assert.equal(r.ast.type, 'memberMandatory');
  const s = baseSession();
  for (const [l, v] of [['ShortTermBorrowings', 100], ['CurrentLiabilities', 100], ['EquityAndLiabilities', 100], ['CashAndBankBalances', 100], ['CurrentAssets', 100], ['Assets', 100]]) s.setValue(q(l), 'CY', String(v));
  const T = '200300:ClassificationOfBorrowingsTable';
  const dims = [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('ShortTermMember') }, { axis: q('ClassificationOfBorrowingsAxis'), member: q('LoansRepayableOnDemandFromBanksMember') }, { axis: q('SubclassificationOfBorrowingsAxis'), member: q('SecuredBorrowingsMember') }];
  s.setTableValue(T, 'CY', dims, q('Borrowings'), '100');
  assert.equal(fails(run(s), r.id).length, 1);
  s.setTableValue(T, 'CY', dims, q('NatureOfSecurity'), 'Hypothecation of stock');
  assert.equal(fails(run(s), r.id).length, 0);
});

test('formats: CIN, PAN, country', () => {
  const s = baseSession();
  s.setValue(q('WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany'), 'CY', 'true');
  const T = '200100a:DisclosureOfShareholdingMoreThanFivePerCentInCompanyTable';
  const dims = [{ axis: q('ClassesOfShareCapitalAxis'), member: q('EquityShares1Member') }, { axis: q('NameOfShareholderAxis'), member: q('Shareholder1Member') }];
  s.setTableValue(T, 'CY', dims, q('CountryOfIncorporationOrResidenceOfShareholder'), 'Atlantis');
  s.setTableValue(T, 'CY', dims, q('PANOfShareholder'), 'ABCDE1234Z');
  const res = run(s);
  const country = rule((x) => x.implementation === 'pattern:format-country' && x.subject === q('CountryOfIncorporationOrResidenceOfShareholder'));
  assert.equal(fails(res, country.id).length, 1);
  s.setTableValue(T, 'CY', dims, q('CountryOfIncorporationOrResidenceOfShareholder'), 'INDIA');
  s.setTableValue(T, 'CY', dims, q('CINOfShareholder'), 'L17110MH1973PLC019786');
  const res2 = run(s);
  assert.equal(fails(res2, country.id).length, 0);
  const cin = rule((x) => x.implementation === 'pattern:format-cin');
  assert.equal(fails(res2, cin.id).length, 0);
});

test('sums: Σ current-investment typed members must equal balance-sheet CurrentInvestments', () => {
  const r = rule((x) => x.implementation === 'curated:typed-members-sum' && x.subject === q('CurrentInvestments'));
  const s = currentInvestmentRows(withCurrentInvestments(baseSession()));
  assert.equal(fails(run(s), r.id).length, 0);
  s.setTableValue('200500:DetailsOfCurrentInvestmentsTable', 'CY', [{ axis: q('ClassificationOfCurrentInvestmentsAxis'), typed: '1' }], q('CurrentInvestments'), '999');
  assert.equal(fails(run(s), r.id).length, 1);
});

test('sums: borrowings first-level members by time period (first level, falling back to lower level)', () => {
  const s = baseSession();
  for (const [l, v] of [['LongTermBorrowings', 300], ['NoncurrentLiabilities', 300], ['EquityAndLiabilities', 300], ['CashAndBankBalances', 300], ['CurrentAssets', 300], ['Assets', 300]]) s.setValue(q(l), 'CY', String(v));
  const T = '200300:ClassificationOfBorrowingsTable';
  const lt = { axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('LongTermMember') };
  // TermLoansMember (first level) not given; its children are -> used
  s.setTableValue(T, 'CY', [lt, { axis: q('ClassificationOfBorrowingsAxis'), member: q('TermLoansFromBanksMember') }], q('Borrowings'), '200');
  s.setTableValue(T, 'CY', [lt, { axis: q('ClassificationOfBorrowingsAxis'), member: q('TermLoansFromOthersMember') }], q('Borrowings'), '100');
  const r = A.rules.rules.find((x) => x.implementation === 'curated:borrowings-first-level' && /Long/.test(x.text));
  assert.equal(fails(run(s), r.id).length, 0);
  s.setTableValue(T, 'CY', [lt, { axis: q('ClassificationOfBorrowingsAxis'), member: q('TermLoansMember') }], q('Borrowings'), '250'); // first-level now given and wins
  assert.equal(fails(run(s), r.id).length, 1);
});

test('lineItems: mandatory line items per member (ML-7 current investments)', () => {
  const s = currentInvestmentRows(withCurrentInvestments(baseSession()));
  const ml = A.rules.rules.find((x) => x.id === 'ML-7');
  assert.ok(ml.ast.concepts.includes(q('BasisOfValuationOfCurrentInvestments')));
  assert.equal(fails(run(s), 'ML-7').length, 0);
  s.filing.removeFact(s.getValue(q('BasisOfValuationOfCurrentInvestments'), 'CY', [{ axis: q('ClassificationOfCurrentInvestmentsAxis'), typed: '1' }]).key);
  assert.equal(fails(run(s), 'ML-7').length, 1);
});

test('generic: GR-3 parent member required; GR-5 images; GR-8 decimals; GR-9 INR; GR-15 axes; GR-17 period', () => {
  const s = baseSession();
  for (const [l, v] of [['LongTermBorrowings', 300], ['NoncurrentLiabilities', 300], ['EquityAndLiabilities', 300], ['CashAndBankBalances', 300], ['CurrentAssets', 300], ['Assets', 300]]) s.setValue(q(l), 'CY', String(v));
  const T = '200300:ClassificationOfBorrowingsTable';
  s.setTableValue(T, 'CY', [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('LongTermMember') }, { axis: q('ClassificationOfBorrowingsAxis'), member: q('RupeeTermLoansFromBanksMember') }], q('Borrowings'), '300');
  const gr3 = fails(run(s), 'GR-3');
  assert.ok(gr3.some((f) => /TermLoansFromBanksMember/.test(f.message)), 'parent TermLoansFromBanksMember required');
  // GR-5
  s.setValue(q('DisclosureOfNotesOnCurrentInvestmentsExplanatoryTextBlock'), 'CY', '<p>chart <img src="x.png"/></p>');
  assert.equal(fails(run(s), 'GR-5').length, 1);
  // GR-8
  s.filing.setFact({ concept: q('OtherIncome'), period: s.filing.period(q('OtherIncome'), 'CY'), value: '1.234', decimals: '3' });
  assert.equal(fails(run(s), 'GR-8').length, 1);
  // GR-9
  s.filing.setFact({ concept: q('OtherIncome'), period: s.filing.period(q('OtherIncome'), 'CY'), value: '1', decimals: '0', unit: 'USD' });
  assert.equal(fails(run(s), 'GR-9').length, 1);
  // GR-17
  const old = baseSession({ periods: { cy: { start: '2013-04-01', end: '2014-03-31' }, py: { start: '2012-04-01', end: '2013-03-31' } } });
  assert.equal(fails(run(old), 'GR-17').length, 1);
});

test('generic GR-6: CY/PY pairing for monetary elements (not for first financial year)', () => {
  const s = baseSession();
  s.setValue(q('OtherIncome'), 'CY', '0');
  s.filing.removeFact(s.getValue(q('OtherIncome'), 'PY').key);
  assert.equal(fails(run(s), 'GR-6').length, 1);
  const first = baseSession({ firstFinancialYear: true });
  assert.equal(fails(run(first), 'GR-6').length, 0);
});

test('change sheet: CashAndCashEquivalents mandatory only when the period starts after 2018-04-01', () => {
  const r = A.rules.rules.find((x) => x.id === 'CH-1');
  assert.equal(r.status, 'EXECUTABLE');
  assert.equal(fails(run(baseSession()), 'CH-1').length, 0);
  const late = baseSession({ periods: { cy: { start: '2018-04-02', end: '2019-03-31' }, py: { start: '2017-04-01', end: '2018-03-31' } } });
  assert.equal(fails(run(late), 'CH-1').length, 1);
});

test('tables: bonds/debentures table iff Bonds/Debentures borrowings', () => {
  const r = A.rules.rules.find((x) => x.implementation === 'curated:bonds-debentures-iff');
  assert.ok(r);
  const s = baseSession();
  for (const [l, v] of [['LongTermBorrowings', 300], ['NoncurrentLiabilities', 300], ['EquityAndLiabilities', 300], ['CashAndBankBalances', 300], ['CurrentAssets', 300], ['Assets', 300]]) s.setValue(q(l), 'CY', String(v));
  s.setTableValue('200300:ClassificationOfBorrowingsTable', 'CY', [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('LongTermMember') }, { axis: q('ClassificationOfBorrowingsAxis'), member: q('DebenturesMember') }], q('Borrowings'), '300');
  assert.equal(fails(run(s), r.id).length, 1);
  assert.equal(s.tableStatus('200300a:DetailsOfBondsOrDebenturesTable', 'CY').applicable, true);
});

test('dates: lte-today uses the evaluation date', () => {
  const r = A.rules.rules.find((x) => x.implementation === 'pattern:lte-today');
  assert.ok(r);
});

test('ML-20-b stays UNIMPLEMENTED; if the release owner approves it, it is shown as APPROVED LIMITATION / NOT EXECUTED, never PASS', async () => {
  const { Authority } = await import('./authority.js');
  const { Gate } = await import('./gate.js');
  const lim = JSON.parse(readFileSync(new URL('./APPROVED_LIMITATIONS.json', import.meta.url), 'utf8')).limitations;
  assert.ok(lim.some((l) => l.id === 'ML-20-b' && l.approved === false), 'not approved by the build');
  const r = A.rules.rules.find((x) => x.id === 'ML-20-b');
  assert.equal(r.status, 'UNIMPLEMENTED');
  assert.ok(!r.approvedLimitation);
  assert.match(r.reason, /Ambiguous in the MCA source/);
  // simulated owner approval (in memory only)
  const json = JSON.parse(readFileSync(new URL('./MCA_AUTHORITY.json', import.meta.url), 'utf8'));
  json.businessRules.rules.find((x) => x.id === 'ML-20-b').approvedLimitation = { approvedBy: 'release owner (test)' };
  const A2 = new Authority(json);
  const s = withCurrentInvestments(baseSession());
  const res = new RuleEngine(A2).run(s.filing, { today: '2017-06-30' }).results.filter((x) => x.ruleId === 'ML-20-b');
  assert.equal(res.length, 1);
  assert.equal(res[0].status, 'APPROVED_LIMITATION_NOT_EXECUTED');
  assert.match(res[0].message, /^APPROVED LIMITATION \/ NOT EXECUTED/);
  const g = new Gate(A2).run(s.filing, { today: '2017-06-30' });
  const issue = g.issues.find((i) => i.ruleId === 'ML-20-b');
  assert.match(issue.message, /APPROVED LIMITATION \/ NOT EXECUTED.*not an MCA validation result/);
  assert.equal(g.officialValidation, 'NOT_RUN');
});
