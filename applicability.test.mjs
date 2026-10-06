// Suites: conditional table applicability ([200500] mandatory regression, CY and PY separately),
// Yes/No-driven tables, report-type and previous-year ELR exclusions, cash flow direct/indirect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { q, authority } from './helpers.mjs';
import { baseSession, withCurrentInvestments, currentInvestmentRows, CI_TABLE, ciTableRuleId } from './fixtures.mjs';
import { ApplicabilityError } from './session.js';
import { generateInstance } from './generator.js';
import { Gate } from './gate.js';

const A = authority();
const today = '2017-06-30';
const ciFacts = (xml) => (xml.match(/<in-gaap:TypeOfCurrentInvestments |ClassificationOfCurrentInvestmentsAxis/g) || []).length;

for (const scope of ['CY', 'PY']) {
  test(`[200500] Current investments — NO (${scope}): disabled, cannot be opened programmatically, no facts generated`, () => {
    const s = baseSession(); // CurrentInvestments = 0 in both years
    const st = s.tableStatus(CI_TABLE, scope);
    assert.equal(st.applicable, false);
    assert.equal(st.conditional, true);
    assert.throws(() => s.openTable(CI_TABLE, scope), ApplicabilityError);
    assert.throws(() => s.setTableValue(CI_TABLE, scope, [{ axis: q('ClassificationOfCurrentInvestmentsAxis'), typed: '1' }], q('CurrentInvestments'), '10'), ApplicabilityError);
    // even facts injected below the controller are excluded by the gate and never emitted
    const p = s.filing.period(q('CurrentInvestments'), scope);
    s.filing.setFact({ concept: q('CurrentInvestments'), period: p, dims: [{ axis: q('ClassificationOfCurrentInvestmentsAxis'), typed: '1' }], value: '10' });
    const gate = new Gate(A).run(s.filing, { today });
    assert.ok(gate.issues.some((i) => i.code === 'excluded'));
    assert.equal(gate.ok, true, gate.issues.filter((i) => i.severity === 'ERROR').map((i) => i.message).join('\n'));
    const { xml } = s.exportXml({ today });
    assert.equal(ciFacts(xml), 0, 'no current-investment table facts in XML');
  });

  test(`[200500] Current investments — YES (${scope}): enabled, opens, rows entered, dimensions correct, XML generated`, () => {
    const s = withCurrentInvestments(baseSession());
    const st = s.tableStatus(CI_TABLE, scope);
    assert.equal(st.applicable, true);
    assert.equal(st.mandatory, true);
    const { view, slices } = s.openTable(CI_TABLE, scope);
    assert.equal(slices.length, 0);
    assert.equal(view.axes.length, 1);
    assert.equal(view.axes[0].typed, true);
    currentInvestmentRows(s);
    // table mandatory rule now satisfied; without rows it fails
    const gate = s.validate({ today });
    assert.equal(gate.ok, true, gate.issues.filter((i) => i.severity === 'ERROR').map((i) => i.message).join('\n'));
    const { xml } = s.exportXml({ today });
    const y = scope === 'CY' ? '2017' : '2016';
    assert.match(xml, new RegExp(`<xbrli:context id="I${y}_[0-9a-f]{8}">[\\s\\S]*?<xbrldi:typedMember dimension="in-gaap:ClassificationOfCurrentInvestmentsAxis"><in-gaap:ClassificationOfCurrentInvestmentsDomain>1</in-gaap:ClassificationOfCurrentInvestmentsDomain></xbrldi:typedMember>`));
    assert.match(xml, new RegExp(`<in-gaap:CurrentInvestments contextRef="I${y}_[0-9a-f]{8}" unitRef="INR" decimals="0">${scope === 'CY' ? 1000 : 800}</in-gaap:CurrentInvestments>`));
  });
}

test('[200500] YES but rows missing → mandatory-table rule fails; CY and PY evaluated separately', () => {
  const s = withCurrentInvestments(baseSession());
  currentInvestmentRows(s, { CY: [['1', 1000]] }); // PY rows missing
  const g = s.validate({ today });
  const t = g.issues.filter((i) => i.ruleId === ciTableRuleId());
  assert.equal(t.length, 1);
  assert.equal(t[0].scope, 'PY');
});

test('[200500] CY yes / PY no: CY opens, PY blocked', () => {
  const s = baseSession();
  for (const [l, v] of [['CurrentInvestments', 50], ['CurrentAssets', 50], ['Assets', 50], ['TradePayables', 50], ['CurrentLiabilities', 50], ['EquityAndLiabilities', 50]]) s.setValue(q(l), 'CY', String(v));
  assert.equal(s.tableStatus(CI_TABLE, 'CY').applicable, true);
  assert.equal(s.tableStatus(CI_TABLE, 'PY').applicable, false);
  assert.throws(() => s.openTable(CI_TABLE, 'PY'), ApplicabilityError);
});

test('Yes/No-driven table: shareholders > 5% table follows WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCent…', () => {
  const T = '200100a:DisclosureOfShareholdingMoreThanFivePerCentInCompanyTable';
  const s = baseSession();
  s.setValue(q('WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany'), 'CY', 'No');
  assert.equal(s.tableStatus(T, 'CY').applicable, false);
  assert.throws(() => s.openTable(T, 'CY'), ApplicabilityError);
  s.setValue(q('WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany'), 'CY', 'Yes');
  assert.equal(s.tableStatus(T, 'CY').applicable, true);
  assert.equal(s.tableStatus(T, 'PY').applicable, false, 'prior year evaluated on its own fact');
  s.openTable(T, 'CY');
});

test('GR-11 / GR-14: consolidated vs standalone ELR exclusions', () => {
  const st = baseSession();
  const cons = baseSession({ reportType: 'Consolidated' });
  const elr = (code) => A.elrByCode(code).uri;
  assert.equal(st.elrStatus(elr('202600'), 'CY').applicable, false); // consolidated note not for standalone
  assert.equal(cons.elrStatus(elr('202600'), 'CY').applicable, true);
  assert.equal(cons.elrStatus(elr('400300'), 'CY').applicable, false); // signatories not for consolidated
  assert.equal(st.elrStatus(elr('400300'), 'CY').applicable, true);
  // GR-13: general information in consolidated only for listed elements
  assert.equal(cons.conceptStatus(q('NameOfCompany'), 'CY').applicable, true);
  assert.equal(cons.conceptStatus(q('DateOfBoardMeetingWhenFinalAccountsWereApproved'), 'CY').applicable, false);
});

test('GR-12: previous-year exclusions with element exceptions', () => {
  const s = baseSession();
  assert.equal(s.conceptStatus(q('DateOfBoardMeetingWhenFinalAccountsWereApproved'), 'PY').applicable, false);
  assert.equal(s.conceptStatus(q('DateOfStartOfReportingPeriod'), 'PY').applicable, true);
  assert.throws(() => s.setValue(q('DateOfBoardMeetingWhenFinalAccountsWereApproved'), 'PY', '2016-05-30'), ApplicabilityError);
});

test('cash flow: TypeOfCashFlowStatement selects the direct or indirect ELR; only applicable facts are generated', () => {
  for (const [type, on, off] of [['Indirect Method', '100400', '100300'], ['Direct Method', '100300', '100400']]) {
    const s = baseSession();
    s.setValue(q('TypeOfCashFlowStatement'), 'CY', type);
    assert.equal(s.elrStatus(A.elrByCode(on).uri, 'CY').applicable, true);
    assert.equal(s.elrStatus(A.elrByCode(off).uri, 'CY').applicable, false);
    // a concept presented only in the other method's ELR is not applicable
    const only = (code) => Object.keys(A.concepts).find((c) => A.isReportable(c) && A.isMonetary(c) && A.conceptElrs(c).length === 1 && A.elr(A.conceptElrs(c)[0]).code === code);
    const otherOnly = only(off);
    assert.ok(otherOnly);
    assert.equal(s.conceptStatus(otherOnly, 'CY').applicable, false);
    s.filing.setFact({ concept: otherOnly, period: s.filing.period(otherOnly, 'CY'), value: '5' });
    const { xml } = s.exportXml({ today });
    assert.ok(!xml.includes(otherOnly + ' '), `${otherOnly} must not be generated under ${type}`);
  }
  // exact fact match, not substring: 'Direct Method' does not enable indirect
  const s = baseSession();
  s.setValue(q('TypeOfCashFlowStatement'), 'CY', 'Direct Method');
  assert.equal(s.app.cashFlowType(s.filing), 'Direct Method');
  void generateInstance;
});
