// Assurance: the tool must never leave the user with an error he cannot resolve himself (see assurance.mjs).
// ASSURANCE_N (default 120) sets the number of mistakes per instance; the release gate runs the default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { authority } from './helpers.mjs';
import { rekey, mistakes, lockedCells, ruleLocations } from './assurance.mjs';
import { Session } from './session.js';

const A = authority();
const N = Number(process.env.ASSURANCE_N || 120);
const golden = (n) => readFileSync(new URL(`./golden-${n}_2024-25.xml`, import.meta.url), 'utf8');

for (const g of ['INFOBAHN', 'CHARVAK']) {
  for (const [order, seed] of [['rank', 1], ['reverse', 1], ['random', 3]]) {
    test(`${g}: every accepted figure can be typed through the screen (${order} order) — identical values, no error`, () => {
      const r = rekey(A, golden(g), { order, seed, DOMParserImpl: DOMParser });
      assert.equal(r.differing.length, 0, r.differing.slice(0, 5).map((f) => `${f.concept} ${JSON.stringify(f.period)}`).join('; '));
      assert.equal(r.extra.length, 0, r.extra.slice(0, 5).map((f) => f.concept).join('; '));
      assert.equal(r.errors.length, 0, r.errors.slice(0, 5).map((e) => e.message).join('; '));
    });
  }
  test(`${g}: ${N} mistakes made through the screen — every error reachable and editable; undo restores the filing exactly`, () => {
    const r = mistakes(A, golden(g), { n: N, seed: g === 'INFOBAHN' ? 11 : 13, DOMParserImpl: DOMParser });
    assert.ok(r.made > N / 3, `mistakes made ${r.made}`);
    assert.deepEqual(r.unreachable, []);
    assert.deepEqual(r.restoreRefused, []);
    assert.deepEqual(r.notRestored, []);
  });
  test(`${g}: every read-only (calculated) cell holds exactly the value the tool derives; none is locked and empty`, () => {
    const r = lockedCells(A, golden(g), { DOMParserImpl: DOMParser });
    assert.ok(r.locked > 500);
    assert.deepEqual(r.wrong, []);
  });
}

test('every element named by an executable MCA rule locates to a cell or table, both years (empty filing and both MCA instances)', () => {
  const filings = [new Session(A).filing];
  for (const g of ['INFOBAHN', 'CHARVAK']) { const s = new Session(A); s.importXml(golden(g), { DOMParserImpl: DOMParser }); filings.push(s.filing); }
  const r = ruleLocations(A, filings);
  assert.ok(r.checked > 9000, String(r.checked));
  assert.deepEqual(r.missing, []);
});
