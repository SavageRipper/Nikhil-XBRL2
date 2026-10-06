// Suite: import year-mapping — "Both years" vs "Current year only", mapped by XBRL period dates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { authority, q } from './helpers.mjs';
import { Session } from './session.js';
import { DOMParser } from '@xmldom/xmldom';
import { dimKey } from './model.js';
import { openingBalanceConcepts } from './importer.js';
import { validCurrentInvestmentsSession, CI_TABLE } from './fixtures.mjs';

const A = authority();
const opts = (yearMode) => ({ DOMParserImpl: DOMParser, yearMode, fileName: 'src.xml' });
const row = (f) => `${f.concept}|${f.period.type === 'instant' ? f.period.date : f.period.start + '/' + f.period.end}|${dimKey(f.dims)}|${f.value}|${f.decimals}|${f.unit}`;
const sources = [...readdirSync('.').filter((x) => /^golden-.*\.xml$/.test(x)).map((f) => [f, readFileSync(f, 'utf8')]),
  ['generated-ci.xml', validCurrentInvestmentsSession().exportXml({ today: '2017-06-30' }).xml]];

for (const [name, xml] of sources) {
  test(`${name}: preview shows the year split before anything is committed`, () => {
    const s = new Session(A);
    const before = s.filing.all().length;
    const p = s.previewXml(xml, { DOMParserImpl: DOMParser });
    assert.ok(p.byYear.current > 0 && p.byYear.previous > 0);
    assert.equal(s.filing.all().length, before, 'preview does not change the filing');
  });

  test(`${name}: Both years — CY and PY populated losslessly by period dates`, () => {
    const s = new Session(A);
    const r = s.importXml(xml, opts('both'));
    assert.equal(r.yearMode, 'both');
    assert.equal(r.byYear.current + r.byYear.previous + r.byYear.previousOpening + r.byYear.other, r.counts.imported);
    // every source fact is accounted for: imported, unresolved, or not applicable (kept in the report only)
    assert.equal(r.counts.imported + r.counts.unresolved + r.counts.notApplicable, r.counts.sourceFacts);
    for (const x of r.notApplicable) assert.ok(x.reasons.length, 'reason recorded');
    assert.equal(s.filing.inScope('CY').length, r.byYear.current);
    assert.equal(s.filing.inScope('PY').length, r.byYear.previous);
    assert.ok(s.filing.all().some((f) => s.filing.scopeOf(f.period) === 'PY' && f.dims.length), 'dimensional PY facts');
  });

  test(`${name}: Current year only — comparative previous-year data not imported, CY identical to Both years, nothing shifted`, () => {
    const both = new Session(A); both.importXml(xml, opts('both'));
    const cur = new Session(A);
    const r = cur.importXml(xml, opts('current'));
    assert.equal(r.yearMode, 'current');
    const opening = openingBalanceConcepts(A);
    const pyEnd = cur.filing.meta.periods.py.end;
    // previous-year facts present after a current-year-only import are exactly the current-year opening balances
    const pyFacts = cur.filing.inScope('PY');
    assert.equal(pyFacts.length, r.byYear.carriedOpening);
    for (const f of pyFacts) {
      assert.equal(f.period.type, 'instant', `${f.concept}: no previous-year duration fact`);
      assert.equal(f.period.date, pyEnd);
      assert.ok(opening.has(f.concept), `${f.concept} is presented with an opening (periodStart) row`);
    }
    assert.equal(cur.filing.inScope('PYO').length, 0, 'no previous-year opening facts');
    assert.equal(r.byYear.previous, 0);
    const bothPy = both.filing.inScope('PY');
    const expectedCarry = bothPy.filter((f) => f.period.type === 'instant' && opening.has(f.concept));
    assert.deepEqual(pyFacts.map(row).sort(), expectedCarry.map(row).sort(), 'carried values identical to the source, nothing else');
    // previous-year source facts = imported PY (Both years) + PY facts not applicable in Both years
    const bothNaPY = both.filing.importReport.notApplicable.filter((x) => x.scope === 'PY').length;
    assert.equal(r.byYear.skippedPrevious, bothPy.length + bothNaPY - expectedCarry.length);
    assert.equal(r.byYear.skippedPreviousOpening, both.filing.inScope('PYO').length);
    // every previous-year duration (P&L, cash flow, changes) and every PY-end instant of a non-opening concept is skipped
    assert.ok(!pyFacts.some((f) => !opening.has(f.concept)));
    // CY content identical to the Both-years import (normal, dimensional, typed, numeric and text facts)
    const cyRows = (s) => s.filing.inScope('CY').map(row).sort();
    assert.deepEqual(cyRows(cur), cyRows(both));
    const cyFacts = cur.filing.inScope('CY');
    assert.ok(cyFacts.some((f) => f.dims.some((d) => d.typed != null)), 'typed dimensions kept');
    assert.ok(cyFacts.some((f) => f.dims.some((d) => d.member)) || name.startsWith('generated'), 'explicit dimensions kept');
    assert.ok(cyFacts.some((f) => A.isNumeric(f.concept)) && cyFacts.some((f) => !A.isNumeric(f.concept)), 'numeric and text facts');
    for (const f of cyFacts) assert.ok(f.period.type === 'instant' ? f.period.date === cur.filing.meta.periods.cy.end : f.period.end === cur.filing.meta.periods.cy.end, 'only current-period dates');
    assert.equal(cur.filing.meta.periods.py.end, both.filing.meta.periods.py.end);
    for (const t of A.tables.slice(0, 92)) assert.equal(cur.tableStatus(t.id, 'CY').applicable, both.tableStatus(t.id, 'CY').applicable, t.id);
    // the current-year opening cell of every carried balance resolves to the carried fact
    for (const f of pyFacts) {
      const v = cur.getValue(f.concept, 'CY', f.dims, 'periodStartLabel');
      assert.ok(v && v.value === f.value, `${f.concept}: CY opening balance available`);
    }
    // no previous-year duration context and no PY-end context other than opening balances in the generated XML
    assert.ok(!cur.filing.all().some((f) => f.period.type === 'duration' && f.period.end === pyEnd));
  });
}

test('current-year opening balances (audit): MCA source GR-7 and the MCA-validated instance', () => {
  // authoritative source: generic rule 7 of the rule workbook
  const gr7 = A.rules.rules.find((r) => r.id === 'GR-7');
  assert.match(gr7.text, /common element for specifying the opening and closing balance/);
  assert.match(gr7.text, /Opening balance of current year be shown as the closing balance of previous year/);
  // taxonomy: opening-balance concepts are instants presented with a periodStart label
  const opening = openingBalanceConcepts(A);
  assert.ok(opening.size >= 20);
  for (const c of opening) assert.equal(A.concept(c).periodType, 'instant');
  for (const l of ['ShareCapital', 'NumberOfSharesOutstanding', 'Reserves', 'TangibleAssets', 'IntangibleAssets']) assert.ok(opening.has(q(l)), l);
  // validated instance: these facts carry the current-year opening balances of its reconciliations
  for (const [name, xml] of sources.filter(([n]) => n.startsWith('golden-'))) {
    const cur = new Session(A);
    const r = cur.importXml(xml, opts('current'));
    console.log(`# ${name}: current-year-only import carried ${r.byYear.carriedOpening} opening-balance facts (${r.carriedOpeningConcepts.length} concepts), skipped ${r.byYear.skippedPrevious} previous-year facts`);
    assert.ok(r.byYear.carriedOpening > 0);
    // e.g. the share-capital reconciliation: CY opening number of shares = PY closing
    const sh = cur.filing.all().find((f) => f.concept === q('NumberOfSharesOutstanding') && cur.filing.scopeOf(f.period) === 'PY');
    assert.ok(sh, 'NumberOfSharesOutstanding opening balance carried');
    // comparative previous-year data of other items is not imported
    assert.ok(!cur.filing.all().some((f) => cur.filing.scopeOf(f.period) === 'PY' && ['Assets', 'EquityAndLiabilities', 'TradePayables', 'RevenueFromOperations', 'ProfitLossForPeriod'].includes(A.concept(f.concept).name)));
  }
});

test('duplicate contexts in the source are merged consistently in both modes', () => {
  const xml = validCurrentInvestmentsSession().exportXml({ today: '2017-06-30' }).xml;
  const dup = xml.replace('<xbrli:context id="D2017">', '<xbrli:context id="D2017dup"><xbrli:entity><xbrli:identifier scheme="http://www.mca.gov.in/CIN">U72200KA2010PTC123456</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2016-04-01</xbrli:startDate><xbrli:endDate>2017-03-31</xbrli:endDate></xbrli:period></xbrli:context>\n  <xbrli:context id="D2017">');
  for (const mode of ['both', 'current']) {
    const s = new Session(A);
    const r = s.importXml(dup, opts(mode));
    assert.ok(r.warnings.some((w) => /Duplicate contexts/.test(w)), mode);
  }
  void q; void CI_TABLE;
});
