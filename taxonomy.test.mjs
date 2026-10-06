// Suites: taxonomy parser, taxonomy table compiler, dimension compiler, hypercube compiler,
// all/notAll/default, 92-table requirement (dynamic), provenance, determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { authority, q } from './helpers.mjs';
import { buildTableView, buildElrView } from './views.js';

const TAX = new URL('./.taxonomy/Taxonomy-2016-03-31/', import.meta.url).pathname;
const defFiles = () => ['IN-GAAP/DEF', 'IN-CA/DEF'].flatMap((d) => readdirSync(path.join(TAX, d)).map((f) => path.join(TAX, d, f)));
const countArcrole = (role) => defFiles().reduce((n, f) => n + (readFileSync(f, 'utf8').match(new RegExp(`arcrole="http://xbrl.org/int/dim/arcrole/${role}"`, 'g')) || []).length, 0);

test('taxonomy parser: concept inventory equals xsd element count', () => {
  const A = authority();
  const xsdCount = ['IN-GAAP/in-gaap-2016-03-31.xsd', 'IN-CA/in-ca-2016-03-31.xsd'].reduce((n, f) => n + (readFileSync(path.join(TAX, f), 'utf8').match(/^\s*<element /gm) || []).length, 0);
  assert.equal(Object.keys(A.concepts).length, xsdCount);
  const c = A.concept(q('ShareCapital'));
  assert.equal(c.periodType, 'instant');
  assert.equal(c.balance, 'credit');
  assert.equal(A.dataType(q('ShareCapital')), 'monetary');
  assert.equal(A.label(q('ShareCapital')), 'Share capital');
  assert.ok(A.enumerations(q('LevelOfRoundingUsedInFinancialStatements')).includes('Lakhs'));
});

test('92-table requirement: application table count equals taxonomy all-arc count (derived, not hard-coded)', () => {
  const A = authority();
  const allArcs = countArcrole('all');
  assert.equal(A.tables.length, allArcs);
  assert.equal(A.meta.relationshipStats.all, allArcs);
  assert.equal(A.meta.relationshipStats.notAll, countArcrole('notAll'));
  assert.equal(A.meta.relationshipStats.dimensionDefault, countArcrole('dimension-default'));
  assert.equal(Object.keys(A.defaults).length, countArcrole('dimension-default'));
});

test('every table: ELR, primary item, line items, axes, members, labels, ordering, renderable', () => {
  const A = authority();
  const ids = new Set();
  for (const t of A.tables) {
    assert.ok(!ids.has(t.id), `duplicate table id ${t.id}`); ids.add(t.id);
    assert.ok(A.json.roles[t.elr], `${t.id}: ELR role defined`);
    assert.ok(A.concept(t.primaryItem), `${t.id}: primary item`);
    assert.equal(A.concept(t.hypercube).kind, 'hypercube');
    assert.ok(t.lineItems.length > 0, `${t.id}: line items discovered`);
    if (!t.axes.length) {
      // empty closed hypercube ("/total" ELRs): line items are valid only without dimensions
      assert.equal(t.closed, true, `${t.id}: empty hypercube must be closed`);
      assert.match(t.elr, /\/total$/, `${t.id}: zero-axis tables come from total ELRs`);
    }
    assert.ok(t.presentationElr, `${t.id}: mapped to a presentation ELR`);
    for (const ax of t.axes) {
      if (ax.typed) assert.equal(A.concept(ax.typedDomain).kind, 'typedDomain');
      else assert.ok(ax.members.length > 0, `${t.id} ${ax.axis}: members`);
    }
    const v = buildTableView(A, t.id);
    assert.ok(v.title && !v.title.startsWith('in-'), `${t.id}: labelled`);
    const lineSet = new Set(v.lineItems.filter((l) => !l.abstract).map((l) => l.concept));
    for (const li of t.lineItems) assert.ok(lineSet.has(li), `${t.id}: line item ${li} rendered`);
  }
});

test('line items are discovered from relationships, not from <Table>LineItems naming', () => {
  const A = authority();
  const odd = A.tables.filter((t) => !t.lineItemNodes.some((n) => n.split(':')[1] === t.hypercube.split(':')[1].replace(/Table$/, 'LineItems')));
  assert.ok(odd.length > 0, 'taxonomy contains tables whose line-item node is not <Base>LineItems');
  for (const t of odd) assert.ok(t.lineItems.length > 0, t.id);
  const borrowings = A.table('200300:ClassificationOfBorrowingsTable');
  assert.deepEqual(borrowings.lineItemNodes, [q('DetailsOfBorrowingsLineItems')]);
  assert.ok(borrowings.lineItems.includes(q('Borrowings')));
});

test('hypercube compiler: notAll target roles, unusable members, defaults', () => {
  const A = authority();
  const t = A.table('201000:DisclosureOfTangibleAssetsTable');
  const na = t.notAll.find((n) => n.primary === q('NatureOfOtherTangibleAssets'));
  assert.ok(na, 'notAll attached to NatureOfOtherTangibleAssets');
  assert.equal(na.axes.length, 3);
  const borrow = A.table('200300:ClassificationOfBorrowingsTable');
  const time = borrow.axes.find((a) => a.axis === q('ClassificationBasedOnTimePeriodAxis'));
  assert.equal(time.members.find((m) => m.member === q('ClassificationBasedOnTimePeriodMember')).usable, false);
  assert.equal(A.dimensionDefault(q('ClassificationOfBorrowingsAxis')), q('BorrowingsMember'));
  // every hypercube referenced from any base set is in the catalogue
  for (const sets of Object.values(A.json.conceptHypercubes)) for (const bs of sets) for (const h of bs.hypercubes) assert.ok(A.hypercube(h.hypercube, h.hcElr), `${h.hypercube}@${h.hcElr}`);
});

test('ELR views: every presentation ELR renders and places all its tables', () => {
  const A = authority();
  assert.equal(A.elrs.length, A.meta.annexureCrossCheck.annexureElrCount);
  let placed = 0;
  for (const e of A.elrs) {
    const v = buildElrView(A, e.uri);
    const tableRows = v.rows.filter((r) => r.kind === 'table').map((r) => r.tableId);
    assert.deepEqual(new Set(tableRows), new Set(v.tables));
    placed += tableRows.length;
  }
  assert.equal(placed, A.tables.length);
});

test('provenance: every source file hash matches the authority package', () => {
  const A = authority();
  for (const s of A.meta.sources) {
    const buf = readFileSync(path.join(new URL('./', import.meta.url).pathname, s.file));
    assert.equal(createHash('sha256').update(buf).digest('hex'), s.sha256, s.file);
  }
  assert.equal(A.meta.schemaRef, 'http://www.mca.gov.in/XBRL/2016/07/26/Taxonomy/CnI/in-ci-ent-2016-03-31.xsd');
});

test('authority compiler is deterministic', async () => {
  const { compile } = await import('./compile.mjs');
  const before = readFileSync(new URL('./MCA_AUTHORITY.json', import.meta.url));
  compile();
  const after = readFileSync(new URL('./MCA_AUTHORITY.json', import.meta.url));
  assert.equal(createHash('sha256').update(before).digest('hex'), createHash('sha256').update(after).digest('hex'));
});

test('full taxonomy regression: counts derived independently from the raw taxonomy files', () => {
  const A = authority();
  const xsd = ['IN-GAAP/in-gaap-2016-03-31.xsd', 'IN-CA/in-ca-2016-03-31.xsd'].map((f) => readFileSync(path.join(TAX, f), 'utf8')).join('\n');
  const els = xsd.match(/^\s*<element [^>]*>/gm);
  const typedAxes = els.filter((e) => /substitutionGroup="xbrldt:dimensionItem"/.test(e) && /typedDomainRef=/.test(e));
  const explicitAxes = els.filter((e) => /substitutionGroup="xbrldt:dimensionItem"/.test(e) && !/typedDomainRef=/.test(e));
  const members = els.filter((e) => /type="nonnum:domainItemType"/.test(e));
  const hypercubes = els.filter((e) => /substitutionGroup="xbrldt:hypercubeItem"/.test(e));
  const kinds = {}; for (const c of Object.values(A.concepts)) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
  assert.equal(kinds.typedAxis, typedAxes.length, 'typed axes');
  assert.equal(new Set(Object.values(A.concepts).filter((c) => c.typedDomain).map((c) => c.typedDomain)).size, new Set(typedAxes.map((e) => /typedDomainRef="#([^"]+)"/.exec(e)[1])).size, 'typed domains');
  assert.equal(kinds.explicitAxis, explicitAxes.length, 'explicit axes');
  assert.equal(kinds.member, members.length, 'members (domainItemType)');
  assert.equal(kinds.hypercube, hypercubes.length, 'hypercubes');
  const count = (dir, re) => readdirSync(path.join(TAX, dir)).reduce((n, f) => n + (readFileSync(path.join(TAX, dir, f), 'utf8').match(re) || []).length, 0);
  const calc = count('IN-GAAP/CAL', /<calculationArc /g) + count('IN-CA/CAL', /<calculationArc /g);
  assert.equal(A.meta.relationshipStats.calculationArcs, calc, 'calculation relationships');
  assert.equal(A.meta.relationshipStats.hypercubeDimension, countArcrole('hypercube-dimension'), 'hypercube-dimension arcs');
  // every explicit member reached from an axis in the definition linkbase is known to the dimension engine
  const axesInTables = new Set(A.tables.flatMap((t) => t.axes.map((a) => a.axis)));
  for (const ax of axesInTables) if (!A.isTypedAxis(ax)) assert.ok(A.axisInfo(ax).members.size > 0, ax);
  // line items: all reportable items, discovered for every table
  const lineItems = new Set(A.tables.flatMap((t) => t.lineItems));
  for (const li of lineItems) assert.ok(A.isReportable(li), li);
  console.log(`# taxonomy: tables=${A.tables.length} all=${countArcrole('all')} notAll=${countArcrole('notAll')} defaults=${countArcrole('dimension-default')} calc=${calc} typedAxes=${typedAxes.length} explicitAxes=${explicitAxes.length} members=${members.length} hypercubes=${hypercubes.length} lineItems=${lineItems.size}`);
});
