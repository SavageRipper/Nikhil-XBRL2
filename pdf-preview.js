// Preview of the instance as a printable document (browser "Print → Save as PDF").
// NOT the MCA rendering: the MCA XBRL Validator's PDF converter is part of MCA's tool and its layout is not published.
// This preview only imitates its general structure (company/period header, one section per ELR, "Unless otherwise
// specified …", statement rows with current/previous year, dimensional tables with axis/member headings in blocks of
// columns "..(n)", text blocks as "Textual information (n)") so content, values and text-block tables can be checked
// before validating. Display only: it reads the facts the XML would contain (Applicability.planFacts — the same
// decision the generator uses) through the session's read APIs and changes nothing.
// Footnotes follow the MCA PDFs seen (INFOBAHN, GE Power): "(A) value" in the cell, letters in reading order per table
// block, and a "Footnotes" list after the block.
import * as Dec from './decimal.js';
import { toDisplay } from './scaling.js';
import { tableSlices } from './views.js';
import { reportingYear } from './periods.js';
import { sortSlices } from './member-hints.js';
import { toMca, plainText } from './richtext.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dmy = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso || '');
const LEVEL_TEXT = { Actual: 'INR', Thousands: 'Thousands of INR', Lakhs: 'Lakhs of INR', Millions: 'Millions of INR', Crores: 'Crores of INR', Billions: 'Billions of INR' };
const MAX_COLS = 4; // value columns per table block

/** Indian digit grouping (10,00,000) as in the MCA PDF rendering */
export function groupIN(s) {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(String(s));
  if (!m) return String(s);
  let int = m[2];
  if (int.length > 3) { const last = int.slice(-3); let rest = int.slice(0, -3); const parts = []; while (rest.length > 2) { parts.unshift(rest.slice(-2)); rest = rest.slice(0, -2); } if (rest) parts.unshift(rest); int = parts.join(',') + ',' + last; }
  return m[1] + int + (m[3] || '');
}

export function formatValue(S, f) {
  if (!f || f.nil) return '';
  const A = S.A;
  switch (A.dataType(f.concept)) {
    case 'monetary': return groupIN(toDisplay(f.value, S.filing.meta.level));
    case 'shares': return `[shares] ${groupIN(f.value)}`;
    case 'perShare': return `[INR/shares] ${groupIN(f.value)}`;
    case 'percent': return `${Dec.toFixed(Dec.shift(Dec.parse(f.value), 2), 2)}%`;
    case 'decimal': case 'pure': return groupIN(f.value);
    case 'boolean': return f.value === 'true' ? 'Yes' : 'No';
    case 'date': return dmy(f.value);
    default: return f.value;
  }
}

/**
 * @param S session
 * @param {{ build?: string }} opts
 * @returns {string} complete HTML document
 */
export function buildPreviewHtml(S, { build = 'dev' } = {}) {
  const A = S.A, filing = S.filing, m = filing.meta, P = m.periods;
  const emit = new Set(S.app.planFacts(filing).emit.map((f) => f.key));
  const get = (q, scope, dims, pl) => { const f = S.getValue(q, scope, dims, pl || null); return f && !f.nil && emit.has(f.key) ? f : null; };
  const nameQ = A.qnameOfLocal('NameOfCompany');
  const company = (nameQ && S.getValue(nameQ, 'CY')?.value) || m.name || '';
  const title = `${m.reportType} Financial Statements for period ${dmy(P.cy.start)} to ${dmy(P.cy.end)}`;
  const unitLine = `Unless otherwise specified, all monetary values are in ${LEVEL_TEXT[m.level] || m.level}`;
  const periodHead = (scope, duration) => {
    const p = scope === 'CY' ? P.cy : P.py;
    return duration ? `${dmy(p.start)}<br>to<br>${dmy(p.end)}` : dmy(p.end);
  };
  let tiCount = 0;
  // footnotes as in the MCA PDF: letters (A), (B), … in reading order within a table block, before the value;
  // the "Footnotes" list follows the block
  const fnBy = new Map();
  for (const fn of filing.footnotes.values()) if (fn.text?.trim()) for (const k of fn.factKeys) (fnBy.get(k) || fnBy.set(k, []).get(k)).push(fn);
  // footnote text may itself be HTML (MCA-validated INFOBAHN: <span>Grtuity</span>; the MCA PDF shows the text)
  const fnText = (t) => (/<\s*[a-zA-Z]/.test(t) ? plainText(t) : String(t).trim());
  let fb = null;
  const letter = (i) => { let x = ''; i++; while (i > 0) { x = String.fromCharCode(65 + ((i - 1) % 26)) + x; i = Math.floor((i - 1) / 26); } return x; };
  const marks = (f) => {
    const list = fnBy.get(f.key) || [];
    if (!list.length || !fb) return '';
    return list.map((fn) => { if (!fb.letters.has(fn.id)) { fb.letters.set(fn.id, letter(fb.order.length)); fb.order.push(fn); } return `(${fb.letters.get(fn.id)}) `; }).join('');
  };
  const withFn = (render) => {
    fb = { letters: new Map(), order: [] };
    const html = render();
    const list = fb.order.length ? `<div class="fns"><div class="fnh">Footnotes</div>${fb.order.map((fn) => `<div>(${fb.letters.get(fn.id)}) ${esc(fnText(fn.text)).replace(/\r?\n/g, '<br>')}</div>`).join('')}</div>` : '';
    fb = null;
    return html + list;
  };
  const cell = (S2, f, texts, label) => {
    if (!f) return '';
    const mk = marks(f);
    if (A.dataType(f.concept) === 'textBlock') { tiCount++; texts.push({ n: tiCount, label, html: toMca(f.value) }); return `${mk}Textual information (${tiCount})`; }
    const v = formatValue(S2, f);
    return mk + esc(v).replace(/\r?\n/g, '<br>');
  };
  // rows of a block: keep items with a value; keep a heading when something below it is kept
  const prune = (rows, has) => {
    const keep = rows.map((r) => !r.abstract && has(r));
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].abstract) {
      for (let j = i + 1; j < rows.length && rows[j].depth > rows[i].depth; j++) if (keep[j]) { keep[i] = true; break; }
    }
    return rows.filter((_, i) => keep[i]);
  };

  const sections = [];
  for (const e of A.elrs) {
    // a statement not part of this filing (e.g. the cash-flow method not selected) is not shown
    if (!S.elrStatus(e.uri, 'CY').applicable && !S.elrStatus(e.uri, 'PY').applicable) continue;
    const view = S.elrView(e.uri);
    const texts = [];
    const blocks = [];
    // statement rows (non-dimensional)
    const items = view.rows.filter((r) => r.kind !== 'table').map((r) => ({ ...r, abstract: r.kind === 'header' }));
    const vals = (r, s) => (r.abstract ? null : get(r.concept, s, [], r.preferredLabel));
    const shown = prune(items, (r) => vals(r, 'CY') || vals(r, 'PY'));
    if (shown.length) {
      const scopes = ['CY', 'PY'].filter((s) => shown.some((r) => vals(r, s)));
      const duration = shown.some((r) => !r.abstract && A.concept(r.concept).periodType === 'duration');
      blocks.push(withFn(() => `<table class="st"><thead><tr><th class="lb"></th>${scopes.map((s) => `<th>${periodHead(s, duration)}</th>`).join('')}</tr></thead><tbody>${shown.map((r) => `<tr class="${r.abstract ? 'ab' : ''}"><td class="lb" style="padding-left:${4 + r.depth * 8}px">${esc(r.label)}</td>${scopes.map((s) => `<td class="v">${r.abstract ? '' : cell(S, vals(r, s), texts, r.label)}</td>`).join('')}</tr>`).join('')}</tbody></table>`));
    }
    // tables
    for (const r of view.rows.filter((x) => x.kind === 'table')) {
      const t = A.table(r.tableId);
      const tv = S.tableView(r.tableId);
      const lines = (tv.lineItems || []).map((l) => ({ ...l, abstract: !!l.abstract }));
      if (!t.axes.length) {
        const v2 = (l, s) => (l.abstract ? null : get(l.concept, s, [], l.preferredLabel));
        const sh = prune(lines, (l) => v2(l, 'CY') || v2(l, 'PY'));
        // a totals table whose values all belong to elements presented in other statements/notes as well (e.g. cash
        // flow totals repeated in discontinuing operations) is shown where those elements are, not here again
        if (!sh.length || sh.every((l) => l.abstract || !(v2(l, 'CY') || v2(l, 'PY')) || A.conceptElrs(l.concept).some((u) => u !== e.uri))) continue;
        const scopes = ['CY', 'PY'].filter((s) => sh.some((l) => v2(l, s)));
        const duration = sh.some((l) => !l.abstract && A.concept(l.concept).periodType === 'duration');
        blocks.push(withFn(() => `<h3>${esc(r.label)}</h3><table class="st"><thead><tr><th class="lb"></th>${scopes.map((s) => `<th>${periodHead(s, duration)}</th>`).join('')}</tr></thead><tbody>${sh.map((l) => `<tr class="${l.abstract ? 'ab' : ''}"><td class="lb" style="padding-left:${4 + l.depth * 8}px">${esc(l.label)}</td>${scopes.map((s) => `<td class="v">${l.abstract ? '' : cell(S, v2(l, s), texts, l.label)}</td>`).join('')}</tr>`).join('')}</tbody></table>`));
        continue;
      }
      const all = new Map();
      for (const s of ['CY', 'PY']) for (const d of tableSlices(A, filing, r.tableId, s, reportingYear)) all.set(JSON.stringify(d), d);
      const slices = sortSlices(A, r.tableId, [...all.values()]);
      // columns: (slice, year) pairs that hold a value
      const cols = [];
      for (const d of slices) for (const s of ['CY', 'PY']) if (lines.some((l) => !l.abstract && get(l.concept, s, d, l.preferredLabel))) cols.push({ d, s });
      if (!cols.length) continue;
      const duration = lines.some((l) => !l.abstract && A.concept(l.concept).periodType === 'duration');
      // blocks of up to MAX_COLS value columns, never splitting a member combination
      const groups = [];
      for (const c of cols) {
        const g = groups[groups.length - 1];
        const sameSlice = g && g[g.length - 1].d === c.d;
        if (g && (g.length < MAX_COLS || sameSlice)) g.push(c); else groups.push([c]);
      }
      groups.forEach((g, gi) => {
        const v3 = (l, c) => (l.abstract ? null : get(l.concept, c.s, c.d, l.preferredLabel));
        const sh = prune(lines, (l) => g.some((c) => v3(l, c)));
        if (!sh.length) return;
        // member heading per axis, spanning the columns of the same member combination
        const spans = [];
        for (const c of g) { const last = spans[spans.length - 1]; if (last && last.d === c.d) last.n++; else spans.push({ d: c.d, n: 1 }); }
        const memberName = (ax, d) => { const x = d.find((y) => y.axis === ax.axis); return x ? (x.member ? A.label(x.member) : x.typed) : A.dimensionDefault(ax.axis) ? A.label(A.dimensionDefault(ax.axis)) : ''; };
        const axisRows = t.axes.map((ax) => `<tr class="ax"><th class="lb">${esc(A.label(ax.axis))}</th>${spans.map((sp) => `<th colspan="${sp.n}">${esc(memberName(ax, sp.d))}</th>`).join('')}</tr>`).join('');
        blocks.push(withFn(() => `<div class="tblhead"><span>${esc(A.label(t.hypercube))}</span><span>..(${gi + 1})</span></div><div class="unit">${esc(unitLine)}</div>
          <table class="st dim"><thead>${axisRows}<tr><th class="lb"></th>${g.map((c) => `<th>${periodHead(c.s, duration)}</th>`).join('')}</tr></thead><tbody>${sh.map((l) => `<tr class="${l.abstract ? 'ab' : ''}"><td class="lb" style="padding-left:${4 + l.depth * 8}px">${esc(l.label)}</td>${g.map((c) => `<td class="v">${l.abstract ? '' : cell(S, v3(l, c), texts, l.label)}</td>`).join('')}</tr>`).join('')}</tbody></table>`));
      });
    }
    if (!blocks.length) continue;
    sections.push(`<section class="elr"><h2>[${esc(e.code)}] ${esc(e.title)}</h2><div class="unit">${esc(unitLine)}</div>${blocks.join('')}
      ${texts.map((x) => `<div class="ti"><div class="tih">Textual information (${x.n})</div><div class="til">${esc(x.label)}</div><div class="mca">${x.html}</div></div>`).join('')}</section>`);
  }

  const notice = `PREVIEW generated by C&amp;I XBRL Studio build ${esc(build)} — not the MCA rendering. The official PDF is produced by the MCA XBRL Validator.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(company)} — preview</title>
<style>
@page { size: A4; margin: 14mm 10mm 16mm; @bottom-left { content: "Preview — not the MCA rendering"; font: 8px sans-serif; color: #666; } @bottom-right { content: counter(page); font: 9px sans-serif; } }
body { font: 10px/1.35 Arial, Helvetica, sans-serif; color: #000; background: #fff; margin: 0 auto; max-width: 900px; padding: 10px; }
.bar { position: sticky; top: 0; background: #fff8e1; border: 1px solid #e0b000; padding: 6px 10px; margin-bottom: 10px; font-size: 12px; display: flex; gap: 10px; align-items: center; }
.bar button { font-size: 12px; padding: 4px 10px; }
.notice { font-size: 8.5px; color: #7a5c00; border-bottom: 1px solid #ccc; padding-bottom: 3px; margin-bottom: 6px; }
.doc-head { text-align: center; margin-bottom: 8px; } .doc-head b { display: block; font-size: 12px; }
section.elr { break-before: page; } section.elr:first-of-type { break-before: auto; }
h2 { text-align: center; font-size: 11.5px; margin: 10px 0 2px; } h3 { font-size: 10.5px; margin: 10px 0 2px; }
.unit { text-align: right; font-size: 9px; margin: 2px 0 4px; }
.tblhead { display: flex; justify-content: space-between; font-weight: bold; margin-top: 12px; }
table.st { width: 100%; border-collapse: collapse; table-layout: fixed; margin-bottom: 6px; }
table.st th, table.st td { padding: 1px 4px; vertical-align: top; overflow-wrap: anywhere; }
table.st thead { display: table-header-group; } table.st tr { break-inside: avoid; }
table.st th { font-weight: normal; text-align: center; } table.st th.lb, table.st td.lb { text-align: left; width: 46%; }
table.st tr.ax th { font-weight: normal; } table.st tr.ax th.lb { text-align: right; padding-right: 8px; }
table.st td.v { text-align: right; } table.st tr.ab td { font-weight: normal; }
.fns { margin: 2px 0 10px 4px; } .fns .fnh { font-weight: bold; margin-bottom: 2px; }
.ti { break-before: page; } .tih { text-align: center; font-weight: bold; margin: 8px 0 2px; } .til { text-align: center; margin-bottom: 6px; }
/* MCA text-block classes (approximation of the MCA rendering) */
.mca table { border-collapse: collapse; margin: 4px 0; } .mca td, .mca th { padding: 1px 4px; vertical-align: top; } .mca p { margin: 0 0 4px; }
.mca .bordered { border: 1px solid #000; } .mca .unbordered { border: 0; }
.mca .header1 { font-size: 14px; font-weight: bold; } .mca .header2 { font-size: 13px; font-weight: bold; } .mca .header3 { font-size: 12px; font-weight: bold; } .mca .header4 { font-size: 11px; font-weight: bold; } .mca .header5 { font-weight: bold; }
.mca .highlightedText1 { background: #555; color: #fff; } .mca .highlightedText2 { background: #888; color: #fff; } .mca .highlightedText3 { background: #bbb; } .mca .highlightedText4 { background: #ddd; }
.mca .noteText1 { margin-left: 8px; } .mca .noteText2 { margin-left: 16px; } .mca .noteText3 { margin-left: 24px; } .mca .noteText4 { margin-left: 32px; }
.mca .tableHeader { font-weight: bold; } .mca .numericValue, .mca .tableRowValue { text-align: right; }
@media print { .bar { display: none; } body { max-width: none; padding: 0; } }
</style></head><body>
<div class="bar"><button type="button" onclick="window.print()">Print / Save as PDF</button><span>Preview only — not the MCA rendering. In the print dialog choose “Save as PDF”.</span></div>
<div class="notice">${notice}</div>
<div class="doc-head"><b>${esc(company)}</b>${esc(title)}</div>
${sections.join('\n') || '<p>No facts to show.</p>'}
</body></html>`;
}
