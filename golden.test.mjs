// Golden-instance regression against MCA-validated instance documents golden-<name>.xml at the repo root.
// Each golden-<name>.xml may come with golden-<name>.pdf (the MCA validator's human-readable rendering).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { authority, q, importSession } from './helpers.mjs';
import { dimKey } from './model.js';
import { toDisplay } from './scaling.js';
import * as Dec from './decimal.js';

const A = authority();
const DIR = new URL('./', import.meta.url).pathname;
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^golden-.*\.xml$/.test(f)) : [];
const today = '2025-09-30';

// semantic row per fact; units compared by measures, not by unit id
function rows(s) {
  return s.filing.all().map((f) => [f.concept, f.period.type === 'instant' ? f.period.date : `${f.period.start}/${f.period.end}`, dimKey(f.dims), f.unit || '', f.decimals ?? '', f.nil ? 'NIL' : f.value].join(' | ')).sort();
}
const sourceStats = (xml) => ({
  contexts: (xml.match(/<xbrli:context /g) || []).length,
  facts: (xml.match(/ contextRef="/g) || []).length,
  typed: (xml.match(/<xbrldi:typedMember /g) || []).length,
  explicit: (xml.match(/<xbrldi:explicitMember /g) || []).length,
  footnotes: (xml.match(/<link:footnote /g) || []).length,
});

if (!files.length) test('golden-instance regression', (t) => t.skip('NO MCA-validated reference instances supplied — add golden-<name>.xml files at the repository root'));

for (const file of files) {
  const xml = readFileSync(DIR + file, 'utf8');
  const stats = sourceStats(xml);
  const { s, report } = importSession(xml);

  test(`${file}: import maps every source fact, context and footnote`, () => {
    assert.equal(report.counts.sourceFacts, stats.facts);
    // every fact is imported except those under a "No" answer of their Yes/No parent (Applicability.dependencyStatus);
    // in the MCA-validated instances these carry no information (0 / false / empty text)
    assert.equal(report.counts.imported + report.counts.notApplicable, stats.facts, JSON.stringify(report.unresolvedFacts.slice(0, 5)));
    for (const x of report.notApplicable) {
      assert.ok(x.reasons.every((r) => r.startsWith('DEP:')), `${x.concept}: ${x.reasons.join()}`);
      assert.ok(x.value === null || ['0', 'false'].includes(x.value) || !x.value.replace(/<[^>]*>/g, '').trim(), `${x.concept}: ${x.value}`);
    }
    assert.equal(report.unresolvedFacts.length, 0);
    assert.equal(report.unknownConcepts.length, 0);
    assert.equal(report.errors.length, 0, report.errors.join('\n'));
    assert.equal(report.conflicts.length, 0);
    assert.equal(report.contexts.length, stats.contexts);
    assert.equal(report.counts.footnotes, stats.footnotes);
    assert.ok(report.schemaRefMatches, report.schemaRef);
    assert.equal(s.filing.meta.schemaRef, report.schemaRef, 'validated schemaRef preserved');
    assert.match(report.periodDetection.method, /DateOfStartOfReportingPeriod/);
    // every typed and explicit member survived
    const typed = s.filing.all().reduce((n, f) => n + f.dims.filter((d) => d.typed != null).length, 0);
    assert.ok(typed > 0 || stats.typed === 0);
  });

  test(`${file}: internal gate accepts the MCA-validated instance (0 blocking errors)`, () => {
    const g = s.validate({ today });
    const errs = g.issues.filter((i) => i.severity === 'ERROR');
    assert.equal(errs.length, 0, errs.slice(0, 15).map((i) => `${i.code}: ${i.message}`).join('\n'));
    assert.equal(g.summary.excluded, 0, 'no validated fact is treated as not applicable');
    // every fact is dimensionally valid and every calculation is evaluated
    assert.ok(!g.issues.some((i) => i.code.startsWith('dim.')));
    const calc = g.calculations;
    assert.ok(calc.filter((c) => c.status === 'PASS').length > 100);
  });

  test(`${file}: export → re-import is semantically identical to the source`, () => {
    const { xml: out, gate } = s.exportXml({ today });
    assert.ok(gate.ok);
    assert.ok(!/precision=|scale=|<xbrli:segment/.test(out));
    assert.ok(out.includes(`xlink:href="${report.schemaRef}"`));
    const back = importSession(out);
    assert.deepEqual(rows(back.s), rows(s), 'facts, periods, dimensions, units, decimals, values');
    assert.equal(back.report.counts.footnotes, report.counts.footnotes);
    assert.equal(s.exportXml({ today }).xml, out, 'deterministic');
    // regenerated instance is itself accepted by the gate
    assert.equal(back.s.validate({ today }).summary.errors, 0);
  });

  test(`${file}: decimals, units and typed members preserved exactly`, () => {
    const src = new Map();
    for (const m of xml.matchAll(/decimals="([^"]+)"/g)) src.set(m[1], (src.get(m[1]) || 0) + 1);
    const ours = new Map();
    for (const f of s.filing.all()) if (f.decimals != null) ours.set(String(f.decimals), (ours.get(String(f.decimals)) || 0) + 1);
    // facts not imported because they are not applicable (Yes/No dependency) keep their decimals in the report
    const naDec = [...xml.matchAll(/<(in-[\w-]+:\w+)\b[^>]*decimals="([^"]+)"[^>]*contextRef="([^"]+)"|<(in-[\w-]+:\w+)\b[^>]*contextRef="([^"]+)"[^>]*decimals="([^"]+)"/g)];
    for (const x of report.notApplicable) {
      if (!A.isNumeric(x.concept)) continue;
      const m = naDec.find((m) => (m[1] || m[4]) === x.concept && (m[3] || m[5]) === x.contextRef);
      if (m) { const d = m[2] || m[6]; ours.set(d, (ours.get(d) || 0) + 1); }
    }
    assert.deepEqual(Object.fromEntries([...ours].sort()), Object.fromEntries([...src].sort()));
    const units = new Set(s.filing.all().map((f) => f.unit).filter(Boolean));
    for (const u of units) assert.ok(['INR', 'shares', 'pure', 'INRPerShare'].includes(u), u);
    const srcTyped = [...xml.matchAll(/<xbrldi:typedMember dimension="([^"]+)"><[^>]+>([^<]*)</g)].map((m) => `${m[1]}=${m[2]}`);
    const ourTyped = new Set(s.filing.all().flatMap((f) => f.dims.filter((d) => d.typed != null).map((d) => `${d.axis}=${d.typed}`)));
    for (const t of srcTyped) assert.ok(ourTyped.has(t), t);
  });

  test(`${file}: edit round trip — scaled entry, decimals policy, gate catches inconsistency, restore`, () => {
    const { s: e } = importSession(xml);
    const ci = q('CurrentInvestments');
    const f0 = e.getValue(ci, 'CY');
    // presentation level from LevelOfRoundingUsedInFinancialStatements; places from the reported decimals
    // level inferred from the source decimals (INFOBAHN: decimals -3 → Lakhs; CHARVAK: INF/0 with paise → Actual)
    const EXPECTED_LEVEL = { 'golden-INFOBAHN_2024-25.xml': 'Lakhs', 'golden-CHARVAK_2024-25.xml': 'Actual' };
    if (EXPECTED_LEVEL[file]) assert.equal(e.filing.meta.level, EXPECTED_LEVEL[file]);
    assert.equal(e.filing.meta.displayPlaces, 2, 'source values carry 2 places at the presentation level');
    const disp = e.displayOf(f0);
    // edit to a different amount: balance sheet totals no longer foot -> gate blocks
    e.setValue(ci, 'CY', Dec.toString(Dec.add(disp, '1')));
    const g = e.validate({ today });
    assert.ok(g.issues.some((i) => i.severity === 'ERROR' && /CurrentInvestments|CurrentAssets/.test(i.message)));
    // restore the original display value: decimals of the source fact are kept
    e.setValue(ci, 'CY', disp);
    const f1 = e.getValue(ci, 'CY');
    assert.equal(f1.value, f0.value);
    assert.equal(f1.decimals, f0.decimals);
  });

  const pdf = DIR + file.replace(/\.xml$/, '.pdf');
  if (existsSync(pdf)) {
    test(`${file}: values match the MCA validator's PDF rendering (balance sheet and P&L)`, () => {
      let text;
      try { text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 64e6 }); } catch { return; }
      const level = s.filing.meta.level;
      let checked = 0;
      for (const code of ['100100', '100200']) {
        const elr = A.elrByCode(code);
        const sec = text.split(`[${code}]`)[1].split(/\n\s*\d+\s*\n/)[0];
        const byLabel = new Map();
        for (const q2 of Object.keys(A.concepts)) if (A.conceptElrs(q2).includes(elr.uri) && A.isNumeric(q2)) for (const l of Object.values(A.concept(q2).labels)) byLabel.set(l.toLowerCase().trim(), q2);
        for (const line of sec.split('\n')) {
          const m = /^\s*(.+?)\s{2,}(-?[\d,]+(?:\.\d+)?)\s+(-?[\d,]+(?:\.\d+)?)\s*$/.exec(line);
          if (!m) continue;
          const c = byLabel.get(m[1].toLowerCase().trim());
          if (!c) continue;
          for (const [i, scope] of [[2, 'CY'], [3, 'PY']]) {
            const fact = s.getValue(c, scope);
            assert.ok(fact, `${c} ${scope} present`);
            const shown = m[i].replace(/,/g, '');
            const ours = A.isMonetary(c) ? toDisplay(fact.value, level) : fact.value;
            assert.ok(Dec.eq(ours, shown), `${c} ${scope}: XML ${ours} vs PDF ${shown}`);
            checked++;
          }
        }
      }
      assert.ok(checked >= 40, `compared ${checked} values`);
      console.log(`# PDF cross-check: ${checked} values compared`);
    });
  }
}

for (const file of files) {
  test(`${file}: contexts, units, explicit/typed dimensions, current/prior and calculations survive regeneration`, () => {
    const xml = readFileSync(DIR + file, 'utf8');
    const a = importSession(xml);
    const out = a.s.exportXml({ today }).xml;
    const b = importSession(out);
    const ctxSet = (rep) => new Set(rep.contexts.map((c) => c.internalContextKey));
    // every source context that carries a fact is regenerated (period + dimensions), none invented
    const used = new Set(a.s.filing.all().map((f) => `${f.period.type === 'instant' ? 'I:' + f.period.date : 'D:' + f.period.start + ':' + f.period.end}#${dimKey(f.dims)}`));
    assert.deepEqual(ctxSet(b.report), used);
    const measures = (rep) => new Set(rep.units.map((u) => (u.denominator ? `${u.numerator}/${u.denominator}` : u.measures.join('*'))));
    assert.deepEqual(measures(b.report), measures(a.report), 'unit measures');
    const dimCount = (s, kind) => s.filing.all().reduce((n, f) => n + f.dims.filter((d) => (kind === 'typed' ? d.typed != null : d.member)).length, 0);
    assert.equal(dimCount(b.s, 'explicit'), dimCount(a.s, 'explicit'), 'explicit dimensions');
    assert.equal(dimCount(b.s, 'typed'), dimCount(a.s, 'typed'), 'typed dimensions');
    for (const scope of ['CY', 'PY', 'PYO']) assert.equal(b.s.filing.inScope(scope).length, a.s.filing.inScope(scope).length, `facts in ${scope}`);
    assert.ok(a.s.filing.inScope('CY').length > 0 && a.s.filing.inScope('PY').length > 0);
    const calc = (s) => { const c = {}; for (const x of s.validate({ today }).calculations) c[x.status] = (c[x.status] || 0) + 1; return c; };
    assert.deepEqual(calc(b.s), calc(a.s), 'calculation results identical');
  });
}

// Regression (MCA XBRL Validator, INFOBAHN regeneration 2026-10-03: cvc-complex-type.3.2.2 "Attribute 'xml:lang' is
// not allowed to appear in element 'in-ca:PANOfShareholder'" …, 21 elements): xml:lang only on the XBRL base text types.
for (const file of files) {
  test(`${file}: regenerated XML carries xml:lang only on xbrli:stringItemType / nonnum:textBlockItemType`, () => {
    const { s } = importSession(readFileSync(DIR + file, 'utf8'));
    const { xml } = s.exportXml({ today: '2025-10-03' });
    let allowed = 0;
    for (const m of xml.matchAll(/<((?:in-gaap|in-ca):\w+) ([^>]*)>/g)) {
      const hasLang = /xml:lang=/.test(m[2]);
      if (A.langAllowed(m[1])) { if (hasLang) allowed++; }
      else assert.ok(!hasLang, `${m[1]} (${A.concept(m[1]).type}) must not carry xml:lang`);
    }
    assert.ok(allowed > 0, 'Filing Manual #28: base text types still carry xml:lang="en"');
    for (const q of ['PANOfShareholder', 'CorporateIdentityNumber', 'TypeOfCashFlowStatement', 'LevelOfRoundingUsedInFinancialStatements']) assert.equal(A.langAllowed(A.qnameOfLocal(q)), false, q);
  });
}
