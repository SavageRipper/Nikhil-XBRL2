// Suite: "Mandatory" marks in the UI (mandatory-marks.js) — display only; must agree with the rule engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, q, newSession } from './helpers.mjs';
import { baseSession, withCurrentInvestments } from './fixtures.mjs';
import { mandatoryCell } from './mandatory-marks.js';

const A = authority();
const today = '2017-06-30';

test('unconditional and report-type mandatory elements are marked per year', () => {
  const s = baseSession();
  const m = mandatoryCell(s, q('OtherIncome'), 'CY');
  assert.equal(m.mandatory, true);
  assert.ok(m.rules.some((id) => A.rules.rules.find((r) => r.id === id).ast.type === 'mandatory'));
  assert.equal(mandatoryCell(s, q('OtherIncome'), 'PY').mandatory, true);
  assert.equal(mandatoryCell(s, q('MinorityInterest'), 'CY').mandatory, false, 'consolidated-only element not mandatory in a standalone filing');
  const c = baseSession({ reportType: 'Consolidated' });
  assert.equal(mandatoryCell(c, q('MinorityInterest'), 'CY').mandatory, true);
  const first = baseSession({ firstFinancialYear: true });
  assert.equal(mandatoryCell(first, q('OtherIncome'), 'PY').mandatory, false, 'no previous year in a first financial year');
});

test('conditional mandatory follows its condition (Yes/No, > 0)', () => {
  const s = baseSession();
  const child = q('NumberOfSubsidiaryCompanies');
  s.setValue(q('WhetherCompanyHasSubsidiaryCompanies'), 'CY', 'false');
  assert.equal(mandatoryCell(s, child, 'CY').mandatory, false);
  s.setValue(q('WhetherCompanyHasSubsidiaryCompanies'), 'CY', 'true');
  const m = mandatoryCell(s, child, 'CY');
  assert.equal(m.mandatory, true);
  assert.equal(m.conditional, true);
});

test('table rows: Mandatory Line Items are marked on each row of the table', () => {
  const s = withCurrentInvestments(baseSession());
  const T = '200500:DetailsOfCurrentInvestmentsTable';
  const dims = [{ axis: q('ClassificationOfCurrentInvestmentsAxis'), typed: '1' }];
  const ml = A.rules.rules.find((r) => r.id.startsWith('ML-') && r.ast?.type === 'lineItemsMandatory' && r.ast.tables.includes(T));
  for (const c of ml.ast.concepts) assert.equal(mandatoryCell(s, c, 'CY', dims, T).mandatory, true, c);
  const optional = A.table(T).lineItems.find((c) => !ml.ast.concepts.includes(c) && !A.concept(c).abstract && !A.rules.rules.some((r) => r.ast?.concept === c));
  if (optional) assert.equal(mandatoryCell(s, optional, 'CY', dims, T).mandatory, false, optional);
});

test('rules contradicted by an MCA-validated instance (WARNING divergences) are not marked', () => {
  const s = newSession({ periods: { cy: { start: '2024-04-01', end: '2025-03-31' }, py: { start: '2023-04-01', end: '2024-03-31' } } });
  assert.equal(mandatoryCell(s, q('NameOfMainProductOrService'), 'CY').mandatory, false);
});

test('consistency with validation: every missing-mandatory error is on a marked cell', () => {
  const s = newSession(); // nothing entered
  const g = s.validate({ today });
  let n = 0;
  for (const i of g.issues) {
    if (i.severity !== 'ERROR' || !i.ruleId || !i.location?.conceptQName || i.location.dims?.length) continue;
    const r = A.rules.rules.find((x) => x.id === i.ruleId);
    if (r?.ast?.type !== 'mandatory') continue;
    assert.equal(mandatoryCell(s, i.location.conceptQName, i.location.scope).mandatory, true, `${i.ruleId} ${i.location.conceptQName} ${i.location.scope}`);
    n++;
  }
  assert.ok(n > 50, `${n} mandatory errors checked`);
  // and nothing in the filing changed
  assert.equal(s.filing.all().length, newSession().filing.all().length);
});
