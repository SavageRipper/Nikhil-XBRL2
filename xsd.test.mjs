// Suite: genuine XML Schema + XBRL 2.1 + XBRL Dimensions validation of generated instances (Arelle, offline).
// Independent of the internal gate; skipped (with an explicit reason) only when Arelle is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { q, importSession, authority } from './helpers.mjs';
import { validCurrentInvestmentsSession, baseSession, enableRelatedParties } from './fixtures.mjs';
import { xsdValidatorStatus, validateInstanceXml } from './xsd-validate.mjs';
import { Session } from './session.js';
import { buildExample } from './example.js';
import { generateInstance } from './generator.js';

const st = xsdValidatorStatus();
const today = '2025-09-30';
const run = (name, xml) => {
  const r = validateInstanceXml(xml, { label: name });
  assert.equal(r.status, 'PASS', r.errors.slice(0, 10).map((e) => `[${e.code}] ${e.message}`).join('\n'));
  return r;
};

test(`XSD validator availability: ${st.available ? `${st.tool} ${st.version}` : 'NOT AVAILABLE — ' + st.reason}`, () => { assert.ok(true); });

const maybe = st.available ? test : (name, fn) => test(name, (t) => t.skip(`XSD validator not available: ${st.reason}`));

maybe('XSD: generated instance — [200500] current investments with typed dimension', () => {
  run('ci.xml', validCurrentInvestmentsSession().exportXml({ today }).xml);
});

maybe('XSD: generated instance — UI example filing', () => {
  const s = new Session(authority());
  buildExample(s);
  run('example.xml', s.exportXml({ today }).xml);
});

maybe('XSD: generated instance — explicit multi-axis borrowings + typed related parties', () => {
  const s = enableRelatedParties(baseSession());
  for (const [l, v] of [['LongTermBorrowings', 300], ['NoncurrentLiabilities', 300], ['EquityAndLiabilities', 300], ['CashAndBankBalances', 300], ['CurrentAssets', 300], ['Assets', 300]]) s.setValue(q(l), 'CY', String(v));
  const dims = [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('LongTermMember') }, { axis: q('ClassificationOfBorrowingsAxis'), member: q('TermLoansFromBanksMember') }, { axis: q('SubclassificationOfBorrowingsAxis'), member: q('UnsecuredBorrowingsMember') }];
  s.setTableValue('200300:ClassificationOfBorrowingsTable', 'CY', dims, q('Borrowings'), '300');
  s.setTableValue('201600:DisclosureOfRelationshipAndTransactionsBetweenRelatedPartiesTable', 'CY', [{ axis: q('CategoriesOfRelatedPartiesAxis'), typed: 'RelatedParty1' }], q('NameOfRelatedParty'), 'A & B <Pvt> Ltd');
  run('borrow.xml', generateInstance(authority(), s.filing).xml);
});

for (const f of readdirSync('.').filter((x) => /^golden-.*\.xml$/.test(x))) {
  maybe(`XSD: MCA-validated source ${f} and its regenerated instance`, () => {
    const xml = readFileSync(f, 'utf8');
    run(f, xml);
    const { s } = importSession(xml);
    run('regen-' + f, s.exportXml({ today }).xml);
  });
}

maybe('XSD: validator genuinely rejects schema and dimension errors', () => {
  const xml = validCurrentInvestmentsSession().exportXml({ today }).xml;
  const bad = xml.replace(/(<in-gaap:CurrentInvestments contextRef="I2017" unitRef="INR" decimals="0">)1000</, '$1one thousand<');
  const r = validateInstanceXml(bad, { label: 'bad.xml' });
  assert.equal(r.status, 'FAIL');
  assert.ok(r.errors.some((e) => /xmlSchema/.test(e.code)));
});

