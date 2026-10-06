// Suites: XML importer, XML generator, current/prior, internal gate, golden-instance regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { authority, q, importSession, XMLParser, CIN } from './helpers.mjs';
import { baseSession, validCurrentInvestmentsSession } from './fixtures.mjs';
import { scopeOf, periodFor, addDays } from './periods.js';
import { Gate, GateError } from './gate.js';
import { generateInstance } from './generator.js';
import { dimKey } from './model.js';

const A = authority();
const today = '2017-06-30';

// semantic content of an instance: (concept, period, dims, unit measures, decimals, value)
export function semantic(xml) {
  const { s, report } = importSession(xml);
  const rows = s.filing.all().map((f) => [f.concept, f.period.type === 'instant' ? f.period.date : `${f.period.start}/${f.period.end}`, dimKey(f.dims), f.unit, f.decimals, f.nil ? 'NIL' : f.value].join(' | ')).sort();
  return { rows, report, s };
}

test('generator: prescribed schemaRef, CIN scheme, no segment, no precision/scale, unique contexts, no unused units', () => {
  const s = validCurrentInvestmentsSession();
  const { xml } = s.exportXml({ today });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<link:schemaRef xlink:type="simple" xlink:href="http:\/\/www.mca.gov.in\/XBRL\/2016\/07\/26\/Taxonomy\/CnI\/in-ci-ent-2016-03-31.xsd"\/>/);
  assert.match(xml, new RegExp(`<xbrli:identifier scheme="http://www.mca.gov.in/CIN">${CIN}</xbrli:identifier>`));
  assert.ok(!/<xbrli:segment|precision=|scale=/.test(xml));
  const ids = [...xml.matchAll(/<xbrli:context id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(xml.includes(`contextRef="${id}"`), `context ${id} used (Filing Manual #6)`);
  for (const [, u] of xml.matchAll(/<xbrli:unit id="([^"]+)"/g)) assert.ok(xml.includes(`unitRef="${u}"`), `unit ${u} used (#14)`);
  // well-formed and namespace-valid
  const doc = new XMLParser().parseFromString(xml, 'application/xml');
  assert.equal(doc.documentElement.localName, 'xbrl');
  // deterministic
  assert.equal(s.exportXml({ today }).xml, xml);
});

test('importer: round trip is semantically equivalent; context ids are mapped, not reused blindly', () => {
  const s = validCurrentInvestmentsSession();
  const { xml } = s.exportXml({ today });
  const a = semantic(xml);
  assert.equal(a.report.unresolvedFacts.length, 0);
  assert.equal(a.report.counts.sourceFacts, a.report.counts.imported);
  // rename contexts in the source to collision-prone ids and shuffle fact order
  let renamed = xml;
  for (const [i, id] of [...xml.matchAll(/<xbrli:context id="([^"]+)"/g)].map((m) => m[1]).entries()) renamed = renamed.replaceAll(`"${id}"`, `"c${i % 2 ? 'X' : 'x'}${i}"`);
  const lines = renamed.split('\n');
  const factLines = lines.filter((l) => /^ {2}<in-/.test(l)).reverse();
  const shuffled = [...lines.filter((l) => !/^ {2}<in-/.test(l) && !/<\/xbrli:xbrl>/.test(l)), ...factLines, '</xbrli:xbrl>'].join('\n');
  const b = semantic(shuffled);
  assert.deepEqual(b.rows, a.rows);
  assert.ok(b.report.contexts.every((c) => c.sourceContextId.startsWith('c')));
  const regenerated = b.s.exportXml({ today }).xml;
  assert.equal(regenerated, xml, 'regenerated XML is identical after normalisation');
});

test('importer: unknown concepts and undefined contexts are reported, never dropped silently', () => {
  const { xml } = validCurrentInvestmentsSession().exportXml({ today });
  const bad = xml.replace('</xbrli:xbrl>', '  <in-gaap:NoSuchConcept contextRef="D2017" xml:lang="en">x</in-gaap:NoSuchConcept>\n  <in-gaap:OtherIncome contextRef="NOPE" unitRef="INR" decimals="0">1</in-gaap:OtherIncome>\n</xbrli:xbrl>');
  const { report } = importSession(bad);
  assert.equal(report.unresolvedFacts.length, 2);
  assert.ok(report.unknownConcepts.some((c) => c.endsWith('NoSuchConcept')));
  assert.ok(report.unresolvedFacts.some((u) => /contextRef 'NOPE'/.test(u.reason)));
  assert.equal(report.counts.sourceFacts, report.counts.imported + report.counts.unresolved);
});

test('importer: duplicate facts (identical / inconsistent) are reported', () => {
  const { xml } = validCurrentInvestmentsSession().exportXml({ today });
  const dup = xml.replace('</xbrli:xbrl>', '  <in-gaap:OtherIncome contextRef="D2017" unitRef="INR" decimals="0">0</in-gaap:OtherIncome>\n  <in-gaap:OtherIncome contextRef="D2016" unitRef="INR" decimals="0">5</in-gaap:OtherIncome>\n</xbrli:xbrl>');
  const { report } = importSession(dup);
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.conflicts.length, 1);
});

test('current/prior: periods come from reporting dates, not fact order; opening = prior closing (shared instant)', () => {
  const P = { cy: { start: '2016-04-01', end: '2017-03-31' }, py: { start: '2015-04-01', end: '2016-03-31' } };
  assert.equal(scopeOf(P, periodFor(P, 'duration', 'CY')), 'CY');
  assert.equal(scopeOf(P, periodFor(P, 'instant', 'PY')), 'PY');
  assert.equal(scopeOf(P, { type: 'instant', date: addDays(P.py.start, -1) }), 'PYO');
  const s = baseSession();
  // opening balance of CY (periodStart label) is the PY closing fact
  const opening = s.periodForCell(q('Reserves'), 'CY', 'periodStartLabel');
  assert.deepEqual(opening, { type: 'instant', date: '2016-03-31' });
  const { xml } = validCurrentInvestmentsSession().exportXml({ today });
  const { report } = importSession(xml);
  assert.deepEqual(report.periodDetection.cy, P.cy);
  assert.deepEqual(report.periodDetection.py, P.py);
  assert.match(report.periodDetection.method, /DateOfStartOfReportingPeriod/);
});

test('gate: blocks generation on errors; separate from official MCA validation', () => {
  const s = baseSession();
  s.filing.meta.cin = 'BADCIN';
  const g = new Gate(A).run(s.filing, { today });
  assert.equal(g.ok, false);
  assert.equal(g.officialValidation, 'NOT_RUN');
  assert.throws(() => s.exportXml({ today }), GateError);
  // dimension misuse is caught
  const s2 = baseSession();
  s2.filing.setFact({ concept: q('OtherIncome'), period: s2.filing.period(q('OtherIncome'), 'CY'), dims: [{ axis: q('ClassesOfTangibleAssetsAxis'), member: q('LandMember') }], value: '1', decimals: '0' });
  assert.ok(new Gate(A).run(s2.filing, { today }).issues.some((i) => i.code === 'dim.hypercube'));
  // default member in the instance is rejected (#30)
  const s3 = baseSession();
  s3.setValue(q('TangibleAssets'), 'CY', '1'); // the tangible-assets table applies only when the balance sheet amount > 0
  s3.filing.setFact({ concept: q('TangibleAssets'), period: s3.filing.period(q('TangibleAssets'), 'CY'), dims: [{ axis: q('ClassesOfTangibleAssetsAxis'), member: q('CompanyTotalTangibleAssetsMember') }], value: '1', decimals: '0' });
  assert.ok(new Gate(A).run(s3.filing, { today }).issues.some((i) => i.code === 'dim.defaultReported'));
});

test('gate: HTML guidelines for textual content', async () => {
  const { htmlGuidelineIssues } = await import('./gate.js');
  assert.deepEqual(htmlGuidelineIssues('<p>ok <span class="normalText">x</span></p>'), []);
  assert.ok(htmlGuidelineIssues('<b>bold</b>').some((m) => /not allowed/.test(m)));
  assert.ok(htmlGuidelineIssues('<p style="x">a</p>').some((m) => /style/.test(m)));
  assert.ok(htmlGuidelineIssues('<P>a</P>').some((m) => /lower case/.test(m)));
  assert.ok(htmlGuidelineIssues('a &copy; b').some((m) => /entity/.test(m)));
});

test('golden-instance regression (MCA reference instances golden-*.xml)', (t) => {
  const dir = new URL('./', import.meta.url).pathname;
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^golden-.*\.xml$/.test(f)) : [];
  if (!files.length) { t.skip('NO MCA-validated reference instances were supplied — golden regression NOT EXECUTED (add golden-<name>.xml at the repository root)'); return; }
  for (const f of files) {
    const xml = readFileSync(dir + f, 'utf8');
    const a = semantic(xml);
    const regenerated = generateInstance(A, a.s.filing).xml;
    const b = semantic(regenerated);
    assert.deepEqual(b.rows, a.rows, `${f}: semantic equivalence after regenerate`);
  }
});
