// Release regression: [200500] Notes - Current investments, conditional table.
// MCA rule "Table should be mandatory in case 'CurrentInvestments' is greater than zero in Balance sheet"
// (sheet "Specific rules for elements"; id looked up by table, see ciTableRuleId). Evaluated separately per year.
import test from 'node:test';
import assert from 'node:assert/strict';
import { q, authority, importSession } from './helpers.mjs';
import { baseSession, withCurrentInvestments, currentInvestmentRows, CI_TABLE, ciTableRuleId } from './fixtures.mjs';
import { ApplicabilityError } from './session.js';
import { buildElrView } from './views.js';
import { xsdValidatorStatus, validateInstanceXml } from './xsd-validate.mjs';

const A = authority();
const today = '2017-06-30';
const AXIS = q('ClassificationOfCurrentInvestmentsAxis');
const xsd = xsdValidatorStatus();
const YEAR = { CY: '2017', PY: '2016' };

function uiButtonState(s, scope) {
  // the UI renders the table card from the ELR view and enables the year button from tableStatus
  const view = buildElrView(A, A.elrByCode('200500').uri);
  const row = view.rows.find((r) => r.kind === 'table' && r.tableId === CI_TABLE);
  assert.ok(row, 'table card present in [200500]');
  return s.tableStatus(CI_TABLE, scope).applicable ? 'enabled' : 'disabled';
}

for (const scope of ['CY', 'PY']) {
  test(`[200500] NO / ${scope === 'CY' ? 'current' : 'prior'}: CurrentInvestments = 0`, () => {
    const s = baseSession();
    const st = s.tableStatus(CI_TABLE, scope);
    assert.equal(st.applicable, false, 'applicability state');
    assert.ok(st.reasons.join().includes(ciTableRuleId()));
    assert.equal(uiButtonState(s, scope), 'disabled', 'UI table availability');
    assert.throws(() => s.openTable(CI_TABLE, scope), ApplicabilityError, 'authoritative Session.openTable()');
    assert.throws(() => s.setTableValue(CI_TABLE, scope, [{ axis: AXIS, typed: '1' }], q('CurrentInvestments'), '1'), ApplicabilityError, 'row entry refused');
    const { xml, gate } = s.exportXml({ today });
    assert.ok(gate.ok, 'validation result: gate passes');
    assert.ok(!xml.includes('ClassificationOfCurrentInvestmentsAxis'), 'no current-investment dimensional context generated');
    if (xsd.available) assert.equal(validateInstanceXml(xml).status, 'PASS', 'XSD');
  });

  test(`[200500] YES / ${scope === 'CY' ? 'current' : 'prior'}: CurrentInvestments > 0`, () => {
    const s = withCurrentInvestments(baseSession());
    const st = s.tableStatus(CI_TABLE, scope);
    assert.equal(st.applicable, true, 'applicability state');
    assert.equal(st.mandatory, true);
    assert.equal(uiButtonState(s, scope), 'enabled', 'UI table availability');
    const opened = s.openTable(CI_TABLE, scope);
    assert.equal(opened.view.axes[0].axis, AXIS);
    assert.equal(opened.view.axes[0].typed, true);
    // mandatory table without rows -> validation fails for this year
    const g0 = s.validate({ today });
    assert.ok(g0.issues.some((i) => i.ruleId === ciTableRuleId() && i.scope === scope), 'mandatory table reported');
    // row entry
    currentInvestmentRows(s);
    const f = s.getValue(q('CurrentInvestments'), scope, [{ axis: AXIS, typed: '1' }]);
    assert.ok(f, 'row stored');
    assert.deepEqual(f.dims, [{ axis: AXIS, typed: '1' }], 'dimensional context');
    assert.equal(f.period.date, scope === 'CY' ? '2017-03-31' : '2016-03-31');
    const { xml, gate } = s.exportXml({ today });
    assert.ok(gate.ok, gate.issues.filter((i) => i.severity === 'ERROR').map((i) => i.message).join('\n'));
    const ctx = new RegExp(`<xbrli:context id="(I${YEAR[scope]}_[0-9a-f]{8})">\\s*<xbrli:entity>[\\s\\S]*?<xbrli:instant>${f.period.date}</xbrli:instant>[\\s\\S]*?<xbrldi:typedMember dimension="in-gaap:ClassificationOfCurrentInvestmentsAxis"><in-gaap:ClassificationOfCurrentInvestmentsDomain>1</in-gaap:ClassificationOfCurrentInvestmentsDomain></xbrldi:typedMember>`).exec(xml);
    assert.ok(ctx, 'generated XML context');
    assert.match(xml, new RegExp(`<in-gaap:CurrentInvestments contextRef="${ctx[1]}" unitRef="INR" decimals="0">${scope === 'CY' ? 1000 : 800}</in-gaap:CurrentInvestments>`));
    if (xsd.available) assert.equal(validateInstanceXml(xml).status, 'PASS', 'XSD');
    // re-import keeps the table rows
    const back = importSession(xml).s;
    assert.equal(back.getValue(q('CurrentInvestments'), scope, [{ axis: AXIS, typed: '1' }]).value, f.value);
  });
}
