// UI shell. Talks only to the Session controller; renders every statement and table from the
// authority model (no table-specific code).
import { Authority } from './authority.js';
import { Session } from './session.js';
import { Filing, dimKey, factKey } from './model.js';
import { dimensionallyValid } from './dimensions.js';
import { reportingYear } from './periods.js';
import { tableSlices } from './views.js';
import { buildExample } from './example.js';
// replaced by build.mjs with a content hash of the bundle; shown in the header and written into every generated XML
globalThis.MCA_BUILD_ID = '__BUILD_ID__';
const BUILD_ID = globalThis.MCA_BUILD_ID;
import { toMca, fromMca, plainText } from './richtext.js';
import { mandatoryCell } from './mandatory-marks.js';
import { explainMcaErrors } from './mca-errors.js';
import { memberInfo, sortSlices, missingParents, totalsHints, allTotalsHints } from './member-hints.js';
import { toDisplay } from './scaling.js';
import { carryForwardPlan, carryForward } from './carry-forward.js';
import { fillTotalsPlan, fillTotals } from './totals-fill.js';
import { additiveAxes } from './member-hints.js';
import { buildPreviewHtml } from './pdf-preview.js';
import { listFootnotes, footnotesOf, addFootnote, updateFootnoteText, unlinkFootnote, removeFootnote } from './footnotes.js';
import { Gate, htmlGuidelineIssues } from './gate.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STORE_KEY = 'mca-ci-xbrl.project.v1';

const A = new Authority(JSON.parse(document.getElementById('mca-authority').textContent));
let S = null;
const state = { colOrder: 'taxonomy', totals: [], view: { kind: 'setup' }, gate: null, xml: null, pending: {}, issueFilter: 'ERROR', toastTimer: null, example: false, calcOverride: {}, lastTab: null };
const GENERAL_LABEL = 'Disclosure of General Information about Company';

// ------------------------------------------------------------------ boot
function boot() {
  let restored = false;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { S = new Session(A, Filing.fromJSON(A, JSON.parse(raw))); restored = true; }
  } catch { S = null; }
  if (!S) { S = new Session(A); buildExample(S); state.example = true; }
  document.body.insertAdjacentHTML('beforeend', '<div class="modal" id="modal" hidden><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><h2 id="modal-title"></h2><button type="button" class="x" data-modal="cancel" aria-label="Close">×</button></header><div class="mbody" id="modal-body"></div><footer id="modal-foot"></footer></div></div>');
  wire();
  render();
  if (restored) toast('Restored your last project from this browser.');
}

let saveTimer = null;
function changed() {
  state.gate = null; state.xml = null;
  clearTimeout(saveTimer);
  state.saved = 'pending';
  saveTimer = setTimeout(saveLocal, 400);
  renderBar(); updateNav();
}
// autosave to this browser (unchanged behaviour); the bar shows when it last succeeded
function saveLocal() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S.filing.toJSON())); state.saved = new Date(); } catch { state.saved = 'failed'; /* storage unavailable: project file save still works */ }
  const el = $('#bar-save'); if (el) el.outerHTML = saveChip();
  return state.saved instanceof Date;
}
function saveChip() {
  const v = state.saved;
  if (v === 'pending') return '<span class="chip" id="bar-save" title="Changes are saved in this browser automatically">Saving…</span>';
  if (v === 'failed') return '<span class="chip warn" id="bar-save" title="This browser does not allow local storage here. Use Save project to keep a file.">Not saved in browser</span>';
  if (v instanceof Date) return `<span class="chip ok" id="bar-save" title="Saved in this browser automatically. Use Save project to download a project file.">Saved ${v.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
  return '';
}

// in-place nav refresh: rebuilding the nav while an input blurs would swallow the user's click
function updateNav() {
  for (const a of document.querySelectorAll('#nav a[data-elr]')) {
    const uri = a.dataset.elr;
    a.classList.toggle('na', !S.elrStatus(uri, 'CY').applicable);
    const d = a.querySelector('.dot'); if (d) d.className = 'dot ' + elrDot(uri);
  }
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.setAttribute('role', bad ? 'alert' : 'status'); t.hidden = false;
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
}

function download(name, text, mime) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch { toast('Download is blocked here — use Copy instead.', true); }
}

// ------------------------------------------------------------------ chrome
function render() { renderBar(); renderNav(); renderMain(); }

function renderBar() {
  const m = S.filing.meta;
  const g = state.gate;
  const where = g?.scope?.kind === 'tab' ? `Tab [${g.scope.code}]` : 'Internal gate';
  const gateChip = !g ? '<span class="chip">Internal gate · not run</span>' : g.ok ? `<span class="chip ok">${where} · pass</span>` : `<span class="chip bad">${where} · ${g.summary.errors} errors</span>`;
  const sm = document.querySelector('.brand small'); if (sm && !sm.dataset.build) { sm.dataset.build = BUILD_ID; sm.textContent = `MCA · TAXONOMY 2016 · BUILD ${BUILD_ID}`; sm.title = 'Tool build. After an update, press Ctrl+F5 (Cmd+Shift+R) if this does not change. Every generated XML names its build in its first comment.'; }
  $('#bar-who').innerHTML = `<b>${esc(m.name || 'Untitled filing')}${state.example ? ' <span class="chip warn">example data</span>' : ''}</b><span>${esc(m.cin || 'CIN not set')} · ${esc(m.reportType)} · FY ${esc(m.periods.cy.start || '?')} → ${esc(m.periods.cy.end || '?')}</span>`;
  $('#bar-status').innerHTML = `${saveChip()}${gateChip}<span class="chip" title="Official validation happens only in the MCA XBRL Validator V5.1, outside this app">MCA Validator V5.1 · not run</span>`;
}

function elrDot(uri) {
  const has = S.filing.all().some((f) => A.conceptElrs(f.concept).includes(uri));
  const err = state.gate && state.gate.issues.some((i) => i.severity === 'ERROR' && i.factKey && A.conceptElrs(S.filing.facts.get(i.factKey)?.concept || '').includes(uri));
  return err ? 'err' : has ? 'has' : '';
}

function renderNav() {
  const v = state.view;
  const groups = ['Statements', 'Notes', 'Disclosures'];
  const tool = (kind, label, extra = '') => `<a href="#" data-go="${kind}" class="${v.kind === kind ? 'on' : ''}" ${v.kind === kind ? 'aria-current="page"' : ''}><span>${label}</span>${extra}</a>`;
  let h = `<div class="tools"><h3>Filing</h3>${tool('setup', GENERAL_LABEL)}${tool('validate', 'Validation', state.gate ? `<span class="chip ${state.gate.ok ? 'ok' : 'bad'}">${state.gate.ok ? 'pass' : state.gate.summary.errors}</span>` : '')}${tool('xml', 'Generate XML')}${tool('import', 'Import report', S.filing.importReport ? '<span class="chip info">1</span>' : '')}${tool('coverage', 'Rule coverage')}${tool('footnotes', 'Footnotes', S.filing.footnotes.size ? `<span class="chip info">${S.filing.footnotes.size}</span>` : '')}${tool('mcaerrors', 'MCA error help')}</div>`;
  for (const g of groups) {
    h += `<h3>${g}</h3>`;
    for (const e of A.elrs.filter((x) => x.group === g)) {
      const st = S.elrStatus(e.uri, 'CY');
      const on = (v.kind === 'elr' && v.elr === e.uri) || (v.kind === 'table' && A.table(v.tableId)?.presentationElr === e.uri);
      h += `<a href="#" data-elr="${esc(e.uri)}" class="${on ? 'on' : ''} ${st.applicable ? '' : 'na'}" ${on ? 'aria-current="page"' : ''} title="${esc(st.applicable ? e.definition : st.reasons.join('\n'))}"><span class="code">${esc(e.code)}</span><span>${esc(e.title)}</span><span class="dot ${elrDot(e.uri)}"></span></a>`;
    }
  }
  $('#nav').innerHTML = h;
}

function renderMain({ keepScroll = false } = {}) {
  const v = state.view;
  const el = $('#main');
  const top = el.scrollTop;
  if (v.kind === 'setup') el.innerHTML = viewSetup();
  else if (v.kind === 'elr') el.innerHTML = viewElr(v.elr);
  else if (v.kind === 'table') el.innerHTML = viewTable(v.tableId, v.scope);
  else if (v.kind === 'validate') el.innerHTML = viewValidate();
  else if (v.kind === 'xml') el.innerHTML = viewXml();
  else if (v.kind === 'import') el.innerHTML = viewImport();
  else if (v.kind === 'import-confirm') el.innerHTML = viewImportConfirm();
  else if (v.kind === 'coverage') el.innerHTML = viewCoverage();
  else if (v.kind === 'mcaerrors') el.innerHTML = viewMcaErrors();
  else if (v.kind === 'footnotes') el.innerHTML = viewFootnotes();
  el.scrollTop = keepScroll ? top : 0;
  labelCells();
  markIssues();
  refreshTotals();
  markFootnotes();
}

// Accessible names for grid cells: "<row label> — <column heading>" (read from the rendered table; display only)
function labelCells() {
  for (const td of document.querySelectorAll('#main table.g td.val')) {
    const ctl = td.querySelector('.cellin, .tb-btn');
    if (!ctl || ctl.hasAttribute('aria-label')) continue;
    const tr = td.parentElement;
    const lbl = tr.querySelector('td.lbl')?.firstChild?.textContent?.trim() || '';
    const th = td.closest('table').tHead?.rows[0]?.cells[td.cellIndex];
    let col = '';
    if (th) col = th.classList.contains('slicehead') ? [...th.querySelectorAll('.m, input')].map((x) => x.value ?? x.textContent).join(' / ') : th.textContent.trim();
    if (!col) col = ctl.dataset.s === 'PY' ? 'previous year' : ctl.dataset.s === 'CY' ? 'current year' : '';
    ctl.setAttribute('aria-label', [lbl, col].filter(Boolean).join(' — '));
  }
}

// ------------------------------------------------------------------ validation marks on cells
// Issues carry a structured location (gate.locate): the cell id is the fact key (concept#period#dimensions),
// the same id every rendered cell carries in data-cell. Several issues on one cell aggregate.
function issueIndex() {
  const m = new Map();
  for (const i of state.gate?.issues || []) {
    const id = i.location?.cellId;
    if (!id || i.severity === 'INFO') continue;
    (m.get(id) || m.set(id, []).get(id)).push(i);
  }
  return m;
}
function markIssues() {
  const idx = issueIndex();
  for (const el of document.querySelectorAll('#main [data-cell]')) {
    const list = idx.get(el.dataset.cell) || [];
    const err = list.some((i) => i.severity === 'ERROR');
    el.classList.toggle('cell-err', err);
    el.classList.toggle('cell-warn', !err && list.length > 0);
    if (err) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    if (list.length) { el.dataset.issues = list.length; el.title = list.map((i) => `${i.severity}: ${i.message}`).join('\n'); }
    else delete el.dataset.issues;
  }
}
function navigateTo(loc) {
  if (!loc) { toast('This message is not tied to a single cell.'); return; }
  if (loc.kind === 'tab') { go({ kind: 'elr', elr: loc.elrUri }); toast('Opened the tab this message belongs to.'); return; }
  if (loc.kind === 'general') { go({ kind: 'setup' }); const f = loc.field && document.getElementById(loc.field); if (f) { f.scrollIntoView({ block: 'center' }); f.focus(); flash(f); } return; }
  const target = loc.tableId && loc.kind === 'cell' ? { kind: 'table', tableId: loc.tableId, scope: loc.scope } : loc.elrUri ? { kind: 'elr', elr: loc.elrUri } : null;
  if (target && !guardLeave(target, () => navigateTo(loc))) return;
  if (target) { state.leaveOk = true; go(target); }
  else { toast('No filing tab holds this element.', true); return; }
  let el = document.querySelector(`#main [data-cell="${CSS.escape(loc.cellId)}"]`);
  // a table cell whose column is not in the table yet: add the column (the "Add row" check) and show the cell
  if (!el && target?.kind === 'table') {
    try {
      const nd = S.validateSlice(loc.tableId, loc.dims || []);
      if (!slicesFor(loc.tableId, loc.scope).some((d) => dimKey(d) === dimKey(nd))) (state.pending[loc.tableId + loc.scope] ||= []).push(nd);
      renderMain({ keepScroll: true });
      el = document.querySelector(`#main [data-cell="${CSS.escape(loc.cellId)}"]`);
    } catch { /* not addable: reported below */ }
  }
  if (!el) { toast('The cell is not shown on this tab (row not entered yet).', true); return; }
  el.scrollIntoView({ block: 'center' });
  try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
  flash(el);
  if (el.readOnly && el.classList.contains('calc')) toast('This cell is calculated from its parts (the cells that add up to it in this column, or gross − accumulated for a carrying amount). Correct those parts — or tick "Allow editing of calculated cells" to enter your own figure.');
}
// navigate to an element named in an MCA message: its first entered cell, else its tab
function goConcept(q) {
  const f = S.filing.factsOf(q).find((x) => !x.nil) || S.filing.factsOf(q)[0];
  const g = new Gate(A);
  const loc = f ? g.locate(S.filing, { factKey: f.key }) : g.locate(S.filing, { concept: q, scope: 'CY' });
  if (loc) return navigateTo(loc);
  const elr = A.conceptElrs(q)[0];
  if (elr) return go({ kind: 'elr', elr });
  toast('No filing tab holds this element.', true);
}
// ---- footnotes (footnotes.js; stored in the filing's existing footnote store, generated as link:footnoteLink)
const previewName = () => `${(S.filing.meta.cin || S.filing.meta.name || 'filing').replace(/[^\w.-]+/g, '_')}_preview.html`;
function cellText(f) {
  const y = reportingYear(S.filing.meta.periods, f.period);
  const dims = f.dims.map((d) => (d.member ? shortLabel(d.member) : d.typed)).join(' / ');
  return `${A.label(f.concept)} · ${y === 'CY' ? 'current year' : y === 'PY' ? 'previous year' : y}${dims ? ' · ' + dims : ''}`;
}
function markFootnotes() {
  const by = new Map();
  for (const fn of S.filing.footnotes.values()) for (const k of fn.factKeys) (by.get(k) || by.set(k, []).get(k)).push(fn.id);
  for (const el of document.querySelectorAll('#main td.val [data-cell]')) {
    const ids = by.get(el.dataset.cell);
    const td = el.closest('td');
    td.classList.toggle('has-fn', !!ids);
    if (ids) td.dataset.fn = ids.join(', '); else delete td.dataset.fn;
  }
}
function openFootnoteDialog(cellId) {
  const f = cellId && S.filing.facts.get(cellId);
  if (!f || f.nil) { toast('Select a cell that has a value first (click it), then press Alt+N or “Footnote…”.', true); return; }
  const linked = footnotesOf(S.filing, f.key);
  const others = listFootnotes(S.filing).filter((x) => !linked.includes(x.id));
  const short = (t) => (t.length > 70 ? t.slice(0, 70) + '…' : t);
  openModal('Footnote', `<p class="note">${esc(cellText(f))}</p>
    ${linked.length ? `<p><b>Footnotes on this cell</b></p><ul class="fn-list">${linked.map((id) => `<li><span class="chip info">${esc(id)}</span> ${esc(short(S.filing.footnotes.get(id).text))} <button type="button" class="btn small" data-fn-unlink="${esc(id)}" data-fn-key="${esc(f.key)}">Remove from this cell</button></li>`).join('')}</ul>` : ''}
    <p><label><b>New footnote</b><br><textarea id="fn-text" rows="4" style="width:100%" placeholder="Footnote text (plain text, written with xml:lang=&quot;en&quot;)"></textarea></label></p>
    ${others.length ? `<p><label><b>or reuse the text of an existing footnote</b> <span class="note">(a separate footnote for this cell — one footnote per cell, as in MCA-validated filings)</span><br><select id="fn-existing" style="width:100%"><option value="">—</option>${others.map((x) => `<option value="${esc(x.id)}">${esc(x.id)}: ${esc(short(x.text))}</option>`).join('')}</select></label></p>` : ''}`,
    '<button type="button" class="btn" data-modal="cancel" id="fn-cancel">Cancel</button><button type="button" class="btn primary" data-modal="save" id="fn-save">Save footnote</button>',
    { kind: 'footnote', key: f.key });
  setTimeout(() => $('#fn-text')?.focus(), 0);
}
function viewFootnotes() {
  const list = listFootnotes(S.filing);
  return `<div class="sheet"><header><h1>Footnotes</h1></header>
    <p class="note">A footnote is attached to one or more cells (element × members × year). To add one: click a cell that has a value on any tab, then press <b>Alt+N</b> or click <b>Footnote…</b> in the tab tools. Cells with footnotes show a small <span class="fn-mark">fn</span> mark. Footnotes are written to the XML as XBRL footnote links (xml:lang="en") for the cells that are generated; a footnote with no cell is kept here but not generated.</p>
    ${list.length ? list.map((fn) => `<div class="fn-card"><div class="fn-head"><span class="chip info">${esc(fn.id)}</span>${fn.facts.length ? `<span class="note">${fn.facts.length} cell(s)</span>` : '<span class="chip warn">no cell — not generated</span>'}<button type="button" class="btn small danger" data-act="fn-delete" data-fn="${esc(fn.id)}">Delete</button></div>
      <textarea class="fn-edit" data-fn-text="${esc(fn.id)}" rows="3" aria-label="Text of footnote ${esc(fn.id)}">${esc(fn.text)}</textarea>
      <ul class="fn-list">${fn.facts.map((f) => `<li><button type="button" class="btn small" data-fn-go="${esc(f.key)}">Go</button> ${esc(cellText(f))} <button type="button" class="btn small" data-fn-unlink="${esc(fn.id)}" data-fn-key="${esc(f.key)}" title="Remove the footnote from this cell">✕</button></li>`).join('')}</ul></div>`).join('') : '<p>No footnotes yet.</p>'}</div>`;
}

// ---- carry previous-year columns (and optionally values) into the current-year table (carry-forward.js)
function carryButton(tableId) {
  const plan = carryForwardPlan(S, tableId);
  const title = plan.available ? `${plan.columns.length} previous-year column(s), ${plan.newColumns.length} not yet in the current year; ${plan.values} value(s) could fill empty current-year cells` : plan.reason;
  return `<button class="btn small" data-act="carry-forward" data-t="${esc(tableId)}" ${plan.available ? '' : 'disabled'} title="${esc(title)}">Copy from previous year</button>`;
}

// "Fill empty totals from parts" (totals-fill.js): explicit action, empty total cells only, on the axes MCA adds up
function fillButton(tableId, scope) {
  const t = A.table(tableId);
  const add = additiveAxes(A);
  if (!t.axes.some((ax) => !ax.typed && add.has(ax.axis))) return '';
  let n = 0;
  try { n = fillTotalsPlan(S, tableId, scope).length; } catch { n = 0; }
  return `<button class="btn small" data-act="fill-totals" data-t="${esc(tableId)}" data-s="${scope}" ${n ? '' : 'disabled'} title="${esc(n ? `${n} empty total cell(s) can be filled with the sum of their part columns (total column and parent-member columns, on the axes the MCA rules add up). Existing values are never changed.` : 'No empty total cell has part values to add up.')}">Fill empty totals${n ? ` (${n})` : ''}</button>`;
}

// ---- parent/child (total/part) guidance on dimensional tables (member-hints.js; display only)
const shortLabel = (q) => A.label(q).replace(/ \[Member\]$/, '');
function memberTitle(mi) {
  const parts = [];
  if (mi.isDefault) parts.push('Default member: the total of this axis (reported without the axis).');
  if (mi.children.length) parts.push(`Total of: ${mi.children.slice(0, 8).map(shortLabel).join(', ')}${mi.children.length > 8 ? ` (+${mi.children.length - 8} more)` : ''}.`);
  if (mi.path.length) parts.push(`Part of: ${mi.path.map(shortLabel).join(' › ')}.`);
  return parts.join(' ');
}
function axisHelp(tax, member) {
  if (!tax || tax.typed) return '';
  const m = member || A.dimensionDefault(tax.axis);
  if (!m) return '';
  const mi = memberInfo(A, tax, m);
  const name = shortLabel(m);
  if (!member) return `${name} (default) is the total of this axis.`;
  const req = requiredParentOf(state.view.tableId, tax.axis, m);
  let t = mi.isTotal ? `${name} is a TOTAL of ${mi.children.length} member(s): ${mi.children.slice(0, 5).map(shortLabel).join(', ')}${mi.children.length > 5 ? ', …' : ''}. Its value should equal the sum of the parts you report.` : `${name} is a part.`;
  if (mi.path.length) t += ` It is included in ${mi.path.map(shortLabel).join(' › ')}.`;
  if (req) t += ` GR-3: when it has values, the ${shortLabel(req)} column is required too.`;
  return t;
}
function colName(dims, tableId = state.view.tableId) {
  return A.table(tableId).axes.map((ax) => { const d = dims.find((x) => x.axis === ax.axis); return d ? (d.member ? shortLabel(d.member) : d.typed) : A.dimensionDefault(ax.axis) ? shortLabel(A.dimensionDefault(ax.axis)) : '—'; }).join(' / ');
}
const fmtAmt = (q, v) => (A.dataType(q) === 'monetary' ? toDisplay(v, S.filing.meta.level) : String(v));
// the line under each total cell: equals its parts ✓, or the parts total and the difference
function refreshTotals() {
  const v = state.view;
  const slots = document.querySelectorAll('#main .sum-hint[data-sumfor]');
  if (v.kind !== 'table' || !slots.length) { state.totals = []; return; }
  let hints = [];
  try { hints = totalsHints(S, v.tableId, v.scope, state.slices || [], { includeMatches: true }); } catch { hints = []; }
  state.totals = hints;
  const by = new Map(hints.map((h) => [h.cellId, h]));
  for (const el of slots) {
    const h = by.get(el.dataset.sumfor);
    const input = el.parentElement.querySelector('.cellin');
    input?.classList.toggle('sum-off', !!h && !h.ok);
    if (!h) { el.innerHTML = ''; continue; }
    const parts = h.children.map((c) => shortLabel(c.member)).join(' + ');
    if (h.ok) { el.innerHTML = `<span class="ok" title="${esc(`Equals the sum of: ${parts}`)}">= parts ✓</span>`; continue; }
    el.innerHTML = `<span title="${esc(`Sum of: ${parts}${h.missingChildren.length ? ` — not in the table: ${h.missingChildren.slice(0, 6).map(shortLabel).join(', ')}` : ''}. Tool guidance, not an MCA rule.`)}">Parts ${esc(fmtAmt(h.concept, h.childrenSum))} · differs by ${esc(fmtAmt(h.concept, h.difference))}</span> <button type="button" class="btn small" data-act="use-sum" data-sumcell="${esc(h.cellId)}" title="Enter the sum of the part columns in this total cell">Use parts total</button>`;
  }
}
function requiredParentOf(tableId, axis, member) {
  const dims = [{ axis, member }];
  return missingParents(A, tableId, [dims])[0]?.parents[0]?.member || null;
}

// Keyboard movement in the grids: Enter / Shift+Enter (and ↑/↓ in text cells) move to the same column of the
// next / previous row that has an editable cell. The value is committed by the normal change event on leaving.
function gridKeys(ev) {
  const el = ev.target;
  if (ev.altKey || ev.ctrlKey || ev.metaKey || !el.closest?.('#main table.g td.val')) return false;
  const isBtn = el.classList.contains('tb-btn');
  const isText = el.matches('input.cellin:not([type="date"])');
  if (!el.matches('.cellin, .tb-btn')) return false;
  let dir = 0;
  if (ev.key === 'Enter' && !isBtn) dir = ev.shiftKey ? -1 : 1;
  else if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && (isText || isBtn) && !ev.shiftKey) dir = ev.key === 'ArrowDown' ? 1 : -1;
  if (!dir) return false;
  const td = el.closest('td');
  const rows = [...td.closest('tbody').rows];
  for (let r = rows.indexOf(td.parentElement) + dir; r >= 0 && r < rows.length; r += dir) {
    const next = rows[r].cells[td.cellIndex]?.querySelector('.cellin:not([disabled]):not([readonly]), .tb-btn:not([disabled])');
    if (!next || !next.closest('td.val')) continue;
    ev.preventDefault();
    const id = next.dataset.cell;
    next.focus();
    if (next.select && next.tagName === 'INPUT') next.select();
    // a Yes/No or list answer re-renders the sheet on change: focus the same cell again in the new rendering
    setTimeout(() => { if (!document.contains(next) && id) document.querySelector(`#main [data-cell="${CSS.escape(id)}"]`)?.focus(); }, 0);
    return true;
  }
  if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); el.focus(); } // last row: commit in place
  return true;
}
// Modal keyboard: Tab stays inside the dialog; Ctrl+Enter saves a text block
function modalKeys(ev) {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && modalState?.kind === 'textblock') { ev.preventDefault(); modalAction('save'); return; }
  if (ev.key !== 'Tab') return;
  const f = [...document.querySelectorAll('#modal .dlg button:not([disabled]), #modal .dlg select, #modal .dlg [contenteditable="true"], #modal .dlg input, #modal .dlg a[href]')].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  if (ev.shiftKey && i <= 0) { ev.preventDefault(); f[f.length - 1].focus(); }
  else if (!ev.shiftKey && i === f.length - 1) { ev.preventDefault(); f[0].focus(); }
}
function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

function go(view) {
  if (!guardLeave(view, () => go(view))) return false;
  state.leaveOk = false;
  state.view = view; $('#nav').classList.remove('open'); renderNav(); renderMain();
  return true;
}
// Leaving a dimensional table whose total columns differ from the sum of their part columns: ask first
// (tool guidance — values are already saved; "Continue anyway" always proceeds).
function guardLeave(next, retry) {
  const v = state.view;
  if (state.leaveOk || v.kind !== 'table' || !$('#modal').hidden) return true;
  if (next && next.kind === 'table' && next.tableId === v.tableId && next.scope === v.scope) return true;
  let hints = [];
  try { hints = totalsHints(S, v.tableId, v.scope, slicesFor(v.tableId, v.scope)); } catch { return true; }
  if (!hints.length) return true;
  const items = hints.slice(0, 8).map((h) => `<li>${esc(A.label(h.concept))} — <b>${esc(colName(h.parentDims))}</b>: ${esc(fmtAmt(h.concept, h.parentValue))} vs parts ${esc(fmtAmt(h.concept, h.childrenSum))}</li>`).join('');
  confirmDialog('Totals do not match', `${hints.length} total cell(s) on this table differ from the sum of their part columns:<ul class="hint-list">${items}</ul>${hints.length > 8 ? `<p>… and ${hints.length - 8} more (see Validation → Totals hints).</p>` : ''}<p class="note">Tool guidance, not an MCA rule. Your values are already saved; nothing is changed.</p>`,
    () => { state.leaveOk = true; retry(); }, null, { cancel: 'Stay and fix', ok: 'Continue anyway' });
  return false;
}

// ------------------------------------------------------------------ cells
// cell = { id: fact key of the cell, calculated: bool, locked: bool }
function inputFor(concept, fact, attrs, disabled, title, cell = {}) {
  const t = A.dataType(concept);
  const val = fact ? S.displayOf(fact) : '';
  if (cell.id) attrs += ` data-cell="${esc(cell.id)}"`;
  const ro = cell.locked && !disabled;
  const req = cell.req?.mandatory && !disabled;
  if (req) attrs += ` data-req="${esc(cell.req.rules.join(' '))}" aria-required="true"`;
  const reqCls = req ? ` req${fact && !fact.nil ? '' : ' req-empty'}` : '';
  const cls = `cellin${A.isNumeric(concept) ? ' num' : ''}${cell.calculated ? ' calc' : ''}${cell.calculated && !cell.locked ? ' calc-open' : ''}${reqCls}`;
  if (req && !title) title = `Mandatory (${cell.req.rules.join(', ')})`;
  const common = `class="${cls}" ${attrs} ${disabled ? 'disabled' : ''} ${ro ? 'readonly aria-readonly="true"' : ''} title="${esc(title || (ro ? 'Calculated from its child elements (taxonomy calculation) — use the tab option to edit calculated cells' : ''))}"`;
  if (t === 'boolean') return `<select ${common}><option value=""></option><option value="true" ${val === 'true' ? 'selected' : ''}>Yes (true)</option><option value="false" ${val === 'false' ? 'selected' : ''}>No (false)</option></select>`;
  if (t === 'enum') return `<select ${common}><option value=""></option>${A.enumerations(concept).map((o) => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  if (t === 'date') return `<input type="date" ${common} value="${esc(val)}">`;
  if (t === 'textBlock') return textBlockButton(concept, fact, attrs, disabled, title, reqCls);
  return `<input type="text" ${A.isNumeric(concept) ? 'inputmode="decimal"' : ''} ${common} value="${esc(val)}">`;
}
// Rich-text editor for narrative (text block) facts: content is stored as MCA-compliant markup (richtext.js)
// Text block cell: a compact button; the editor opens in a modal (openTextBlock). The stored value is the same
// MCA-compliant markup as before (richtext.js).
function textBlockButton(concept, fact, attrs, disabled, title, extraCls = '') {
  const text = fact && !fact.nil ? plainText(fact.value) : '';
  const preview = text ? esc(text.length > 70 ? text.slice(0, 70) + '…' : text) : '<span class="muted">empty</span>';
  return `<div class="tbcell"><button type="button" class="btn small tb-btn${text ? ' has' : ''}${extraCls}" data-textblock ${attrs} ${disabled ? 'disabled' : ''} title="${esc(title || 'Edit text block')}">Text Block</button><span class="tb-prev">${preview}</span></div>`;
}
const RTE_BUTTONS = [['bold', 'B', 'Bold'], ['italic', 'I', 'Italic'], ['underline', 'U', 'Underline'], ['insertOrderedList', '1.', 'Numbered list'], ['insertUnorderedList', '•', 'Bulleted list'], ['indent', '⇥', 'Indent'], ['outdent', '⇤', 'Outdent'], ['removeFormat', 'Tx', 'Clear formatting'], ['tableBorders', '▦', 'Table borders on/off (table at the cursor)']];
// MCA conversion options for the current filing (richtext.js toMca)
const rteOpts = (extra = {}) => ({ emphasis: S.filing.meta.textEmphasis === 'none' ? 'none' : 'highlight', ...extra });
// toggle class="bordered" on every cell of the table at the cursor
function toggleTableBorders(body) {
  const sel = window.getSelection();
  const node = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null;
  const table = node?.closest?.('table');
  if (!table || !body.contains(table)) { toast('Place the cursor inside a table first.', true); return; }
  const cells = [...table.querySelectorAll('td, th')];
  const on = !cells.every((c) => c.classList.contains('bordered'));
  for (const c of cells) { c.classList.toggle('bordered', on); c.classList.toggle('unbordered', !on); }
  toast(on ? 'Table borders on (class="bordered").' : 'Table borders off (class="unbordered").');
}

const typeTag = (q) => {
  const t = A.dataType(q);
  if (t === 'monetary') return S.filing.meta.level === 'Actual' ? 'INR' : `INR ${S.filing.meta.level.toLowerCase()}`;
  return { shares: 'shares', perShare: 'INR/share', percent: '0–1 (pure)', decimal: 'number', pure: 'pure', date: 'date', boolean: 'yes/no', enum: 'list', textBlock: 'text block', string: 'text', token: 'text' }[t] || t;
};

// ------------------------------------------------------------------ views
// Disclosure of General Information about Company: the company/filer facts the filing needs, mapped to their
// taxonomy concepts (meta fields are mirrored into the [400100] facts by Session.setMeta), the cash-flow method
// (TypeOfCashFlowStatement), and every other [400100] element below.
const META_MIRRORED = ['NameOfCompany', 'CorporateIdentityNumber', 'NatureOfReportStandaloneConsolidated', 'LevelOfRoundingUsedInFinancialStatements', 'DateOfStartOfReportingPeriod', 'DateOfEndOfReportingPeriod', 'TypeOfCashFlowStatement'];
function viewSetup() {
  const m = S.filing.meta;
  const levels = A.enumerations(A.qnameOfLocal('LevelOfRoundingUsedInFinancialStatements'));
  const qName = A.qnameOfLocal('NameOfCompany');
  const companyName = S.getValue(qName, 'CY')?.value ?? m.name;
  const qCf = A.qnameOfLocal('TypeOfCashFlowStatement');
  const cf = S.getValue(qCf, 'CY')?.value || '';
  const gi = A.elrByCode('400100');
  const cfOpt = (v, label) => `<label class="choice inline${cf === v ? ' on' : ''}"><input type="radio" name="cashflow" id="cf-${v.startsWith('Direct') ? 'direct' : 'indirect'}" value="${esc(v)}" ${cf === v ? 'checked' : ''}><span><b>${label}</b><span class="note">${v.startsWith('Direct') ? '[100300] enabled · [100400] disabled' : '[100400] enabled · [100300] disabled'}</span></span></label>`;
  return `<div class="sheet"><header><h1 id="general-title">${GENERAL_LABEL}</h1><span class="note">[400100] · C&amp;I Taxonomy 2016 · schemaRef ${esc(A.meta.schemaRef)}</span></header>
  ${state.example ? '<div class="banner warn">This is an <b>example filing</b> (a company holding one current investment) so you can see how the sheets work. Use <b>New filing</b> to start your own, or <b>Import XML</b> to load an existing instance.</div>' : ''}
  <form class="form" id="setup" autocomplete="off">
    <h2 class="wide">Company identity</h2>
    <label class="wide">Name of company <span class="el">in-ca:NameOfCompany</span><input id="f-name" name="name" value="${esc(companyName)}"></label>
    <label>Corporate identity number (CIN) <span class="el">in-ca:CorporateIdentityNumber · entity identifier</span><input id="f-cin" name="cin" value="${esc(m.cin)}" maxlength="21" placeholder="U72200KA2010PTC123456" style="font-family:var(--f-data)"></label>
    <label>Nature of report <span class="el">NatureOfReportStandaloneConsolidated</span><select id="f-rt" name="reportType">${['Standalone', 'Consolidated'].map((x) => `<option ${x === m.reportType ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <h2 class="wide">Reporting period</h2>
    <label>Date of start of reporting period <span class="el">DateOfStartOfReportingPeriod</span><input id="f-cys" type="date" name="cy.start" value="${esc(m.periods.cy.start)}"></label>
    <label>Date of end of reporting period <span class="el">DateOfEndOfReportingPeriod</span><input id="f-cye" type="date" name="cy.end" value="${esc(m.periods.cy.end)}"></label>
    <label>Previous year — start<input id="f-pys" type="date" name="py.start" value="${esc(m.periods.py.start)}" ${m.firstFinancialYear ? 'disabled' : ''}></label>
    <label>Previous year — end<input id="f-pye" type="date" name="py.end" value="${esc(m.periods.py.end)}" ${m.firstFinancialYear ? 'disabled' : ''}></label>
    <label class="chk wide"><input id="f-first" type="checkbox" name="firstFinancialYear" ${m.firstFinancialYear ? 'checked' : ''}> First financial year of the company (no previous-year figures)</label>
    <h2 class="wide">Presentation of the financial statements</h2>
    <label>Level of rounding used in financial statements <span class="el">LevelOfRoundingUsedInFinancialStatements</span><select id="f-lvl" name="level">${levels.map((x) => `<option ${x === m.level ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label>Decimal places as presented<select id="f-dp" name="displayPlaces">${[0, 1, 2, 3].map((x) => `<option ${x === Number(m.displayPlaces) ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <div class="wide"><button class="btn primary" type="submit">Apply</button></div>
  </form>
  <h2>Cash flow statement method <span class="el">in-ca:TypeOfCashFlowStatement</span></h2>
  <div class="choices row" id="cashflow">${cfOpt('Direct Method', 'Direct method')}${cfOpt('Indirect Method', 'Indirect method')}</div>
  ${cf ? '' : '<p class="note">Not selected: both cash-flow statements stay open until a method is chosen.</p>'}
  <h2>Other general information</h2>
  <p class="note">All other elements of [400100] ${esc(gi.title)}. Elements set above are shown read-only here.</p>
  ${elrGrid(gi.uri, { readonly: new Set(META_MIRRORED.map((l) => A.qnameOfLocal(l))) })}
  <h2>How values are stored</h2>
  <p class="note">Monetary values are typed in the chosen scale (for example <b>Lakhs</b>) and stored as exact rupee amounts. The XML always carries the unscaled amount with a <code>decimals</code> attribute that matches the presented accuracy (Lakhs with 2 places → <code>decimals="-3"</code>). Shares, per-share amounts and percentages are never scaled; percentages are entered as fractions (60% → 0.6).</p>
  <h2>Authority</h2>
  <p class="note">${Object.keys(A.concepts).length.toLocaleString('en-IN')} concepts · ${A.elrs.length} ELRs · ${A.tables.length} tables · ${A.meta.relationshipStats.notAll} notAll · ${A.meta.relationshipStats.dimensionDefault} defaults · ${A.meta.relationshipStats.calculationArcs} calculation arcs · authority ${esc(A.meta.authorityHash.slice(0, 12))}</p></div>`;
}

// "Mandatory" label of a row: per year, from the compiled business rules (mandatory-marks.js)
function reqChip(marks) {
  const on = marks.filter(([, m]) => m.mandatory);
  if (!on.length) return '';
  const years = on.length === marks.length ? '' : ' · ' + on.map(([s]) => s).join('/');
  const rules = [...new Set(on.flatMap(([, m]) => m.rules))];
  const cond = on.some(([, m]) => m.conditional);
  return ` <span class="req-chip${cond ? ' cond' : ''}" title="${esc((cond ? 'Mandatory because its condition is met' : 'Mandatory') + ' — ' + rules.join(', '))}">Mandatory${years}</span>`;
}

function tabTools(tabKey, elrUri) {
  return `<span class="tabtools"><label class="chk small"><input type="checkbox" data-calc-override="${esc(tabKey)}" ${state.calcOverride[tabKey] ? 'checked' : ''}> Allow editing of calculated cells</label>
    <button class="btn small" data-act="footnote-cell" title="Add or edit a footnote for the last selected cell (Alt+N)">Footnote…</button><button class="btn small" data-act="validate-tab" data-tab="${esc(elrUri)}">Validate current tab</button><button class="btn small" data-act="validate">Validate entire filing</button></span>`;
}

function elrGrid(uri, { readonly = null } = {}) {
  const view = S.elrView(uri);
  const scopes = ['CY', 'PY'];
  const st = Object.fromEntries(scopes.map((s) => [s, S.elrStatus(uri, s)]));
  let rows = '';
  for (const r of view.rows) {
    const pad = `padding-left:${8 + r.depth * 14}px`;
    if (r.kind === 'header') { rows += `<tr class="hdr"><td class="lbl" style="${pad}" colspan="4">${esc(r.label)}</td></tr>`; continue; }
    if (r.kind === 'table') {
      const tst = scopes.map((s) => [s, S.tableStatus(r.tableId, s)]);
      const t = A.table(r.tableId);
      const cnt = (s) => tableSlices(A, S.filing, r.tableId, s, reportingYear).length;
      rows += `<tr><td colspan="4" style="${pad}"><div class="tcard"><div class="t"><b>${esc(r.label)}</b><span>${esc(t.hypercube)} · ${t.axes.length ? t.axes.map((a) => esc(A.label(a.axis)) + (a.typed ? ' (typed)' : '')).join(' × ') : 'no axes (totals)'} · ${t.lineItems.length} line items</span>
        ${tst.some(([, x]) => !x.applicable) ? `<div class="reasons">${tst.filter(([, x]) => !x.applicable).map(([s, x]) => `${s}: ${esc(x.reasons.join('; '))}`).join('<br>')}</div>` : ''}</div>
        <div class="scopes">${tst.map(([s, x]) => `<button class="btn small ${x.applicable ? (x.mandatory ? 'primary' : '') : ''}" data-open-table="${esc(r.tableId)}" data-scope="${s}" data-cell="table:${esc(r.tableId)}:${s}" ${x.applicable ? '' : 'disabled'} title="${esc(x.reasons.join('\n'))}">${s === 'CY' ? 'Current' : 'Previous'}${t.axes.length ? ` · ${cnt(s)} rows` : ''}${x.mandatory ? ' · required' : ''}</button>`).join('')}</div></div></td></tr>`;
      continue;
    }
    const marks = [];
    const cells = scopes.map((s) => {
      // one applicability decision for this tab's cell (cash-flow method, PY exclusions, Yes/No dependencies)
      const cs = S.cellStatus(uri, r.concept, s);
      const dis = !cs.applicable || (s === 'PY' && S.filing.meta.firstFinancialYear) || (readonly && readonly.has(r.concept));
      const fact = cs.applicable ? S.getValue(r.concept, s, [], r.preferredLabel) : null; // never show a value in a non-applicable cell
      const p = S.periodForCell(r.concept, s, r.preferredLabel);
      const calc = !dis && A.isNumeric(r.concept) && S.calculatedCell(r.concept, s, [], uri, r.preferredLabel);
      const reasons = !cs.applicable ? cs.reasons.join('\n') : readonly && readonly.has(r.concept) ? 'Set in the company information form above' : '';
      const req = !dis || (readonly && readonly.has(r.concept) && cs.applicable) ? mandatoryCell(S, r.concept, s, []) : { mandatory: false, rules: [] };
      marks.push([s, req]);
      return `<td class="val">${inputFor(r.concept, fact, `data-c="${esc(r.concept)}" data-s="${s}" data-pl="${esc(r.preferredLabel || '')}" data-tab="${esc(uri)}"`, dis, reasons, { id: p ? factKey(r.concept, p, []) : null, calculated: !!calc, locked: !!calc && !state.calcOverride[uri], req })}</td>`;
    }).join('');
    rows += `<tr><td class="lbl" style="${pad}">${esc(r.label)}${reqChip(marks)}<span class="el">${esc(r.concept)}</span></td><td class="typ">${esc(typeTag(r.concept))}${r.preferredLabel === 'periodStartLabel' ? ' · opening' : r.preferredLabel === 'periodEndLabel' ? ' · closing' : ''}</td>${cells}</tr>`;
  }
  const P = S.filing.meta.periods;
  return `<div class="grid-wrap"><table class="g"><thead><tr><th>Element</th><th>Type</th><th>Current ${esc(P.cy.end)}</th><th>Previous ${esc(P.py.end)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function viewElr(uri) {
  const e = A.elr(uri);
  state.lastTab = uri;
  const st = Object.fromEntries(['CY', 'PY'].map((s) => [s, S.elrStatus(uri, s)]));
  const off = !st.CY.applicable;
  return `<div class="sheet${off ? ' tab-off' : ''}"><header><h1><span class="code">[${esc(e.code)}]</span>${esc(e.title)}</h1>
    ${['CY', 'PY'].map((s) => st[s].applicable ? '' : `<span class="chip warn" title="${esc(st[s].reasons.join('\n'))}">${s} not applicable</span>`).join('')}
    ${off ? '' : tabTools(uri, uri)}</header>
    ${off ? `<div class="banner warn">This statement is not part of this filing: ${esc(st.CY.reasons.join('; '))}. Its cells are unavailable and generate no facts.</div>` : ''}
    ${elrGrid(uri)}</div>`;
}

function slicesFor(tableId, scope) {
  const existing = tableSlices(A, S.filing, tableId, scope, reportingYear);
  const pend = (state.pending[tableId + scope] || []).filter((p) => !existing.some((e) => dimKey(e) === dimKey(p)));
  // the table's total column is offered when the other year reports it (last year's layout)
  if (!existing.some((d) => !d.length) && !pend.some((d) => !d.length)) {
    const other = scope === 'CY' ? 'PY' : 'CY';
    if (S.tableStatus(tableId, other).applicable && tableSlices(A, S.filing, tableId, other, reportingYear).some((d) => !d.length)) return [[], ...existing, ...pend];
  }
  return [...existing, ...pend];
}

function viewTable(tableId, scope) {
  const st = S.tableStatus(tableId, scope);
  let opened;
  try { opened = S.openTable(tableId, scope); } catch (e) {
    return `<div class="sheet"><div class="banner bad"><b>This table is not available for ${scope === 'CY' ? 'the current' : 'the previous'} year.</b><br>${esc((e.reasons || [e.message]).join('; '))}</div><button class="btn" data-elr="${esc(A.table(tableId).presentationElr)}">Back to note</button></div>`;
  }
  const v = opened.view;
  state.lastTab = v.presentationElr;
  const P = S.filing.meta.periods;
  const other = scope === 'CY' ? 'PY' : 'CY';
  const otherOk = S.tableStatus(tableId, other).applicable;
  const head = `<header><h1><span class="code">[${esc(v.code)}]</span>${esc(v.title)}</h1>
    <span class="chip info">${scope === 'CY' ? `Current · ${esc(P.cy.end)}` : `Previous · ${esc(P.py.end)}`}</span>
    ${st.mandatory ? '<span class="chip warn">required</span>' : ''}
    <button class="btn small" data-open-table="${esc(tableId)}" data-scope="${other}" ${otherOk ? '' : 'disabled'}>Switch to ${other === 'CY' ? 'current' : 'previous'} year</button>
    <button class="btn small" data-elr="${esc(v.presentationElr)}">Back to note</button>${scope === 'CY' && v.axes.length ? carryButton(tableId) : ''}${v.axes.length ? fillButton(tableId, scope) : ''}${tabTools(tableId, v.presentationElr)}</header>
    <p class="note">${esc(v.hypercube)} · ${v.closed ? 'closed' : 'open'} hypercube · ELR ${esc(A.json.roles[v.elr]?.definition || v.elr)}${v.notAll.length ? ` · ${v.notAll.length} notAll exclusions applied` : ''}</p>`;
  if (!v.axes.length) {
    const rows = v.lineItems.filter((l) => !l.abstract).map((l) => {
      const cs = S.cellStatus(v.presentationElr, l.concept, scope);
      const fact = cs.applicable ? S.getValue(l.concept, scope, [], l.preferredLabel) : null;
      const p = S.periodForCell(l.concept, scope, l.preferredLabel);
      const calc = cs.applicable && A.isNumeric(l.concept) && S.calculatedCell(l.concept, scope, [], v.presentationElr, l.preferredLabel);
      const req = cs.applicable ? mandatoryCell(S, l.concept, scope, [], tableId) : { mandatory: false, rules: [] };
      return `<tr><td class="lbl">${esc(l.label)}${reqChip([[scope, req]])}<span class="el">${esc(l.concept)}</span></td><td class="typ">${esc(typeTag(l.concept))}</td><td class="val">${inputFor(l.concept, fact, `data-c="${esc(l.concept)}" data-s="${scope}" data-pl="${esc(l.preferredLabel || '')}" data-tab="${esc(v.presentationElr)}" data-tabkey="${esc(tableId)}"`, !cs.applicable, cs.reasons.join('\n'), { id: p ? factKey(l.concept, p, []) : null, calculated: !!calc, locked: !!calc && !state.calcOverride[tableId], req })}</td></tr>`;
    }).join('');
    return `<div class="sheet">${head}<p class="note">This table has no axes: its line items are reported without dimensions.</p><div class="grid-wrap"><table class="g"><tbody>${rows}</tbody></table></div></div>`;
  }
  // add-row form
  const pickers = v.axes.map((ax, i) => {
    if (ax.typed) return `<label>${esc(ax.label)} <span class="el">typed · ${esc(ax.typedDomain)}</span><input id="ax-${i}" data-axis="${esc(ax.axis)}" value="${esc(S.suggestTypedValue(tableId, scope, ax.axis))}"></label>`;
    const tax = A.table(tableId).axes.find((a) => a.axis === ax.axis);
    const opts = ax.members.filter((m) => m.usable && !m.isDefault).map((m) => {
      const mi = memberInfo(A, tax, m.member);
      return `<option value="${esc(m.member)}" title="${esc(memberTitle(mi))}">${'  '.repeat(Math.max(0, m.depth))}${esc(m.label)}${mi.isTotal ? ' — total' : ''}</option>`;
    }).join('');
    return `<label>${esc(ax.label)}<select id="ax-${i}" data-axis="${esc(ax.axis)}" data-axhelp="${i}">${ax.default ? `<option value="" title="${esc(memberTitle(memberInfo(A, tax, ax.default)))}">(default: ${esc(A.label(ax.default))} — total)</option>` : ''}${opts}</select><span class="axhelp" id="axhelp-${i}" aria-live="polite">${esc(axisHelp(tax, ax.default || ''))}</span></label>`;
  }).join('');
  const raw = slicesFor(tableId, scope);
  const slices = state.colOrder === 'entered' ? raw : sortSlices(A, tableId, raw);
  state.slices = slices;
  const needs = missingParents(A, tableId, slices);
  const taxAxes = A.table(tableId).axes;
  const sliceHead = slices.map((dims, si) => `<th class="slicehead">${v.axes.map((ax) => {
    const d = dims.find((x) => x.axis === ax.axis);
    if (ax.typed) return `<input data-rename="${si}" data-axis="${esc(ax.axis)}" value="${esc(d?.typed ?? '')}" title="Typed member — edit to rename">`;
    const mem = d ? d.member : ax.default;
    const mi = mem ? memberInfo(A, taxAxes.find((a) => a.axis === ax.axis), mem) : null;
    const badge = !mi ? '' : mi.isTotal ? `<span class="mb total" title="${esc(memberTitle(mi))}">TOTAL</span>` : mi.parent ? `<span class="mb part" title="${esc(memberTitle(mi))}">part of ${esc(shortLabel(mi.parent))}</span>` : '';
    return `<span class="m">${esc(d ? A.label(d.member) : ax.default ? A.label(ax.default) + ' (default)' : '—')}${badge}</span>`;
  }).join('')}${needs.filter((n) => n.slice === si).map((n) => `<span class="needs-parent" title="MCA generic rule GR-3: the parent member is mandatory when a child member has a value">Needs ${esc(n.parents.map((p) => shortLabel(p.member)).join(' › '))} column (GR-3) <button type="button" class="btn small" data-act="add-parents" data-slice="${si}" data-axis="${esc(n.axis)}">Add</button></span>`).join('')}<button class="btn small danger" data-remove-slice="${si}" title="Remove this row and its values">Remove</button></th>`).join('');
  const body = v.lineItems.map((l) => {
    const pad = `padding-left:${8 + l.depth * 12}px`;
    if (l.abstract) return `<tr class="hdr"><td class="lbl" style="${pad}" colspan="${slices.length + 2}">${esc(l.label)}</td></tr>`;
    const rowMarks = [];
    const cellsHtml = slices.map((dims, si) => {
      const dv = dimensionallyValid(A, l.concept, dims);
      const cs = S.conceptStatus(l.concept, scope);
      const ok = dv.valid && cs.applicable;
      const req = ok ? mandatoryCell(S, l.concept, scope, dims, tableId) : { mandatory: false, rules: [] };
      rowMarks.push([scope, req]);
      const fact = ok ? S.getValue(l.concept, scope, dims, l.preferredLabel) : null;
      const p = S.periodForCell(l.concept, scope, l.preferredLabel);
      const calc = ok && A.isNumeric(l.concept) && S.calculatedCell(l.concept, scope, dims, v.presentationElr, l.preferredLabel);
      const sumSlot = ok && (A.dataType(l.concept) === 'monetary' || A.dataType(l.concept) === 'shares') && p ? `<div class="sum-hint" data-sumfor="${esc(factKey(l.concept, p, normDimsUI(dims)))}"></div>` : '';
      return `<td class="val">${inputFor(l.concept, fact, `data-c="${esc(l.concept)}" data-s="${scope}" data-slice="${si}" data-t="${esc(tableId)}" data-pl="${esc(l.preferredLabel || '')}" data-tabkey="${esc(tableId)}"`, !ok, !dv.valid ? 'Not valid for this member combination: ' + dv.reason : cs.reasons.join('\n'), { id: p ? factKey(l.concept, p, normDimsUI(dims)) : null, calculated: !!calc, locked: !!calc && !state.calcOverride[tableId], req })}${sumSlot}</td>`;
    }).join('');
    const any = rowMarks.filter(([, m]) => m.mandatory);
    return `<tr><td class="lbl" style="${pad}">${esc(l.label)}${any.length ? reqChip([[scope, { mandatory: true, rules: [...new Set(any.flatMap(([, m]) => m.rules))], conditional: any.some(([, m]) => m.conditional) }]]).replace(/ · (CY|PY)/, '') : ''}<span class="el">${esc(l.concept)}</span></td><td class="typ">${esc(typeTag(l.concept))}</td>${cellsHtml}</tr>`;
  }).join('');
  return `<div class="sheet">${head}
    <form class="axes" id="addslice" data-t="${esc(tableId)}" data-s="${scope}">${pickers}<div class="go"><button class="btn primary" type="submit">Add row</button></div></form>
    ${slices.length ? `<div class="colbar"><label>Column order <select id="colorder"><option value="taxonomy" ${state.colOrder === 'entered' ? '' : 'selected'}>Taxonomy (each total before its parts)</option><option value="entered" ${state.colOrder === 'entered' ? 'selected' : ''}>As entered</option></select></label><span class="note"><span class="mb total">TOTAL</span> = total of the members below it in the taxonomy · <span class="mb part">part of …</span> = included in that total. A total column is entered by you or with <b>Fill empty totals</b>; the line under a total compares it with its part columns (tool guidance, not an MCA rule). Grey read-only cells are calculated: totals of the taxonomy calculations, carrying amount = gross − accumulated depreciation/amortisation, and the current-year closing balance = opening + changes.</span></div>` : ''}
    ${slices.length ? `<div class="grid-wrap"><table class="g"><thead><tr><th>Line item</th><th>Type</th>${sliceHead}</tr></thead><tbody>${body}</tbody></table></div>` : '<p class="note">No rows yet. Choose the axis members above and add a row; then fill its line items.</p>'}</div>`;
}

function viewValidate() {
  const g = state.gate;
  if (!g) return `<div class="sheet"><header><h1>Validation</h1></header><p class="note">Runs the internal gate: XBRL structure, contexts, units, decimals, dimensions and hypercubes, calculations, and every executable MCA business rule. It does not replace the official MCA XBRL Validator V5.1.</p><button class="btn primary" data-act="validate">Run validation</button></div>`;
  const f = state.issueFilter;
  const list = g.issues.filter((i) => f === 'ALL' || i.severity === f);
  state.issueList = list;
  const tabMode = g.scope?.kind === 'tab';
  const locText = (l) => !l ? '' : l.kind === 'general' ? GENERAL_LABEL : `[${esc(l.tabId || '?')}]${l.tableId ? ' ' + esc(A.label(A.table(l.tableId).hypercube)) : ''} · ${esc(l.scope || '')}${l.conceptQName ? ' · ' + esc(A.label(l.conceptQName)) : ''}`;
  const calc = g.calculations || [];
  const cc = (s) => calc.filter((c) => c.status === s).length;
  return `<div class="sheet"><header><h1>Validation${tabMode ? ` <span class="code">· current tab [${esc(g.scope.code)}]</span>` : ''}</h1><button class="btn" data-act="validate">Validate entire filing</button>${state.lastTab ? `<button class="btn" data-act="validate-tab" data-tab="${esc(state.lastTab)}">Validate current tab [${esc(A.elr(state.lastTab)?.code)}]</button>` : ''}</header>
    ${tabMode ? `<div class="banner info">Scope: only tab [${esc(g.scope.code)}] ${esc(A.elr(g.scope.elrUri)?.title || '')} — its facts and the ${g.scope.rulesRun} business rules that involve its elements, run by the same rule engine as the full validation. Checks marked <span class="chip warn">cross-tab</span> also read elements of other tabs. XML generation always validates the entire filing.</div>` : ''}
    <p class="note">Tool build <b>${esc(BUILD_ID)}</b> — written into the generated XML as <code>&lt;!-- Generated by C&amp;I XBRL Studio build … --&gt;</code>.</p>
    ${tabMode ? '' : `<div class="banner info">Fix tools: <button class="btn small" data-act="recalc-all" title="Recalculate every calculated cell of the current year (totals, carrying amounts, closing balances) from its parts; shows the changes first">Recalculate current year</button> <button class="btn small" data-act="fill-totals-all" title="Fill empty total cells (table totals and parent members) with the sum of their part columns; shows the changes first">Fill empty totals</button>${(() => { const n = S.pyOpeningFacts().length; return n ? ` <button class="btn small" data-act="remove-pyo" title="Values dated the day before the previous year starts">Remove ${n} previous-year opening value(s)</button>` : ''; })()}</div>`}
    <div class="banner ${g.ok ? 'info' : 'bad'}">${g.ok ? 'Internal gate passed — XML can be generated. Official status remains <b>not validated</b> until the instance passes the MCA XBRL Validator V5.1.' : `Internal gate blocked: ${g.summary.errors} error(s) must be fixed before XML can be generated.`}</div>
    <div class="tiles"><div class="tile ${g.summary.errors ? 'bad' : 'ok'}"><b>${g.summary.errors}</b><span>errors</span></div><div class="tile ${g.summary.warnings ? 'warn' : ''}"><b>${g.summary.warnings}</b><span>warnings</span></div><div class="tile"><b>${g.summary.info}</b><span>manual review</span></div><div class="tile"><b>${g.summary.facts}</b><span>facts to generate</span></div><div class="tile ${g.summary.excluded ? 'warn' : ''}"><b>${g.summary.excluded}</b><span>excluded (not applicable)</span></div><div class="tile"><b>${cc('PASS')}/${cc('PASS') + cc('FAIL')}</b><span>calculations consistent</span></div></div>
    <div class="filters">${['ERROR', 'WARNING', 'INFO', 'ALL'].map((x) => `<button class="btn small ${x === f ? 'on' : ''}" data-filter="${x}">${x.toLowerCase()} (${x === 'ALL' ? g.issues.length : g.issues.filter((i) => i.severity === x).length})</button>`).join('')}</div>
    <ul class="issues">${list.slice(0, 600).map((i, n) => `<li class="${i.location ? 'nav-issue' : ''}" ${i.location ? `data-issue="${n}" tabindex="0" role="link" title="Go to the cell"` : ''}><span class="chip ${i.severity === 'ERROR' ? 'bad' : i.severity === 'WARNING' ? 'warn' : 'info'}">${i.severity}</span><span class="msg">${esc(i.message)}${i.crossTab ? ' <span class="chip warn">cross-tab</span>' : ''}${i.location ? ` <span class="reasons">→ ${locText(i.location)}</span>` : i.scope ? ` <span class="reasons">· ${i.scope}</span>` : ''}</span></li>`).join('') || '<li><span></span><span class="msg">Nothing in this category.</span></li>'}</ul>
    ${list.length > 600 ? `<p class="note">Showing 600 of ${list.length}.</p>` : ''}
    ${totalsSection()}</div>`;
}
// Totals hints (member-hints.js): separate from the gate's errors/warnings and not part of its result
function totalsSection() {
  let hints = [];
  try { hints = allTotalsHints(S); } catch { hints = []; }
  state.hintList = hints;
  return `<h2>Totals hints <span class="chip info">tool guidance, not an MCA rule</span></h2>
    <p class="note">Total columns whose value differs from the sum of their part columns, on the axes that the MCA business rules add up (e.g. classes of tangible assets, classification of borrowings). They do not block XML generation.</p>
    <ul class="issues">${hints.slice(0, 300).map((h, n) => `<li class="nav-issue" data-hint="${n}" tabindex="0" role="link" title="Go to the total cell"><span class="chip warn">TOTAL</span><span class="msg">${esc(A.label(h.concept))} — ${esc(colName(h.parentDims, h.tableId))}: ${esc(fmtAmt(h.concept, h.parentValue))}, parts ${esc(fmtAmt(h.concept, h.childrenSum))} (differs by ${esc(fmtAmt(h.concept, h.difference))}) <span class="reasons">→ [${esc(A.table(h.tableId).code || A.elr(A.table(h.tableId).presentationElr)?.code || '')}] ${esc(A.label(A.table(h.tableId).hypercube))} · ${esc(h.scope)}</span></span></li>`).join('') || '<li><span></span><span class="msg">No differences: every total column equals the sum of its part columns.</span></li>'}</ul>`;
}

function viewXml() {
  const g = state.gate;
  return `<div class="sheet"><header><h1>Generate XML</h1><button class="btn primary" data-act="generate">Validate and generate</button>
    ${state.xml ? '<button class="btn" data-act="download-xml">Download .xml</button><button class="btn" data-act="copy-xml">Copy XML</button>' : ''}
    <button class="btn" data-act="preview-pdf" title="Opens a printable preview of the facts the XML contains; use Print → Save as PDF. Not the MCA rendering.">Preview PDF (not the MCA rendering)</button><button class="btn" data-act="preview-html" title="Download the same preview as an .html file (open it and print to PDF)">Download preview (.html)</button></header>
    <p class="note">The preview imitates the general layout of the MCA validator's PDF (sections per statement/note, current and previous year, table blocks, "Textual information") so you can check values, text blocks and table widths. The official PDF is produced only by the MCA XBRL Validator.</p>
    <p class="note">Generation always runs the internal gate first and is blocked on any error. Status after a successful run: <b>internally validated</b>. Mark nothing as filed or certified until the file passes the official MCA XBRL Validator V5.1 and pre-scrutiny.</p>
    ${g && !g.ok ? `<div class="banner bad">Blocked by ${g.summary.errors} error(s). <button class="btn small" data-go="validate">Open validation</button></div>` : ''}
    ${state.xml ? `<pre class="xml" id="xmltext">${esc(state.xml)}</pre>` : ''}</div>`;
}

const nf = (n) => Number(n).toLocaleString('en-IN');
// "2025-04-01 → 2026-03-31" for the year after a year ending on d
function nextYearText(d) {
  const [y, m, day] = d.split('-').map(Number);
  const s = new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(y + 1, m - 1, day));
  if (e.getUTCMonth() !== m - 1) e.setUTCDate(0);
  return `${s} → ${e.toISOString().slice(0, 10)}`;
}
function viewImportConfirm() {
  const p = state.pendingImport;
  if (!p) return viewImport();
  const b = p.preview.byYear, per = p.preview.periods;
  const opt = (val, title, desc) => `<label class="choice${p.mode === val ? ' on' : ''}"><input type="radio" name="yearMode" id="ym-${val}" value="${val}" ${p.mode === val ? 'checked' : ''}><span><b>${title}</b><span class="note">${desc}</span></span></label>`;
  return `<div class="sheet"><header><h1>Import XML</h1><span class="note">${esc(p.name)}</span></header>
    <p class="note">Periods found from the instance dates: current ${esc(per.cy.start)} → ${esc(per.cy.end)}, previous ${esc(per.py.start || '—')} → ${esc(per.py.end || '—')} (${esc(per.method)}).</p>
    <div class="tiles"><div class="tile"><b>${nf(b.current)}</b><span>current-year facts</span></div><div class="tile"><b>${nf(b.previous)}</b><span>previous-year facts</span></div><div class="tile"><b>${nf(b.previousOpening)}</b><span>previous-year opening balances</span></div>${p.preview.unresolved ? `<div class="tile bad"><b>${nf(p.preview.unresolved)}</b><span>unresolved</span></div>` : ''}</div>
    ${(() => {
      const cf = p.preview.cashFlow;
      if (!cf || (!cf.directFacts && !cf.indirectFacts && !cf.declared)) return '';
      if (cf.needsChoice) return `<h2>Cash flow statement method</h2><div class="banner warn">The XML does not report <code>TypeOfCashFlowStatement</code> and contains facts of both statements (${cf.directFacts} direct-only, ${cf.indirectFacts} indirect-only). Choose the method: only that statement will receive data.</div>
        <div class="choices row">${['Direct Method', 'Indirect Method'].map((m) => `<label class="choice inline${p.cashFlowMethod === m ? ' on' : ''}"><input type="radio" name="cfImport" id="cfi-${m.startsWith('Direct') ? 'direct' : 'indirect'}" value="${m}" ${p.cashFlowMethod === m ? 'checked' : ''}><span><b>${m}</b></span></label>`).join('')}</div>`;
      return `<p class="note">Cash flow statement: <b>${esc(cf.declared || cf.detected)}</b> (${cf.declared ? 'reported in the XML' : 'detected from the reported facts'}) — only ${(cf.declared || cf.detected).startsWith('Direct') ? '[100300]' : '[100400]'} receives data.</p>`;
    })()}
    ${p.preview.notApplicable ? `<p class="note">${nf(p.preview.notApplicable)} fact(s) in the XML belong to cells that are not applicable to this filing (for example a previous-year column excluded by GR-12, or a field that depends on a "No" answer). They are listed in the import report and are not imported as filing data.</p>` : ''}
    <h2>Import historical data</h2>
    <form id="import-confirm" class="choices">
      ${opt('both', 'Both years', 'Import the current-year and previous-year data from this XML into the current-year and previous-year columns.')}
      ${opt('current', 'Current year only', 'Import only the current reporting-year data, including its opening balances: ' + nf(b.cyOpeningAtPyEnd || 0) + ' fact(s) at ' + esc(per.py.end || 'the previous year end') + ' of items reported with opening and closing balances (share capital, reserves, fixed assets, cash, ...). MCA generic rule GR-7: the current-year opening balance and the previous-year closing balance are one common element, so these values also show as the previous-year closing of those items. All other previous-year data is not imported and the previous-year comparative column stays empty.')}
      ${per.cy.end ? opt('next', 'Next year\'s filing (this XML becomes the previous year)', 'Prepare the filing for ' + esc(nextYearText(per.cy.end)) + ' from this filed instance: its current-year data (' + nf(b.current) + ' facts) becomes the previous-year column, the current-year columns start empty, and the reporting periods are set for you. Elements that do not apply to a previous year (GR-12: auditors\' report, general information, directors\' report, signatories …) are listed as not applicable and not imported. The previous year of this XML and its opening balances are not imported (as in MCA-validated filings, no previous-year opening balances are reported).') : ''}
      <div class="go"><button class="btn primary" type="submit" id="import-commit" ${p.mode && (!p.preview.cashFlow?.needsChoice || p.cashFlowMethod) ? '' : 'disabled'}>Import</button><button class="btn" type="button" data-act="cancel-import">Cancel</button></div>
    </form></div>`;
}

function viewImport() {
  const r = S.filing.importReport;
  if (!r) return '<div class="sheet"><header><h1>Import report</h1></header><p class="note">No instance imported yet. Use <b>Import XML</b> in the top bar.</p></div>';
  const sec = (t, arr, fmt) => `<h2>${t} (${arr.length})</h2>${arr.length ? `<ul class="issues">${arr.slice(0, 300).map((x) => `<li><span class="chip">·</span><span class="msg">${fmt(x)}</span></li>`).join('')}</ul>` : '<p class="note">None.</p>'}`;
  return `<div class="sheet"><header><h1>Import report</h1><span class="note">${esc(r.fileName)}</span></header>
    <div class="banner info">Import mode: <b>${r.yearMode === 'current' ? 'Current year only' : r.yearMode === 'next' ? 'Next year\'s filing' : 'Both years'}</b>${r.yearMode === 'next' && r.nextYear ? `<br>Filing prepared for ${esc(r.nextYear.cy.start)} → ${esc(r.nextYear.cy.end)}; this XML's current year (${esc(r.nextYear.py.start)} → ${esc(r.nextYear.py.end)}) is the previous year — ${nf(r.byYear?.previous ?? 0)} facts imported into the previous-year columns; ${nf((r.byYear?.skippedPrevious ?? 0) + (r.byYear?.skippedPreviousOpening ?? 0))} facts of its own previous year not imported` : ''}${r.cashFlow?.applied ? `<br>Cash flow statement: ${esc(r.cashFlow.applied)}${r.cashFlow.source ? ' (' + esc(r.cashFlow.source) + ')' : ''}` : ''}${r.notApplicable?.length ? `<br>Not applicable, not imported: ${nf(r.notApplicable.length)} facts (${nf(r.byYear?.notApplicablePrevious ?? 0)} previous year)` : ''}${r.yearMode === 'next' ? '' : `<br>Current year imported: ${nf(r.byYear?.current ?? 0)} facts<br>`}${r.yearMode === 'next' ? '' : r.yearMode === 'current' ? `Previous year: not imported (Current year only selected) — ${nf((r.byYear?.skippedPrevious ?? 0) + (r.byYear?.skippedPreviousOpening ?? 0))} previous-year facts skipped<br>Current-year opening balances imported (GR-7, = previous-year closing): ${nf(r.byYear?.carriedOpening ?? 0)} facts` : `Previous year imported: ${nf((r.byYear?.previous ?? 0) + (r.byYear?.previousOpening ?? 0))} facts`}</div>
    <div class="tiles"><div class="tile"><b>${r.counts.sourceFacts}</b><span>source facts</span></div><div class="tile ok"><b>${r.counts.imported}</b><span>mapped</span></div><div class="tile ${r.counts.unresolved ? 'bad' : ''}"><b>${r.counts.unresolved}</b><span>unresolved</span></div><div class="tile"><b>${r.contexts.length}</b><span>source contexts</span></div><div class="tile"><b>${r.counts.footnotes}</b><span>footnotes</span></div></div>
    <p class="note">Periods detected from ${esc(r.periodDetection?.method)}: current ${esc(r.periodDetection?.cy.start)} → ${esc(r.periodDetection?.cy.end)}, previous ${esc(r.periodDetection?.py.start || '—')} → ${esc(r.periodDetection?.py.end || '—')}. schemaRef ${r.schemaRefMatches ? 'matches the prescribed URL' : 'differs: ' + esc(r.schemaRef)}.</p>
    ${sec('Errors', r.errors, esc)}${sec('Warnings', r.warnings, esc)}
    ${sec('Unresolved facts', r.unresolvedFacts, (u) => `${esc(u.element)} · context ${esc(u.contextRef)} · value “${esc(String(u.value).slice(0, 80))}” — ${esc(u.reason)}`)}
    ${sec('Not applicable — not imported as filing data', r.notApplicable || [], (x) => `${esc(x.concept)}${x.dims?.length ? ' [' + esc(dimKey(x.dims)) + ']' : ''} · ${esc(x.scope)} · value “${esc(String(x.value ?? '').slice(0, 60))}” — ${esc(x.reasons.join('; '))}`)}
    ${sec('Inconsistent duplicates', r.conflicts, (c) => `${esc(c.concept)} in ${esc(c.contextRef)}: kept ${esc(c.kept)}, dropped ${esc(c.dropped)}`)}
    ${sec('Context map (source → internal)', r.contexts, (c) => `${esc(c.sourceContextId)} → ${esc(c.internalContextKey)}${c.issues.length ? ' — ' + esc(c.issues.join('; ')) : ''}`)}</div>`;
}

// MCA Validator error help: paste the validator's error list; each message is explained (mca-errors.js) and linked
// to the element in this filing. Identical messages are grouped.
function viewMcaErrors() {
  const items = state.mcaErrors?.items || [];
  const groups = new Map();
  for (const x of items) { const k = `${x.code}|${x.title}|${x.cause}|${x.raw.replace(/'[^']*'/g, "''").slice(0, 90)}`; (groups.get(k) || groups.set(k, []).get(k)).push(x); }
  const go2 = (x) => (x.concept ? `<button type="button" class="btn small" data-goconcept="${esc(x.concept)}" title="${esc(x.concept)}">${esc(x.label || x.concept)}</button>` : x.element ? `<code>${esc(x.element)}</code>` : '');
  const one = (g) => {
    const x = g[0];
    const details = x.details.length ? `<ul class="mx-details">${x.details.map((d) => `<li><b>${esc(d.title)}</b> — ${esc(d.meaning)} <span class="muted">${esc(d.cause)}</span></li>`).join('')}</ul>` : '';
    return `<div class="mx"><div class="mx-h"><span class="chip ${x.code === 'unknown' ? 'warn' : 'bad'}">${esc(x.code)}</span> <b>${esc(x.title)}</b>${g.length > 1 ? ` <span class="chip info">${g.length}×</span>` : ''}</div>
      <p>${esc(x.meaning)}${g.length > 1 ? ' (and the same for the other elements below)' : ''}</p>${details}
      <p><b>Likely cause:</b> ${esc(x.cause)}</p><p><b>Fix:</b> ${esc(x.fix)}</p>
      ${g.some((y) => y.concept || y.element) ? `<div class="mx-els">${g.map(go2).join(' ')}</div>` : ''}
      <details><summary>Original message${g.length > 1 ? 's' : ''}</summary><pre class="mx-raw">${g.map((y) => esc((y.n ? y.n + ') ' : '') + y.raw)).join('\n')}</pre></details></div>`;
  };
  return `<div class="sheet"><header><h1>MCA Validator error help</h1></header>
    <p class="note">Paste the error list from the MCA XBRL Validator (or its error file). Each message is explained in plain language with the likely cause and the fix in this tool; element names link to the cell. This is an aid for reading the messages — it does not validate the instance. Tool build <b>${esc(BUILD_ID)}</b>.</p>
    <textarea id="mx-text" rows="8" spellcheck="false" placeholder="1) cvc-complex-type.3.2.2: Attribute 'xml:lang' is not allowed to appear in element 'in-ca:PANOfShareholder'.">${esc(state.mcaErrors?.text || '')}</textarea>
    <p><button type="button" class="btn primary" data-act="explainErrors" id="mx-run">Explain</button></p>
    ${items.length ? `<p class="note">${items.length} message(s) in ${groups.size} group(s).</p>${[...groups.values()].map(one).join('')}` : ''}
    <details class="mx-guide"><summary>How to read MCA Validator messages yourself</summary>
      <ol>
        <li><b>The code says what kind of rule failed.</b> <code>cvc-…</code> codes are standard W3C XML Schema checks (the validator uses Xerces): <code>3.2.2</code> attribute not allowed, <code>2.4.a</code> element in the wrong place, <code>2.4.b</code> element incomplete, <code>pattern/enumeration/length-valid</code> wrong value format, <code>datatype-valid</code> wrong data type, <code>type.3.1.3</code> names the element whose value failed, <code>elt.1</code> schema/namespace not found. Messages without a cvc code come from MCA business rules or the HTML/PDF checks.</li>
        <li><b>The quoted names say where.</b> <code>in-ca:…</code>/<code>in-gaap:…</code> are taxonomy elements (use the buttons above or search the label in this tool). Plain tag names (<code>td</code>, <code>colgroup</code>) are HTML inside a text block — the message starts with <i>"the contained HTML has the following errors"</i>.</li>
        <li><b>Find it in the XML.</b> Open the generated XML in a text editor and search for the element name; text blocks show their HTML escaped (<code>&amp;lt;td colspan=…</code>).</li>
        <li><b>Check the build.</b> The first comment of every generated XML names the tool build. If it differs from the build in the header, the page was cached: press Ctrl+F5 (Cmd+Shift+R), re-open the project and generate again.</li>
        <li><b>Compare with the internal gate.</b> Validation in this tool reports HTML that the MCA schema rejects (colgroup, col, caption, colspan, rowspan, style) as errors before XML is generated. If the MCA Validator reports something the internal gate did not, it is a gap — keep the error file and the XML for the fix.</li>
        <li><b>Text block HTML.</b> MCA-validated instances use only these tags: div, span, p, br, table, tbody, tr, td (th/thead/tfoot are in the Filing Manual), and only the <code>class</code> attribute. Pasted Word/Excel tables are rebuilt automatically; to repair an older one, open the text block and click Save Text.</li>
        <li><b>Check the PDF.</b> Convert the instance to PDF in the MCA tool and look at every text block: wide tables are cut on the right (keep columns few and cells short), <code>highlightedText</code> classes render as shaded text, <code>bordered</code> draws cell borders.</li>
      </ol>
    </details></div>`;
}

function viewCoverage() {
  const rules = A.rules.rules;
  const by = {};
  for (const r of rules) by[r.status] = (by[r.status] || 0) + 1;
  const runtime = state.gate?.ruleStatus || {};
  const c = A.rules.corpus;
  return `<div class="sheet"><header><h1>Business-rule coverage</h1></header>
    <div class="tiles">${['EXECUTABLE', 'REVIEW_ONLY_EXTERNAL_DATA', 'UNIMPLEMENTED', 'NOT_APPLICABLE'].map((s) => `<div class="tile ${s === 'UNIMPLEMENTED' && by[s] ? 'bad' : ''}"><b>${by[s] || 0}</b><span>${s.toLowerCase().replace(/_/g, ' ')}</span></div>`).join('')}</div>
    ${c.specificRulesSheetTruncated ? `<div class="banner warn"><b>Rule corpus incomplete.</b> ${esc(c.note)}<br><span class="reasons">No specific rules supplied for ${c.elrsWithoutSuppliedSpecificRules.length} ELRs, from ${esc(c.elrsWithoutSuppliedSpecificRules[0] || '')}.</span></div>` : ''}
    <div class="grid-wrap"><table class="g"><thead><tr><th>Rule</th><th>Status</th><th>Run</th><th>Element</th><th>MCA source text</th><th>Implementation</th></tr></thead><tbody>
    ${rules.map((r) => `<tr><td class="typ">${esc(r.id)}</td><td><span class="chip ${r.status === 'EXECUTABLE' ? 'ok' : r.status === 'UNIMPLEMENTED' && !r.approvedLimitation ? 'bad' : r.status !== 'NOT_APPLICABLE' ? 'warn' : ''}">${esc(r.approvedLimitation ? 'APPROVED LIMITATION / NOT EXECUTED' : r.status)}</span></td><td class="typ">${esc(runtime[r.id] || '—')}</td><td class="typ">${esc(r.element || '')}</td><td>${esc(r.text)}${r.reason ? `<div class="reasons">${esc(r.reason)}</div>` : ''}</td><td class="typ">${esc(r.implementation || '')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// ------------------------------------------------------------------ events
function wire() {
  document.addEventListener('click', (ev) => {
    const ul = ev.target.closest('[data-fn-unlink]');
    if (ul) { unlinkFootnote(S.filing, ul.dataset.fnUnlink, ul.dataset.fnKey); changed(); if (!$('#modal').hidden) closeModal(); renderNav(); renderMain({ keepScroll: true }); toast('Footnote removed from the cell.'); return; }
    const fg = ev.target.closest('[data-fn-go]');
    if (fg) { const loc = new Gate(A).locate(S.filing, { factKey: fg.dataset.fnGo }); navigateTo(loc); return; }
    const hi = ev.target.closest('[data-hint]');
    if (hi) { const h = state.hintList?.[Number(hi.dataset.hint)]; if (h) navigateTo({ kind: 'cell', tableId: h.tableId, scope: h.scope, cellId: h.cellId }); return; }
    const ti = ev.target.closest('[data-issue]');
    if (ti) { navigateTo(state.issueList?.[Number(ti.dataset.issue)]?.location); return; }
    const tb = ev.target.closest('[data-textblock]');
    if (tb) { if (!tb.disabled) openTextBlock(tb); return; }
    const md = ev.target.closest('[data-modal]');
    if (md) { modalAction(md.dataset.modal); return; }
    const t = ev.target.closest('[data-elr],[data-go],[data-goconcept],[data-open-table],[data-act],[data-filter],[data-remove-slice]');
    if (!t) return;
    if (t.tagName === 'A') ev.preventDefault();
    if (t.dataset.elr) return go({ kind: 'elr', elr: t.dataset.elr });
    if (t.dataset.go) return go({ kind: t.dataset.go });
    if (t.dataset.goconcept) return goConcept(t.dataset.goconcept);
    if (t.dataset.openTable) return go({ kind: 'table', tableId: t.dataset.openTable, scope: t.dataset.scope });
    if (t.dataset.filter) { state.issueFilter = t.dataset.filter; return renderMain(); }
    if (t.dataset.removeSlice != null) {
      const v = state.view; const dims = state.slices[Number(t.dataset.removeSlice)];
      const remove = () => {
        S.removeSlice(v.tableId, v.scope, dims);
        state.pending[v.tableId + v.scope] = (state.pending[v.tableId + v.scope] || []).filter((p) => dimKey(p) !== dimKey(dims));
        changed(); renderMain({ keepScroll: true }); toast('Row removed.');
      };
      const n = S.sliceFacts(v.tableId, v.scope, dims).length;
      if (!n) return remove();
      return confirmDialog('Remove row?', `This row holds <b>${n}</b> entered value(s). Removing the row deletes them from the filing.`, remove);
    }
    const act = t.dataset.act;
    if (act) actions[act]?.(t);
  });
  // rich-text toolbar: keep the editor selection while clicking a button
  document.addEventListener('mousedown', (ev) => { if (ev.target.closest('[data-rte]')) ev.preventDefault(); });
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-rte]');
    if (!b || b.disabled) return;
    const body = b.closest('.rte').querySelector('.rte-body');
    if (document.activeElement !== body) body.focus();
    if (b.dataset.rte === 'tableBorders') return toggleTableBorders(body);
    try { document.execCommand('styleWithCSS', false, false); document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* optional */ }
    document.execCommand(b.dataset.rte, false, null);
  });
  document.addEventListener('focusin', (ev) => { const c = ev.target.closest?.('#main td.val [data-cell]'); if (c) state.lastCell = c.dataset.cell; });
  document.addEventListener('focusin', (ev) => {
    if (!ev.target.matches?.('.rte-body')) return;
    ev.target.dataset.orig = ev.target.innerHTML;
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* optional */ }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('#modal').hidden) modalAction('cancel');
    if (!$('#modal').hidden) { modalKeys(ev); return; }
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      toast(saveLocal() ? `Saved in this browser at ${state.saved.toLocaleTimeString()}. Use “Save project” to download a project file.` : 'This browser does not allow saving here — use “Save project” to download a project file.', !(state.saved instanceof Date));
      return;
    }
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.key === 'n' || ev.key === 'N' || ev.code === 'KeyN')) {
      const c = ev.target.closest?.('#main td.val [data-cell]');
      if (c || state.lastCell) { ev.preventDefault(); openFootnoteDialog(c ? c.dataset.cell : state.lastCell); return; }
    }
    if (gridKeys(ev)) return;
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('[data-hint]')) { ev.preventDefault(); ev.target.click(); return; }
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('[data-issue]')) { ev.preventDefault(); navigateTo(state.issueList?.[Number(ev.target.dataset.issue)]?.location); }
  });
  document.addEventListener('paste', (ev) => {
    const el = ev.target.closest?.('.rte-body');
    if (!el) return;
    ev.preventDefault();
    const cd = ev.clipboardData;
    const html = cd.getData('text/html');
    // pasted tables (Word/Excel) are rebuilt for the MCA HTML schema; cells get class="bordered" unless the source
    // already carries an MCA border class (switch off with the ▦ button)
    const clean = html ? fromMca(toMca(html, rteOpts({ borders: true }))) : fromMca(cd.getData('text/plain'));
    document.execCommand('insertHTML', false, clean);
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.matches('.cellin')) return cellChange(el);
    if (el.matches('[data-calc-override]')) { state.calcOverride[el.dataset.calcOverride] = el.checked; renderMain({ keepScroll: true }); toast(el.checked ? 'Calculated cells on this tab are editable (manual values are kept and checked by the calculation rule).' : 'Calculated cells on this tab are read-only again; values are kept.'); return; }
    if (el.name === 'cashflow') return setCashFlow(el.value);
    if (el.id === 'cf-values') { state.cfValues = el.checked; return; }
    if (el.matches('[data-fn-text]')) { try { updateFootnoteText(S.filing, el.dataset.fnText, el.value); changed(); toast(`Footnote ${el.dataset.fnText} saved.`); } catch (e) { toast(e.message, true); } return; }
    if (el.id === 'colorder') { state.colOrder = el.value; renderMain({ keepScroll: true }); return; }
    if (el.matches('select[data-axhelp]')) { const h = $('#axhelp-' + el.dataset.axhelp); const tax = A.table(state.view.tableId).axes.find((a) => a.axis === el.dataset.axis); if (h) h.textContent = axisHelp(tax, el.value); return; }
    if (el.id === 'tb-emphasis') { S.filing.meta.textEmphasis = el.value; changed(); toast(el.value === 'none' ? 'Bold/italic/underline will be saved as plain text.' : 'Bold/italic/underline will be saved as highlightedText1/2/3.'); return; }
    if (el.matches('[data-rename]')) {
      const v = state.view; const dims = state.slices[Number(el.dataset.rename)];
      try {
        const exists = S.filing.all().some((f) => dimKey(f.dims) === dimKey(dims));
        if (exists) S.renameTypedMember(v.tableId, v.scope, dims, el.dataset.axis, el.value.trim());
        else { const p = state.pending[v.tableId + v.scope]; const i = p.findIndex((x) => dimKey(x) === dimKey(dims)); p[i] = dims.map((d) => (d.axis === el.dataset.axis ? { axis: d.axis, typed: el.value.trim() } : d)); }
        changed(); renderMain(); toast('Typed member renamed.');
      } catch (e) { toast(e.message, true); el.value = dims.find((d) => d.axis === el.dataset.axis)?.typed || ''; }
    }
    if (el.name === 'yearMode' && state.pendingImport) { state.pendingImport.mode = el.value; renderMain(); return; }
    if (el.name === 'cfImport' && state.pendingImport) { state.pendingImport.cashFlowMethod = el.value; renderMain(); return; }
    if (el.id === 'f-first') { $('#f-pys').disabled = el.checked; $('#f-pye').disabled = el.checked; }
  });
  document.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (ev.target.id === 'setup') return applySetup(ev.target);
    if (ev.target.id === 'addslice') return addSlice(ev.target);
    if (ev.target.id === 'import-confirm') return commitImport();
  });
  $('#file-xml').addEventListener('change', (ev) => readFile(ev, (text, name) => {
    // nothing is committed until the user chooses how previous-year data is populated
    try { state.pendingImport = { text, name, preview: S.previewXml(text, { fileName: name }), mode: null }; go({ kind: 'import-confirm' }); }
    catch (e) { toast('Import failed: ' + e.message, true); }
  }));
  $('#file-json').addEventListener('change', (ev) => readFile(ev, (text) => {
    try { S = new Session(A, Filing.fromJSON(A, JSON.parse(text))); state.example = false; state.pending = {}; changed(); state.leaveOk = true; go({ kind: 'setup' }); toast('Project opened.'); }
    catch (e) { toast('Could not open project: ' + e.message, true); }
  }));
  $('#navtoggle').addEventListener('click', () => $('#nav').classList.toggle('open'));
}

function readFile(ev, cb) {
  const f = ev.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => cb(String(r.result), f.name);
  r.readAsText(f);
  ev.target.value = '';
}

function commitImport() {
  const p = state.pendingImport;
  if (!p?.mode) { toast('Choose an import mode first.', true); return; }
  if (p.preview.cashFlow?.needsChoice && !p.cashFlowMethod) { toast('Choose the cash flow statement method first.', true); return; }
  try {
    const r = S.importXml(p.text, { fileName: p.name, yearMode: p.mode, cashFlowMethod: p.cashFlowMethod || null });
    state.pendingImport = null; state.example = false; state.pending = {};
    changed(); go({ kind: 'import' });
    toast(r.yearMode === 'next' ? `Filing prepared for ${r.nextYear?.cy.start} → ${r.nextYear?.cy.end}: ${nf(r.byYear.previous)} facts of the filed year imported as previous year.` : r.yearMode === 'current' ? `Current year imported: ${nf(r.byYear.current)} facts + ${nf(r.byYear.carriedOpening)} opening balances. Previous year not imported.` : `Imported ${nf(r.counts.imported)} of ${nf(r.counts.sourceFacts)} facts.`);
  } catch (e) { toast('Import failed: ' + e.message, true); }
}

const actions = {
  'validate-tab'(btn) {
    const tab = btn?.dataset.tab || state.lastTab;
    if (!tab) return;
    state.gate = S.validateTab(tab); state.issueFilter = state.gate.summary.errors ? 'ERROR' : 'ALL';
    state.view = { kind: 'validate' }; renderBar(); renderNav(); renderMain();
  },
  'cancel-import'() { state.pendingImport = null; go({ kind: 'setup' }); toast('Import cancelled — nothing was changed.'); },
  validate() { if (!guardLeave({ kind: 'validate' }, () => actions.validate())) return; state.leaveOk = false; state.gate = S.validate(); state.issueFilter = state.gate.summary.errors ? 'ERROR' : 'ALL'; state.view = { kind: 'validate' }; renderBar(); renderNav(); renderMain(); },
  'add-parents'(el) {
    const v = state.view;
    const n = missingParents(A, v.tableId, state.slices).find((x) => x.slice === Number(el.dataset.slice) && x.axis === el.dataset.axis);
    if (!n) return;
    const list = (state.pending[v.tableId + v.scope] ||= []);
    for (const p of n.parents) { const nd = S.validateSlice(v.tableId, p.dims); if (!slicesFor(v.tableId, v.scope).some((d) => dimKey(d) === dimKey(nd))) list.push(nd); }
    renderMain({ keepScroll: true });
    toast(`Added column(s): ${n.parents.map((p) => shortLabel(p.member)).join(', ')}. Enter their totals.`);
  },
  'use-sum'(el) {
    const id = el.dataset.sumcell;
    const h = state.totals.find((x) => x.cellId === id);
    const input = document.querySelector(`#main .cellin[data-cell="${CSS.escape(id)}"]`);
    if (!h || !input) return;
    if (input.disabled || input.readOnly) { toast('This cell is read-only (calculated). Use the tab option to edit calculated cells first.', true); return; }
    input.value = fmtAmt(h.concept, h.childrenSum);
    if (cellChange(input) !== false) { refreshTotals(); toast(`Total set to ${input.value} — the sum of ${h.children.length} part column(s).`); }
  },
  'preview-pdf'() {
    const html = buildPreviewHtml(S, { build: BUILD_ID });
    const w = window.open('', '_blank');
    if (!w) { download(previewName(), html, 'text/html'); toast('The browser blocked the new window — the preview was downloaded as .html; open it and use Print → Save as PDF.', true); return; }
    w.document.open(); w.document.write(html); w.document.close();
    toast('Preview opened in a new tab — use “Print / Save as PDF” there.');
  },
  'preview-html'() { download(previewName(), buildPreviewHtml(S, { build: BUILD_ID }), 'text/html'); toast('Preview downloaded — open it in a browser and print to PDF.'); },
  'footnote-cell'() { openFootnoteDialog(state.lastCell); },
  'fn-delete'(el) {
    const id = el.dataset.fn;
    confirmDialog('Delete footnote?', `Footnote <b>${esc(id)}</b> will be removed from all its cells.`, () => { removeFootnote(S.filing, id); changed(); renderNav(); renderMain({ keepScroll: true }); toast(`Footnote ${id} deleted.`); });
  },
  'fill-totals'(el) {
    const tableId = el.dataset.t, scope = el.dataset.s;
    const plan = fillTotalsPlan(S, tableId, scope);
    if (!plan.length) { toast('No empty total cell has part values to add up.', true); return; }
    confirmDialog('Fill empty totals',
      `<p><b>${plan.length}</b> empty total cell(s) in <b>${new Set(plan.map((p) => dimKey(p.dims))).size}</b> column(s) will be set to the sum of their part columns.</p>
       <p class="note">Only on the axes the MCA business rules add up (e.g. classes of share capital, components of reserves, classes of tangible assets, classification of borrowings), only amounts and share counts. Missing total columns (the table total and parent members required by GR-3) are added. Existing values are never changed; calculated cells are recalculated, not filled.</p>`,
      () => {
        const r = fillTotals(S, tableId, scope);
        state.pending[tableId + scope] = [];
        changed(); renderMain({ keepScroll: true });
        toast(`Filled ${r.filled} total cell(s)${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`);
      }, null, { cancel: 'Cancel', ok: 'Fill' });
  },
  'fill-totals-all'() {
    const add = additiveAxes(A);
    const tables = A.tables.filter((t) => t.axes.some((ax) => !ax.typed && add.has(ax.axis)) && S.tableStatus(t.id, 'CY').applicable);
    const plans = tables.map((t) => [t.id, fillTotalsPlan(S, t.id, 'CY')]).filter(([, p]) => p.length);
    const n = plans.reduce((a, [, p]) => a + p.length, 0);
    if (!n) { toast('No empty current-year total cell has part values to add up.', true); return; }
    confirmDialog('Fill empty totals — current year',
      `<p><b>${n}</b> empty total cell(s) in ${plans.length} table(s) will be set to the sum of their part columns:</p><ul>${plans.map(([id, p]) => `<li>${esc(A.label(A.table(id).hypercube))}: ${p.length}</li>`).join('')}</ul><p class="note">Existing values are never changed.</p>`,
      () => {
        let filled = 0, skipped = 0;
        for (const [id] of plans) { const r = fillTotals(S, id, 'CY'); filled += r.filled; skipped += r.skipped.length; }
        state.pending = {};
        changed(); actions.validate();
        toast(`Filled ${filled} total cell(s)${skipped ? `, ${skipped} skipped` : ''}.`);
      }, null, { cancel: 'Cancel', ok: 'Fill' });
  },
  'recalc-all'() {
    const { changes } = S.recalculateAll({ scopes: ['CY'], apply: false });
    if (!changes.length) { toast('All current-year calculated cells already agree with their parts.'); return; }
    const row = (c) => { const x = c.after || c.before; return `<li>${esc(A.label(x.concept))}${x.dims.length ? ' [' + esc(x.dims.map((d) => d.member ? shortLabel(d.member) : d.typed).join(', ')) + ']' : ''}: ${c.before ? esc(fmtAmt(x.concept, c.before.value)) : '—'} → ${c.after ? esc(fmtAmt(x.concept, c.after.value)) : 'removed'}</li>`; };
    confirmDialog('Recalculate current year',
      `<p><b>${changes.length}</b> calculated cell(s) of the current year differ from the values derived from their parts and will be recalculated:</p><ul>${changes.slice(0, 40).map(row).join('')}</ul>${changes.length > 40 ? `<p class="note">… and ${changes.length - 40} more.</p>` : ''}
       <p class="note">Calculated cells are totals of the taxonomy calculations, carrying amounts (gross − accumulated depreciation/amortisation) and closing balances (opening + changes). Values you entered with "Allow editing of calculated cells" (overrides) and previous-year figures are not changed.</p>`,
      () => { const r = S.recalculateAll({ scopes: ['CY'] }); changed(); actions.validate(); toast(`Recalculated ${r.changes.length} cell(s).`); }, null, { cancel: 'Cancel', ok: 'Recalculate' });
  },
  'remove-pyo'() {
    const list = S.pyOpeningFacts();
    if (!list.length) return;
    const d = list[0].period.date;
    confirmDialog('Remove previous-year opening balances',
      `<p><b>${list.length}</b> value(s) are dated <b>${esc(d)}</b> — the opening balances of the previous year (${[...new Set(list.map((f) => shortLabel(f.concept)))].slice(0, 12).map(esc).join(', ')}${new Set(list.map((f) => f.concept)).size > 12 ? ' …' : ''}).</p>
       <p class="note">They usually come from moving last year's filing forward by changing the dates. MCA-validated instances report no previous-year opening balances (INFOBAHN 2024-25), or report them together with all their totals (CHARVAK 2024-25); left without their totals they fail MCA generic rule GR-1 (“parent element not entered”). Removing them leaves the previous-year columns as filed last year.</p>`,
      () => { const n = S.removePyOpeningFacts(); changed(); actions.validate(); toast(`Removed ${n} previous-year opening value(s).`); }, null, { cancel: 'Keep them', ok: 'Remove' });
  },
  'carry-forward'(el) {
    const tableId = el.dataset.t;
    const plan = carryForwardPlan(S, tableId);
    if (!plan.available) { toast(plan.reason, true); return; }
    state.cfValues = false;
    confirmDialog('Copy from previous year',
      `<p>The previous-year table has <b>${plan.columns.length}</b> column(s); <b>${plan.newColumns.length}</b> of them are not yet in the current year and will be added.</p>
       <p><label><input type="checkbox" id="cf-values" ${plan.values ? '' : 'disabled'}> Also copy <b>${plan.values}</b> previous-year value(s) into empty current-year cells</label></p>
       <p class="note">Existing current-year values are never overwritten. Opening balances already carry over (the previous-year closing is the current-year opening). Calculated cells are recalculated, not copied. Copied values are last year's figures — replace them with this year's figures before filing.</p>`,
      () => {
        try {
          const r = carryForward(S, tableId, { values: !!state.cfValues });
          const list = (state.pending[tableId + 'CY'] ||= []);
          for (const d of r.columns) if (!list.some((x) => dimKey(x) === dimKey(d))) list.push(d);
          changed(); renderMain({ keepScroll: true });
          toast(`Added ${r.columns.length} column(s)${state.cfValues ? `, copied ${r.values} value(s)${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}` : ''}.${state.cfValues && r.values ? ' Replace them with current-year figures.' : ''}`);
        } catch (e) { toast(e.message, true); }
      }, null, { cancel: 'Cancel', ok: 'Copy' });
  },
  explainErrors() {
    const text = $('#mx-text')?.value || '';
    state.mcaErrors = { text, items: explainMcaErrors(text, A) };
    renderMain({ keepScroll: true });
    if (!state.mcaErrors.items.length) toast('No validator messages found in the text.', true);
  },
  generate() {
    if (!guardLeave({ kind: 'xml' }, () => actions.generate())) return;
    state.leaveOk = false;
    try { const { xml, gate } = S.exportXml(); state.gate = gate; state.xml = xml; toast('XML generated — internal gate passed.'); }
    catch (e) { state.gate = e.result || null; state.xml = null; toast(e.message, true); }
    renderBar(); renderNav(); renderMain();
  },
  'download-xml'() { if (state.xml) download(`${(S.filing.meta.cin || 'instance')}_${S.filing.meta.reportType}_${S.filing.meta.periods.cy.end}.xml`, state.xml, 'application/xml'); },
  async 'copy-xml'() {
    try { await navigator.clipboard.writeText(state.xml); toast('XML copied.'); }
    catch { const r = document.createRange(); r.selectNodeContents($('#xmltext')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Press Ctrl/Cmd+C to copy the selected XML.'); }
  },
  'import-xml'() { $('#file-xml').click(); },
  'open-project'() { $('#file-json').click(); },
  'save-project'() { download(`${(S.filing.meta.name || 'filing').replace(/[^\w.-]+/g, '_')}.mca-ci.json`, JSON.stringify(S.filing.toJSON(), null, 1), 'application/json'); },
  'new-filing'() {
    confirmDialog('Start a new filing?', 'The current filing in this browser will be replaced by an empty one. Use <b>Save project</b> first if you want to keep a copy.', () => {
      S = new Session(A); state.example = false; state.pending = {}; changed(); state.leaveOk = true; go({ kind: 'setup' }); toast('New filing started.');
    });
  },
};

function applySetup(form) {
  const v = (n) => form.elements[n].value;
  const first = form.elements.firstFinancialYear.checked;
  try {
    S.setMeta({ name: v('name'), cin: v('cin').trim().toUpperCase(), reportType: v('reportType'), level: v('level'), displayPlaces: Number(v('displayPlaces')), firstFinancialYear: first,
      periods: { cy: { start: v('cy.start'), end: v('cy.end') }, py: first ? { start: '', end: '' } : { start: v('py.start'), end: v('py.end') } } });
    const qName = A.qnameOfLocal('NameOfCompany');
    if (v('name').trim() && S.conceptStatus(qName, 'CY').applicable) S.setValue(qName, 'CY', v('name').trim());
    S._views.clear(); changed(); renderNav(); renderMain({ keepScroll: true }); toast('Company information applied.');
  } catch (e) { toast(e.message, true); }
}

function addSlice(form) {
  const v = state.view;
  const dims = [];
  for (const el of form.querySelectorAll('[data-axis]')) {
    const val = el.value.trim();
    if (!val) continue;
    dims.push(el.tagName === 'SELECT' ? { axis: el.dataset.axis, member: val } : { axis: el.dataset.axis, typed: val });
  }
  try {
    const nd = S.validateSlice(v.tableId, dims);
    if (slicesFor(v.tableId, v.scope).some((d) => dimKey(d) === dimKey(nd))) { toast('That row already exists.', true); return; }
    (state.pending[v.tableId + v.scope] ||= []).push(nd);
    renderMain({ keepScroll: true });
    // show the new column where it sits (taxonomy order) and say whether it needs its parent column (GR-3)
    const idx = state.slices.findIndex((d) => dimKey(d) === dimKey(nd));
    const th = document.querySelectorAll('#main th.slicehead')[idx];
    if (th) { th.scrollIntoView({ block: 'nearest', inline: 'center' }); flash(th); }
    const need = missingParents(A, v.tableId, state.slices).find((x) => x.slice === idx);
    toast(need ? `Column added. It needs the ${need.parents.map((p) => shortLabel(p.member)).join(' › ')} column too (GR-3) — use “Add” in its heading.` : 'Column added.');
  } catch (e) { toast(e.message, true); }
}

function normDimsUI(dims) { return [...dims].map((d) => (d.typed != null ? { axis: d.axis, typed: String(d.typed) } : { axis: d.axis, member: d.member })).sort((a, b) => a.axis.localeCompare(b.axis)); }

// ------------------------------------------------------------------ modal: text block editor + confirmations
let modalState = null;
function openModal(title, body, foot, st) {
  modalState = st;
  st.opener = document.activeElement;
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-foot').innerHTML = foot;
  $('#modal').hidden = false;
}
function closeModal() {
  $('#modal').hidden = true; $('#modal-body').innerHTML = ''; const st = modalState; modalState = null; st?.after?.();
  if (st?.opener && document.contains(st.opener) && st.kind !== 'textblock') { try { st.opener.focus({ preventScroll: true }); } catch { /* not focusable */ } }
}
function openTextBlock(btn) {
  const { c, s, pl, t, slice } = btn.dataset;
  const dims = t != null && slice != null ? state.slices[Number(slice)] : [];
  const fact = t != null && slice != null ? S.getValue(c, s, dims, pl || null) : S.getValue(c, s, [], pl || null);
  const html = fact && !fact.nil ? fromMca(fact.value) : '';
  const issuesPanel = textBlockIssues(btn.dataset.cell, fact);
  const bar = RTE_BUTTONS.map(([cmd, label, name]) => `<button type="button" class="rte-btn rte-${cmd}" data-rte="${cmd}" title="${name}" aria-label="${name}">${label}</button>`).join('');
  openModal(`Edit Text Block — ${A.label(c)} (${s === 'CY' ? 'current year' : 'previous year'})`,
    `<p class="note">${esc(c)}</p>${issuesPanel}<div class="rte"><div class="rte-bar" role="toolbar" aria-label="Formatting">${bar}</div><div class="rte-body" id="tb-editor" role="textbox" aria-multiline="true" contenteditable="true" spellcheck="true">${html}</div></div>
     <div class="rte-opts"><label>Bold / italic / underline in the MCA PDF: <select id="tb-emphasis"><option value="highlight" ${S.filing.meta.textEmphasis === 'none' ? '' : 'selected'}>MCA highlight classes (highlightedText1/2/3 — rendered as shaded text)</option><option value="none" ${S.filing.meta.textEmphasis === 'none' ? 'selected' : ''}>Plain text (no emphasis)</option></select></label></div>
     <p class="note">Saved in the MCA HTML subset: lists → noteText1/2, indentation → noteText3, tables rebuilt without colgroup/colspan/rowspan (merged cells become empty cells), ▦ = cell borders (class "bordered"). The setting applies to the whole filing.</p>`,
    '<button type="button" class="btn" data-modal="cancel" id="tb-cancel">Cancel</button><button type="button" class="btn primary" data-modal="save" id="tb-save">Save Text</button>',
    { kind: 'textblock', dataset: { ...btn.dataset } });
  setTimeout(() => { const ed = $('#tb-editor'); if (!ed) return; ed.focus(); try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* optional */ } }, 0);
}
// Validation status of one text block, shown at the top of its editor. Reads the last validation result
// (issueIndex) and the gate's own HTML check of the stored value; nothing is re-implemented here.
function textBlockIssues(cellId, fact) {
  const list = (cellId && issueIndex().get(cellId)) || [];
  const stored = fact && !fact.nil ? htmlGuidelineIssues(fact.value, { detail: true }) : { errors: [], warnings: [] };
  const html = stored.errors.filter((e) => !e.startsWith('entity'));
  const items = [
    ...list.map((i) => `<li><span class="chip ${i.severity === 'ERROR' ? 'bad' : 'warn'}">${esc(i.severity)}</span> ${esc(i.message)}</li>`),
    ...(html.length && !list.some((i) => i.code === 'html') ? [`<li><span class="chip bad">HTML</span> The saved content contains HTML the MCA Validator rejects (${esc(html.join('; '))}). <b>Save Text</b> rebuilds it in the MCA subset.</li>`] : []),
  ];
  if (items.length) return `<div class="tb-issues ${list.some((i) => i.severity === 'ERROR') || html.length ? 'bad' : 'warn'}" role="alert"><b>${items.length} issue(s) for this text block</b><ul>${items.join('')}</ul></div>`;
  return `<div class="tb-issues ${state.gate ? 'ok' : ''}">${state.gate ? 'No validation issues for this text block in the last validation.' : 'Not validated yet — run <b>Validate</b> to check this text block.'}</div>`;
}
function modalAction(a) {
  const st = modalState;
  if (!st) return closeModal();
  if (a === 'save' && st.kind === 'textblock') {
    const ed = $('#tb-editor');
    const mca = toMca(ed.innerHTML, rteOpts());
    const value = plainText(mca) ? mca : '';
    const ok = cellChange({ dataset: st.dataset, value, classList: { add() {}, remove() {} }, set title(_) {} });
    if (ok === false) return; // error toast shown; keep the editor open
    closeModal();
    renderMain({ keepScroll: true });
    toast(value ? 'Text block saved. Run Validate to re-check it.' : 'Text block cleared.');
    const back = document.querySelector(`#main [data-textblock][data-c="${CSS.escape(st.dataset.c)}"][data-s="${st.dataset.s}"]${st.dataset.slice != null ? `[data-slice="${st.dataset.slice}"]` : ''}`);
    if (back) { back.focus(); flash(back); }
    return;
  }
  if (a === 'save' && st.kind === 'footnote') {
    const text = $('#fn-text')?.value || '';
    const existing = $('#fn-existing')?.value || '';
    try {
      if (text.trim()) addFootnote(S.filing, text, [st.key]);
      // one footnote per cell (all MCA-validated instances seen — INFOBAHN, GE Power — link each footnote to one fact)
      else if (existing) addFootnote(S.filing, S.filing.footnotes.get(existing).text, [st.key]);
      else { toast('Type a footnote or choose an existing one.', true); return; }
    } catch (e) { toast(e.message, true); return; }
    closeModal(); changed(); renderNav(); renderMain({ keepScroll: true });
    toast(text.trim() ? 'Footnote added.' : `Footnote added with the text of ${existing}.`);
    return;
  }
  if (a === 'continue' && st.kind === 'confirm') { const go2 = st.onContinue; closeModal(); go2(); return; }
  if (a === 'cancel' && st.kind === 'confirm') { const c2 = st.onCancel; closeModal(); c2?.(); return; }
  closeModal(); // cancel: nothing is changed
}
function confirmDialog(title, message, onContinue, onCancel, labels = {}) {
  openModal(title, `<div>${message}</div>`, `<button type="button" class="btn" data-modal="cancel" id="dlg-cancel">${esc(labels.cancel || 'Cancel')}</button><button type="button" class="btn primary" data-modal="continue" id="dlg-continue">${esc(labels.ok || 'Continue')}</button>`, { kind: 'confirm', onContinue, onCancel });
  $('#dlg-cancel')?.focus();
}

// Yes/No dependencies (compiled from the MCA conditional rules): how many entered values an answer would
// make non-applicable. Values are never deleted — they stay in the project and are excluded from filing.
function dependentValues(parent, scope, newValue) {
  let n = 0;
  for (const d of S.dependencies().filter((x) => x.parentConcept === parent)) {
    if ((newValue === 'true') === d.condition) continue;
    for (const c of d.childConcepts) n += S.filing.factsOf(c).filter((f) => reportingYear(S.filing.meta.periods, f.period) === scope && !f.nil).length;
    for (const id of d.tables) { const t = A.table(id); const items = new Set(t.lineItems); n += S.filing.all().filter((f) => items.has(f.concept) && f.dims.length && reportingYear(S.filing.meta.periods, f.period) === scope).length; }
  }
  return n;
}

function setCashFlow(value) {
  const q = A.qnameOfLocal('TypeOfCashFlowStatement');
  try {
    S.setValue(q, 'CY', value);
    changed(); renderNav(); renderMain({ keepScroll: true });
    toast(`${value}: ${value.startsWith('Direct') ? '[100300] enabled, [100400] disabled' : '[100400] enabled, [100300] disabled'}.`);
  } catch (e) { toast(e.message, true); }
}

// refresh calculated cells in place after an edit (no re-render: the next click must not be swallowed)
// Every numeric cell is refreshed (a derived cell — carrying amount, closing balance — and the same fact shown twice,
// e.g. the previous-year closing and the current-year opening, follow the edit); the calculated lock follows the data.
function refreshCalculated() {
  for (const el of document.querySelectorAll('#main input.cellin[data-c]')) {
    if (el.disabled) continue;
    const { c, s, pl, t, slice, tab, tabkey } = el.dataset;
    if (!A.isNumeric(c)) continue;
    const dims = t != null && slice != null ? state.slices[Number(slice)] : [];
    if (!dims) continue;
    const f = S.getValue(c, s, dims, pl || null);
    const v = f ? S.displayOf(f) : '';
    const elrUri = t != null ? A.table(t)?.presentationElr : tab;
    const calc = !!S.calculatedCell(c, s, dims, elrUri || null, pl || null);
    const locked = calc && !state.calcOverride[tabkey || tab];
    const was = el.classList.contains('calc');
    el.classList.toggle('calc', calc);
    el.classList.toggle('calc-open', calc && !locked);
    if (locked !== el.readOnly) {
      el.readOnly = locked;
      if (locked) { el.setAttribute('aria-readonly', 'true'); el.title = 'Calculated from its child elements (taxonomy calculation) — use the tab option to edit calculated cells'; }
      else { el.removeAttribute('aria-readonly'); if (el.title.startsWith('Calculated from')) el.title = ''; }
    }
    if (el !== document.activeElement && el.value !== v) { el.value = v; if (calc || was) flash(el); }
  }
}

// mandatory marks follow values in place (conditions such as "mandatory if > 0" change with the data)
function refreshMandatory() {
  for (const el of document.querySelectorAll('#main .cellin[data-c], #main [data-textblock][data-c]')) {
    if (el.disabled) continue;
    const { c, s, pl, t, slice } = el.dataset;
    const dims = t != null && slice != null ? state.slices[Number(slice)] : [];
    const m = mandatoryCell(S, c, s, dims, t || null);
    const f = t != null && slice != null ? S.getValue(c, s, dims, pl || null) : S.getValue(c, s, [], pl || null);
    el.classList.toggle('req', m.mandatory);
    el.classList.toggle('req-empty', m.mandatory && !(f && !f.nil));
    if (m.mandatory) el.dataset.req = m.rules.join(' '); else delete el.dataset.req;
  }
}

function cellChange(el) {
  const { c, s, pl, t, slice, tab, tabkey } = el.dataset;
  const key = tabkey || tab;
  const opts = { preferredLabel: pl || null, recalc: true, override: !!state.calcOverride[key] };
  const apply = () => {
    try {
      if (t != null && slice != null) S.setTableValue(t, s, state.slices[Number(slice)], c, el.value, { ...opts, lockCalculated: true });
      else S.setValue(c, s, el.value, { ...opts, tab: tab || null });
      el.classList.remove('bad'); el.classList.add('saved'); el.title = '';
      const f = t != null ? S.getValue(c, s, state.slices[Number(slice)], pl || null) : S.getValue(c, s, [], pl || null);
      if (f && A.dataType(c) === 'monetary' && 'value' in el && el.tagName) el.value = S.displayOf(f);
      changed();
      // answers that change applicability (Yes/No dependencies, cash-flow method, conditional tables) re-render
      const t2 = A.dataType(c);
      if (t2 === 'boolean' || t2 === 'enum') { renderNav(); renderMain({ keepScroll: true }); }
      else { refreshCalculated(); refreshMandatory(); refreshTotals(); }
      return true;
    } catch (e) {
      el.classList.add('bad'); el.title = e.message + (e.reasons ? '\n' + e.reasons.join('\n') : '');
      toast(e.message, true);
      return false;
    }
  };
  if (A.dataType(c) === 'boolean' && t == null) {
    const n = dependentValues(c, s, el.value);
    if (n > 0) {
      const prev = S.getValue(c, s, [], pl || null);
      confirmDialog('Change answer?', `Changing this answer to "${el.value === 'true' ? 'Yes' : 'No'}" will make <b>${n}</b> entered value(s) non-applicable. Existing values will be retained but excluded from filing/validation.`,
        apply, () => { el.value = prev ? prev.value : ''; });
      return true;
    }
  }
  return apply();
}

boot();
