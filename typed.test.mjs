// Suites: typed dimensions (first-class), related party RelatedParty1..3 round trip, sequential members.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, q, importSession } from './helpers.mjs';
import { baseSession as base, enableRelatedParties } from './fixtures.mjs';
const baseSession = () => enableRelatedParties(base());
import { Filing } from './model.js';
import { Session } from './session.js';
import { sequentialGaps } from './dimensions.js';
import { generateInstance } from './generator.js';

const A = authority();
const RP = '201600:DisclosureOfRelationshipAndTransactionsBetweenRelatedPartiesTable';
const AX = q('CategoriesOfRelatedPartiesAxis');

function relatedParties(s) {
  const nature = { 1: 'Associate', 2: 'Fellow Subsidiary company', 3: 'Others' }; // no holding company: WhetherCompanyIsSubsidiaryCompany is No
  for (const [i, name] of [[1, 'Holding Co Ltd'], [2, 'Fellow Sub Pvt Ltd'], [3, 'Director A']]) {
    for (const scope of ['CY', 'PY']) {
      const dims = [{ axis: AX, typed: `RelatedParty${i}` }];
      s.setTableValue(RP, scope, dims, q('NameOfRelatedParty'), name);
      s.setTableValue(RP, scope, dims, q('DescriptionOfNatureOfRelatedPartyRelationship'), nature[i]);
      s.setTableValue(RP, scope, dims, q('PermanentAccountNumberOfRelatedParty'), `AAACR000${i}A`);
      s.setTableValue(RP, scope, dims, q('PurchasesOfGoodsRelatedPartyTransactions'), String(100 * i + (scope === 'PY' ? 1 : 0)));
      s.setTableValue(RP, scope, dims, q('CountryOfIncorporationOrResidenceOfRelatedParty'), 'INDIA');
      s.setTableValue(RP, scope, dims, q('DescriptionOfNatureOfTransactionsWithRelatedParty'), 'Purchase of goods');
      s.setTableValue(RP, scope, dims, q('AmountWrittenOffDuringPeriodInRespectOfDebtsDueFromRelatedParties'), '0');
      s.setTableValue(RP, scope, dims, q('AmountWrittenBackDuringPeriodInRespectOfDebtsDueToRelatedParties'), '0');
    }
  }
  return s;
}

test('typed axis renders as typed (never as an explicit dropdown) with its typed domain', () => {
  const s = baseSession();
  const { view } = s.openTable(RP, 'CY');
  const ax = view.axes.find((a) => a.axis === AX);
  assert.equal(ax.typed, true);
  assert.equal(ax.members.length, 0);
  assert.equal(ax.typedDomain, q('RelatedPartiesDomain'));
  assert.equal(s.suggestTypedValue(RP, 'CY', AX), 'RelatedParty1');
});

test('RelatedParty1..3: create → edit → save → reload → export → import → edit again; typed values survive', () => {
  const s = relatedParties(baseSession());
  assert.equal(s.suggestTypedValue(RP, 'CY', AX), 'RelatedParty4');
  // edit
  s.setTableValue(RP, 'CY', [{ axis: AX, typed: 'RelatedParty2' }], q('NameOfRelatedParty'), 'Fellow Subsidiary Pvt Ltd');
  // save / reload (project JSON)
  const json = JSON.parse(JSON.stringify(s.filing.toJSON()));
  const s2 = new Session(A, Filing.fromJSON(A, json));
  assert.equal(s2.getValue(q('NameOfRelatedParty'), 'CY', [{ axis: AX, typed: 'RelatedParty2' }]).value, 'Fellow Subsidiary Pvt Ltd');
  // export
  const { xml } = s2.exportXml({ today: '2017-06-30' });
  for (const i of [1, 2, 3]) assert.match(xml, new RegExp(`<xbrldi:typedMember dimension="in-gaap:CategoriesOfRelatedPartiesAxis"><in-gaap:RelatedPartiesDomain>RelatedParty${i}</in-gaap:RelatedPartiesDomain></xbrldi:typedMember>`));
  // import
  const { s: s3, report } = importSession(xml);
  assert.equal(report.unresolvedFacts.length, 0);
  for (const i of [1, 2, 3]) for (const scope of ['CY', 'PY']) assert.ok(s3.getValue(q('NameOfRelatedParty'), scope, [{ axis: AX, typed: `RelatedParty${i}` }]), `RelatedParty${i} ${scope}`);
  // edit again: rename typed member on an imported row and change a value
  s3.renameTypedMember(RP, 'CY', [{ axis: AX, typed: 'RelatedParty3' }], AX, 'RelatedParty3 ');
  s3.renameTypedMember(RP, 'CY', [{ axis: AX, typed: 'RelatedParty3 ' }], AX, 'RelatedParty3');
  s3.setTableValue(RP, 'CY', [{ axis: AX, typed: 'RelatedParty3' }], q('PurchasesOfGoodsRelatedPartyTransactions'), '999');
  const { xml: xml2 } = s3.exportXml({ today: '2017-06-30' });
  const { s: s4 } = importSession(xml2);
  assert.equal(s4.getValue(q('PurchasesOfGoodsRelatedPartyTransactions'), 'CY', [{ axis: AX, typed: 'RelatedParty3' }]).value, '999');
  assert.equal(s4.getValue(q('NameOfRelatedParty'), 'PY', [{ axis: AX, typed: 'RelatedParty1' }]).value, 'Holding Co Ltd');
});

test('GR-4 sequential members: explicit taxonomy members (Shareholder1, Shareholder3 without 2) rejected; typed values are free identifiers', () => {
  assert.deepEqual(sequentialGaps(['EquityShares1Member', 'EquityShares3Member']).map((g) => g.missing), [2]);
  // explicit members defined as 1..n in the taxonomy
  const s = baseSession();
  s.setValue(q('WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany'), 'CY', 'true');
  const SH = '200100a:DisclosureOfShareholdingMoreThanFivePerCentInCompanyTable';
  for (const i of [1, 3]) s.setTableValue(SH, 'CY', [{ axis: q('ClassesOfShareCapitalAxis'), member: q('EquityShares1Member') }, { axis: q('NameOfShareholderAxis'), member: q(`Shareholder${i}Member`) }], q('NameOfShareholder'), 'X');
  const g = s.validate({ today: '2017-06-30' });
  assert.ok(g.issues.some((i) => i.ruleId === 'GR-4' && i.severity === 'ERROR' && /Shareholder2Member missing|Shareholder2 missing|Shareholder 2/.test(i.message) || (i.ruleId === 'GR-4' && /missing/.test(i.message))), 'GR-4 flags the explicit-member gap');
  // typed members: the MCA-validated CHARVAK instance uses "_NoncurrentInvestment_2", "DEVANSH DUA_17" without 1
  const t = baseSession();
  for (const i of [1, 3]) t.setTableValue(RP, 'CY', [{ axis: AX, typed: `RelatedParty${i}` }], q('NameOfRelatedParty'), 'X');
  assert.ok(!t.validate({ today: '2017-06-30' }).issues.some((i) => i.ruleId === 'GR-4' && i.severity === 'ERROR'), 'typed identifiers are not sequence-checked');
});

test('typed member values are XML-escaped and preserved exactly', () => {
  const s = baseSession();
  s.setTableValue(RP, 'CY', [{ axis: AX, typed: 'R&D <Party> 1' }], q('NameOfRelatedParty'), 'A & B');
  const f = s.filing.all().find((x) => x.dims.some((d) => d.axis === AX));
  // the related-party table exists only for a Yes answer, so the instance carries that answer too
  const yes = s.filing.all().filter((x) => x.concept === q('WhetherThereAreAnyRelatedPartyTransactionsDuringYear'));
  const { xml } = generateInstance(A, s.filing, [f, ...yes]);
  assert.match(xml, /<in-gaap:RelatedPartiesDomain>R&amp;D &lt;Party&gt; 1<\/in-gaap:RelatedPartiesDomain>/);
  const { s: s2 } = importSession(xml);
  assert.ok(s2.filing.all().some((x) => x.dims[0]?.typed === 'R&D <Party> 1'));
});

