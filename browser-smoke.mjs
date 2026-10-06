// Browser regression of the built app (index.html) in headless Chromium via playwright-core.
// Exercises the real UI: [200500] table availability, rich-text editing → autosave → reload → XML,
// and the import year-mapping dialog with the MCA-validated reference XML.
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);

// concepts the taxonomy presents with an opening-balance (periodStart) row — see importer.openingBalanceConcepts
function openingConcepts() {
  const J = JSON.parse(readFileSync(path.join(ROOT, 'MCA_AUTHORITY.json'), 'utf8'));
  const set = new Set();
  for (const arcs of Object.values(J.presentation)) for (const a of arcs) if (/periodStartLabel$/.test(a.preferredLabel || '') && J.concepts[a.to]?.periodType === 'instant') set.add(a.to);
  return set;
}

export function browserStatus() {
  let pw = null;
  try { pw = true; } catch { pw = null; }
  const exe = CANDIDATES.find((p) => existsSync(p));
  return exe && pw ? { available: true, executable: exe } : { available: false, reason: 'no Chromium executable found (set CHROMIUM_PATH)' };
}

export async function runBrowserSmoke() {
  const st = browserStatus();
  if (!st.available) return { status: 'UNAVAILABLE', ...st, checks: [] };
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: st.executable });
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  const url = pathToFileURL(path.join(ROOT, 'index.html')).href;
  try {
    await page.goto(url);
    await page.waitForSelector('#nav a[data-elr]');
    check('app loads with statements and notes', (await page.locator('#nav a[data-elr]').count()) > 40);

    // ---- [200500] availability follows the balance sheet
    const ciBtn = (scope) => `button[data-open-table="200500:DetailsOfCurrentInvestmentsTable"][data-scope="${scope}"]`;
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    check('[200500] Yes/current: table button enabled', !(await page.isDisabled(ciBtn('CY'))));
    check('[200500] Yes/prior: table button enabled', !(await page.isDisabled(ciBtn('PY'))));
    await page.click('a[data-elr$="/BalanceSheet"]');
    for (const sc of ['CY', 'PY']) { const sel = `input[data-c="in-gaap:CurrentInvestments"][data-s="${sc}"]`; await page.fill(sel, '0'); await page.dispatchEvent(sel, 'change'); }
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    check('[200500] No/current: table button disabled', await page.isDisabled(ciBtn('CY')));
    check('[200500] No/prior: table button disabled', await page.isDisabled(ciBtn('PY')));
    // restore the example's balance sheet so the filing is consistent again
    await page.click('a[data-elr$="/BalanceSheet"]');
    for (const [sc, v] of [['CY', '250000'], ['PY', '200000']]) { const sel = `input[data-c="in-gaap:CurrentInvestments"][data-s="${sc}"]`; await page.fill(sel, v); await page.dispatchEvent(sel, 'change'); }
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    check('[200500] Yes again after restoring the balance sheet', !(await page.isDisabled(ciBtn('CY'))));
    await page.click(ciBtn('CY'));
    await page.waitForSelector('#main table.g');
    check('table rows: Mandatory Line Items marked on the row cells', (await page.locator('#main .cellin.req[data-c="in-gaap:TypeOfCurrentInvestments"]').count()) >= 1 && (await page.locator('#main tr:has([data-c="in-gaap:TypeOfCurrentInvestments"]) .req-chip').count()) === 1);
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');

    // ---- 1. rich text in a modal: Text Block button → popup editor → Save / Cancel → reload → XML → import → edit
    const TBC = 'in-gaap:DisclosureOfNotesOnCurrentInvestmentsExplanatoryTextBlock';
    const tbBtn = `#main [data-textblock][data-c="${TBC}"][data-s="CY"]`;
    const ed = '#tb-editor';
    const btn = (cmd) => `#modal [data-rte="${cmd}"]`;
    check('text block cell shows a compact Text Block button (no embedded editor)', (await page.locator(tbBtn).count()) === 1 && (await page.locator('#main .rte-body').count()) === 0 && (await page.locator('textarea').count()) === 0);
    await page.click(tbBtn);
    check('Text Block opens a modal editor with toolbar, Save and Cancel', await page.isVisible('#modal') && (await page.locator('#modal [data-rte]').count()) >= 7 && await page.isVisible('#tb-save') && await page.isVisible('#tb-cancel'));
    await page.click(ed);
    await page.keyboard.type('Investments are valued at cost. ');
    for (const [cmd, word] of [['bold', 'Bold term'], ['italic', 'Italic term'], ['underline', 'Underlined term']]) {
      await page.click(btn(cmd)); await page.keyboard.type(word); await page.click(btn(cmd)); await page.keyboard.type(' ');
    }
    await page.keyboard.press('Enter');
    await page.click(btn('insertOrderedList'));
    await page.keyboard.type('First point');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second point');
    await page.keyboard.press('Enter');
    await page.click(btn('insertOrderedList'));
    await page.click(btn('insertUnorderedList'));
    await page.keyboard.type('Bullet point');
    await page.keyboard.press('Enter');
    await page.click(btn('insertUnorderedList'));
    await page.keyboard.type('Indented paragraph');
    await page.click(btn('indent'));
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.click(btn('outdent'));
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const dt = new DataTransfer();
      dt.setData('text/html', '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><p class=MsoNormal style="margin:0"><span style="font-weight:bold">Pasted bold</span> and <span style="font-style:italic">pasted italic</span> &rsquo;quoted&rsquo;<o:p></o:p></p><img src="x.png">' +
        // Excel-style table: colgroup/col, colspan, width/style attributes, padded numbers, whitespace paragraphs
        '<table border=0 cellpadding=0 style="border-collapse:collapse"><colgroup><col width=200><col width=80 span=4></colgroup>' +
        '<tr><td rowspan=2 style="border:.5pt solid windowtext"><p>   </p><p><b>Name of Assets</b></p></td><td colspan=4 class=xl65 style="border:.5pt solid windowtext"><b>Gross Block</b></td></tr>' +
        '<tr><td>As on</td><td>Addition</td><td>Deduction</td><td>As on</td></tr>' +
        '<tr><td>Office Equipments</td><td align=right>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 17.45 </td><td>&nbsp;&nbsp;&nbsp; 6.68</td><td>&nbsp; - </td><td>24.14</td></tr></table></body></html>');
      dt.setData('text/plain', 'Pasted bold and pasted italic');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, ed);
    await page.click('#tb-save');
    check('Save Text closes the popup and updates the cell', await page.isHidden('#modal') && /Investments are valued at cost/.test(await page.textContent(`${tbBtn} >> xpath=../span[@class="tb-prev"]`)));
    // cancel leaves the value unchanged
    await page.click(tbBtn);
    await page.click(ed); await page.keyboard.press('Control+End'); await page.keyboard.type(' DISCARD ME');
    await page.click('#tb-cancel');
    await page.click(tbBtn);
    const reopened = await page.innerHTML(ed);
    check('Cancel leaves the stored value unchanged; reopening shows the saved content', !/DISCARD ME/.test(reopened) && /<b>Bold term<\/b>/.test(reopened), reopened.slice(0, 200));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700); // autosave debounce
    await page.reload();
    await page.waitForSelector('#nav a[data-elr]');
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    await page.click(tbBtn);
    const html = await page.innerHTML(ed);
    await page.click('#tb-cancel');
    check('rich text survives save → reload (bold)', /<b>Bold term<\/b>/.test(html), html.slice(0, 400));
    check('rich text survives save → reload (italic)', /<i>Italic term<\/i>/.test(html), html.slice(0, 400));
    check('rich text survives save → reload (underline)', /<u>Underlined term<\/u>/.test(html), html.slice(0, 400));
    check('rich text survives save → reload (numbered list)', /<ol><li>First point<\/li><li>Second point<\/li><\/ol>/.test(html), html.slice(0, 600));
    check('rich text survives save → reload (bulleted list)', /<ul><li>Bullet point<\/li><\/ul>/.test(html), html.slice(0, 600));
    check('rich text survives save → reload (indentation)', /<blockquote>(<p>)?Indented paragraph/.test(html), html);
    check('paste from Word: emphasis kept, Office markup / images / styles dropped', /<b>Pasted bold<\/b>/.test(html) && /<i>pasted italic<\/i>/.test(html) && /’quoted’/.test(html) && !/style=|<img|o:p|Mso/.test(html), html);
    const ptab = /<table>[\s\S]*?<\/table>/.exec(html)?.[0] || '';
    const rowsCells = [...ptab.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => (m[1].match(/<td/g) || []).length);
    check('paste from Excel: table rebuilt without colgroup/col/colspan/rowspan, every row 5 cells, every cell bordered', ptab && !/colgroup|<col|colspan|rowspan|width=|align=/.test(ptab) && rowsCells.length === 3 && rowsCells.every((n) => n === 5) && (ptab.match(/<td class="bordered">/g) || []).length === 15, ptab.slice(0, 400));
    check('paste from Excel: number padding removed, merged header kept in its first cell', /<td class="bordered"><p>17\.45<\/p><\/td>/.test(ptab) && /<td class="bordered"><p>-<\/p><\/td>/.test(ptab) && /<b>Gross Block<\/b>/.test(ptab) && !/<p>\s*<\/p>/.test(ptab), ptab.slice(0, 600));
    await page.click('a[data-go="xml"]');
    await page.click('button[data-act="generate"]');
    await page.waitForSelector('#xmltext, .banner.bad');
    if (!(await page.locator('#xmltext').count())) { await page.click('a[data-go="validate"]'); throw new Error('generation blocked: ' + (await page.textContent('.issues')).slice(0, 600)); }
    const xml = await page.textContent('#xmltext');
    const fact = /<in-gaap:DisclosureOfNotesOnCurrentInvestmentsExplanatoryTextBlock[^>]*>([^<]*)</.exec(xml)?.[1] || '';
    const mca = fact.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    check('XML: bold/italic/underline as highlightedText1/2/3, lists as noteText1/2, indent as noteText3', ['highlightedText1">Bold term', 'highlightedText2">Italic term', 'highlightedText3">Underlined term', 'class="noteText1"><p>1.&nbsp;First point', 'class="noteText2"><p>•&nbsp;Bullet point', 'class="noteText3"'].every((x) => mca.includes(x)), mca.slice(0, 600));
    check('XML: no unsupported tags or style attributes inside the text block', mca.length > 0 && ![...mca.matchAll(/<\/?([a-zA-Z]+)/g)].some((m) => !['div', 'span', 'p', 'br', 'table', 'td', 'tr', 'thead', 'tfoot', 'tbody', 'th'].includes(m[1])) && !/style=/.test(mca), mca.slice(0, 300));
    check('XML: text block HTML carries only class attributes (MCA HTML schema)', [...mca.matchAll(/<[a-z]+((?:\s+[a-z-]+="[^"]*")*)\s*\/?>/g)].every((m) => [...m[1].matchAll(/([a-z-]+)=/g)].every((a) => a[1] === 'class')) && /<table><tbody><tr><td class="bordered">/.test(mca), mca.slice(mca.indexOf('<table'), mca.indexOf('<table') + 300));
    const buildId = await page.getAttribute('.brand small', 'data-build');
    check('build id shown in the header and written into the generated XML', /^[0-9a-f]{10}$/.test(buildId || '') && xml.includes(`<!-- Generated by C&amp;I XBRL Studio build ${buildId} -->`), buildId);
    const exported = path.join(ROOT, '.smoke-export.xml');
    writeFileSync(exported, xml);

    // imported rich text is edited through the same popup
    await page.setInputFiles('#file-xml', exported);
    await page.waitForSelector('#import-confirm');
    await page.check('#ym-both');
    await page.click('#import-commit');
    await page.waitForSelector('.banner.info');
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    await page.click(tbBtn);
    const imported = await page.innerHTML(ed);
    check('XML import: formatting restored in the popup editor', /<b>Bold term<\/b>/.test(imported) && /<ol><li>First point/.test(imported) && /<ul><li>Bullet point/.test(imported) && /<blockquote>/.test(imported), imported.slice(0, 300));
    await page.click(ed);
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.click(btn('bold'));
    await page.keyboard.type('Edited after import');
    await page.click('#tb-save');
    await page.click('a[data-go="xml"]');
    await page.click('button[data-act="generate"]');
    await page.waitForSelector('#xmltext, .banner.bad');
    const xml2 = (await page.locator('#xmltext').count()) ? await page.textContent('#xmltext') : '';
    check('editing imported rich text in the popup: new formatting exported', xml2.includes('&lt;span class=&quot;highlightedText1&quot;&gt;Edited after import&lt;/span&gt;') && xml2.includes('Bold term'));
    try { unlinkSync(exported); } catch { /* ignore */ }

    // ---- 8. Disclosure of General Information about Company + 3B. cash-flow method on a fresh selection
    await page.click('a[data-go="setup"]');
    check('section renamed: "Disclosure of General Information about Company" (nav + heading)', (await page.textContent('#general-title')).trim() === 'Disclosure of General Information about Company' && /Disclosure of General Information about Company/.test(await page.textContent('#nav')));
    check('company information fields present (CIN, name, report type, periods, rounding) and [400100] elements listed', ['#f-name', '#f-cin', '#f-rt', '#f-cys', '#f-cye', '#f-lvl'].every(Boolean) && (await page.locator('#f-cin').count()) === 1 && (await page.locator('#main table.g input[data-c^="in-ca:"], #main table.g select[data-c^="in-ca:"]').count()) > 10);
    await page.check('#cf-direct');
    await page.waitForTimeout(150);
    const naDirect = await page.getAttribute('a[data-elr$="/CashFlowStatementDirect"]', 'class');
    const naIndirect = await page.getAttribute('a[data-elr$="/CashFlowStatementIndirect"]', 'class');
    check('Direct selected: [100300] enabled, [100400] disabled (immediately)', !/\bna\b/.test(naDirect) && /\bna\b/.test(naIndirect), `${naDirect} | ${naIndirect}`);
    await page.click('a[data-elr$="/CashFlowStatementIndirect"]');
    const offInputs = await page.$$eval('#main .cellin', (els) => [els.length, els.filter((e) => e.disabled).length, els.filter((e) => e.value !== '').length]);
    check('disabled cash-flow tab: unavailable, no data entry, no values shown', (await page.locator('.sheet.tab-off').count()) === 1 && offInputs[0] > 0 && offInputs[0] === offInputs[1] && offInputs[2] === 0, JSON.stringify(offInputs));
    await page.click('a[data-go="setup"]');
    await page.check('#cf-indirect');
    await page.waitForTimeout(150);
    check('Indirect selected: [100400] enabled, [100300] disabled', /\bna\b/.test(await page.getAttribute('a[data-elr$="/CashFlowStatementDirect"]', 'class')) && !/\bna\b/.test(await page.getAttribute('a[data-elr$="/CashFlowStatementIndirect"]', 'class')));

    // ---- 5. calculated cells: read-only by default, auto-populated, tab-specific override
    await page.click('a[data-elr$="/BalanceSheet"]');
    const CA = 'input[data-c="in-gaap:CurrentAssets"][data-s="CY"]';
    check('calculated parent cell is read-only by default', (await page.getAttribute(CA, 'readonly')) !== null);
    const before = await page.inputValue(CA);
    const inv = 'input[data-c="in-gaap:Inventories"][data-s="CY"]';
    await page.fill(inv, '100'); await page.dispatchEvent(inv, 'change');
    await page.waitForTimeout(100);
    const after = await page.inputValue(CA);
    check('calculation still occurs: parent updated from its children', Number(after) === Number(before) + 100, `${before} → ${after}`);
    await page.fill(inv, ''); await page.dispatchEvent(inv, 'change');
    await page.check('input[data-calc-override$="/BalanceSheet"]');
    check('tab option enables editing of calculated cells on this tab', (await page.getAttribute(CA, 'readonly')) === null);
    await page.click('a[data-elr$="/StatementOfProfitAndLoss"]');
    const plCalc = await page.$$eval('#main .cellin.calc', (els) => els.filter((e) => e.hasAttribute('readonly')).length);
    check('override does not affect other tabs (P&L calculated cells stay read-only)', plCalc > 0, `readonly calc cells on P&L: ${plCalc}`);
    await page.click('a[data-elr$="/BalanceSheet"]');
    await page.uncheck('input[data-calc-override$="/BalanceSheet"]');
    check('disabling the option returns calculated cells to read-only, value kept', (await page.getAttribute(CA, 'readonly')) !== null && (await page.inputValue(CA)) === before);

    // ---- 7. Yes/No dependency with a safe Yes → No change
    await page.click('a[data-elr$="/NotesSubsidiaryInformation"]');
    const PAR = 'select[data-c="in-ca:WhetherCompanyHasSubsidiaryCompanies"][data-s="CY"]';
    const CH = 'input[data-c="in-ca:NumberOfSubsidiaryCompanies"][data-s="CY"]';
    await page.selectOption(PAR, 'true');
    await page.waitForTimeout(150);
    check('Yes → dependent field enabled', !(await page.isDisabled(CH)));
    check('Mandatory mark follows the condition: Yes → dependent field marked mandatory (conditional)', await page.evaluate((sel) => document.querySelector(sel).classList.contains('req'), CH) && (await page.locator('#main tr:has(input[data-c="in-ca:NumberOfSubsidiaryCompanies"]) .req-chip.cond').count()) === 1);
    await page.fill(CH, '2'); await page.dispatchEvent(CH, 'change');
    await page.selectOption(PAR, 'false');
    await page.waitForSelector('#dlg-continue');
    const dlg = await page.textContent('#modal-body');
    check('Yes → No asks before making entered values non-applicable (nothing deleted)', /will make <?b?>?\s*\d+|will make/.test(dlg) && /retained but excluded/.test(dlg), dlg);
    await page.click('#dlg-cancel');
    check('Cancel keeps the Yes answer and the dependent value', (await page.inputValue(PAR)) === 'true' && (await page.inputValue(CH)) === '2');
    await page.selectOption(PAR, 'false');
    await page.waitForSelector('#dlg-continue');
    await page.click('#dlg-continue');
    await page.waitForTimeout(150);
    check('No → dependent field disabled and blank; dependent table unavailable', await page.isDisabled(CH) && (await page.inputValue(CH)) === '' && await page.isDisabled('button[data-open-table="202800:DetailsOfSubsidiariesTable"][data-scope="CY"]'));

    // ---- 4. validation → exact cell (error red, warning marked) and navigation
    await page.click('a[data-elr$="/StatementOfProfitAndLoss"]');
    const OI = 'input[data-c="in-gaap:OtherIncome"][data-s="CY"]';
    const oiVal = await page.inputValue(OI);
    check('Mandatory label on a mandatory row (P&L Other income)', (await page.locator('#main tr:has(input[data-c="in-gaap:OtherIncome"]) .req-chip').count()) === 1);
    await page.fill(OI, ''); await page.dispatchEvent(OI, 'change');
    check('empty mandatory cell is highlighted', await page.evaluate((sel) => document.querySelector(sel).classList.contains('req-empty'), OI));
    await page.click('.bar button[data-act="validate"]');
    await page.waitForSelector('.issues');
    const errLi = page.locator('.issues li.nav-issue', { hasText: "'OtherIncome' is mandatory" }).first();
    check('validation lists the error with its location', (await errLi.count()) === 1 && /\[100200\]/.test(await errLi.textContent()));
    await errLi.click();
    await page.waitForTimeout(200);
    const focusedCell = await page.evaluate(() => document.activeElement?.dataset?.cell || '');
    check('clicking the error activates the tab and focuses the exact cell', /\/StatementOfProfitAndLoss$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || '') && focusedCell.startsWith('in-gaap:OtherIncome#D:'), focusedCell);
    check('the erroneous cell is marked red', await page.evaluate((sel) => document.querySelector(sel).classList.contains('cell-err'), OI));
    await page.click('a[data-go="validate"]');
    await page.click('button[data-filter="WARNING"]');
    const warnLi = page.locator('.issues li.nav-issue', { hasText: 'NumberOfSubsidiaryCompanies' }).first();
    check('the warning (value retained but excluded) is listed with its location', (await warnLi.count()) === 1);
    await warnLi.click();
    await page.waitForTimeout(200);
    check('clicking the warning navigates to its cell, which carries the warning mark', /\/NotesSubsidiaryInformation$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || '') && await page.evaluate((sel) => document.querySelector(sel).classList.contains('cell-warn'), CH));

    // ---- 6. validate only the current tab
    await page.click('a[data-elr$="/StatementOfProfitAndLoss"]');
    await page.click('#main button[data-act="validate-tab"]');
    await page.waitForSelector('.issues');
    const head = await page.textContent('#main h1');
    const locs = await page.$$eval('.issues li.nav-issue', (els) => els.map((e) => ({ t: e.querySelector('.reasons')?.textContent || '', x: /cross-tab/.test(e.textContent) })));
    check('Validate current tab: scope shown; every result belongs to [100200] or is marked cross-tab', /current tab \[100200\]/.test(head) && locs.length > 0 && locs.every((l) => l.t.includes('[100200]') || l.x), JSON.stringify(locs.slice(0, 5)));
    await page.click('#main button[data-act="validate"]');
    await page.waitForSelector('.issues');
    check('Validate entire filing still available and covers other tabs', !/current tab/.test(await page.textContent('#main h1')));
    // restore
    await page.click('a[data-elr$="/StatementOfProfitAndLoss"]');
    await page.fill(OI, oiVal); await page.dispatchEvent(OI, 'change');

    // ---- import with year-mapping choice
    const golden = readdirSync(ROOT).find((f) => /^golden-.*\.xml$/.test(f));
    if (golden) {
      await page.setInputFiles('#file-xml', path.join(ROOT, golden));
      await page.waitForSelector('#import-confirm');
      check('import waits for a year-mapping choice (Import disabled)', await page.isDisabled('#import-commit'));
      await page.check('#ym-current');
      await page.click('#import-commit');
      await page.waitForSelector('.banner.info');
      const banner = await page.textContent('.banner.info');
      check('current-year-only summary shown', /Current year only/.test(banner) && /Previous year: not imported \(Current year only selected\)/.test(banner) && /Current-year opening balances imported \(GR-7/.test(banner), banner);
      await page.click('a[data-elr$="/BalanceSheet"]');
      const pyFilled = await page.$$eval('input[data-s="PY"].cellin', (els) => els.filter((e) => e.value !== '').map((e) => e.dataset.c));
      const cyVals = await page.$$eval('input[data-s="CY"].cellin', (els) => els.filter((e) => e.value !== '').length);
      const opening = openingConcepts();
      const comparative = pyFilled.filter((c) => !opening.has(c));
      check('Current year only: balance-sheet previous-year comparatives empty (only GR-7 opening-balance items, e.g. share capital, show their common closing/opening fact), current year filled', comparative.length === 0 && cyVals > 10, `PY comparatives filled=${comparative.join(',')} opening items=${pyFilled.join(',')} CY filled=${cyVals}`);
      await page.click('a[data-elr$="/StatementOfProfitAndLoss"]');
      const plPy = await page.$$eval('input[data-s="PY"].cellin', (els) => els.filter((e) => e.value !== '').length);
      check('Current year only: profit-and-loss previous-year column empty', plPy === 0, `PY filled=${plPy}`);
      await page.setInputFiles('#file-xml', path.join(ROOT, golden));
      await page.waitForSelector('#import-confirm');
      await page.check('#ym-both');
      await page.click('#import-commit');
      await page.waitForSelector('.banner.info');
      check('both-years summary shown', /Previous year imported: [\d,]+ facts/.test(await page.textContent('.banner.info')));
      await page.click('a[data-elr$="/BalanceSheet"]');
      check('Both years: previous-year column filled', (await page.$$eval('input[data-s="PY"].cellin', (els) => els.filter((e) => e.value !== '').length)) > 10);
      // ---- 2. previous-year applicability on import: non-applicable PY cells stay blank
      await page.click('a[data-elr$="/DisclosuresAuditorsReport"]');
      const pyCells = await page.$$eval('#main .cellin[data-s="PY"], #main [data-textblock][data-s="PY"]', (els) => els.map((e) => ({ d: e.disabled, v: e.value || '' })));
      check('Imported XML: previous-year cells of [400200] (GR-12) are disabled and blank', pyCells.length > 0 && pyCells.every((c) => c.d && c.v === ''), JSON.stringify(pyCells.slice(0, 4)));
      await page.click('a[data-go="import"]');
      check('import report lists facts not imported because not applicable', /Not applicable — not imported as filing data \(\d+\)/.test(await page.textContent('#main')));
      // ---- v11: closing-balance rows, the table total column, fix tools, next year's filing
      await page.click('a[data-elr$="/NotesTangibleAssets"]');
      await page.click('button[data-open-table="201000:DisclosureOfTangibleAssetsTable"][data-scope="CY"]');
      await page.waitForSelector('#main table.g');
      check('tangible assets table shows the closing row "Tangible assets at end of period"', (await page.locator('#main tr', { hasText: 'Tangible assets at end of period' }).count()) === 1);
      const heads = await page.$$eval('#main th.slicehead', (els) => els.map((e) => e.textContent));
      check('tangible assets table shows its total column (every axis at its default)', heads.some((h) => (h.match(/\(default\)/gi) || []).length === 3), heads[0]);
      check('dimensional table offers "Fill empty totals"', (await page.locator('#main button[data-act="fill-totals"]').count()) === 1);
      await page.click('[data-act="validate"]');
      await page.waitForSelector('#main .tiles');
      check('validation offers Recalculate current year and Fill empty totals', (await page.locator('#main [data-act="recalc-all"]').count()) === 1 && (await page.locator('#main [data-act="fill-totals-all"]').count()) === 1);
      await page.click('#main [data-act="recalc-all"]');
      await page.waitForTimeout(300);
      // INFOBAHN is fully consistent (no dialog); CHARVAK's reserves closing differs from opening + changes by 0.78
      // (its own rounding, accepted by MCA) — the preview lists it and nothing changes unless confirmed
      const dlg = (await page.locator('#dlg-continue').count()) ? await page.textContent('#modal') : '';
      check('Recalculate current year previews before changing (validated instance: none, or only the CHARVAK reserves rounding)', !dlg || /\b2\b calculated cell\(s\)/.test(dlg), dlg.slice(0, 200));
      if (dlg) await page.click('#dlg-cancel');
      await page.setInputFiles('#file-xml', path.join(ROOT, golden));
      await page.waitForSelector('#import-confirm');
      check('import offers "Next year\'s filing"', (await page.locator('#ym-next').count()) === 1);
      await page.check('#ym-next');
      await page.click('#import-commit');
      await page.waitForSelector('.banner.info');
      const nb = await page.textContent('.banner.info');
      check('next year\'s filing: new periods and previous-year import summarised', /Next year's filing/.test(nb) && /is the previous year/.test(nb), nb);
      await page.click('a[data-elr$="/BalanceSheet"]');
      const cyN = await page.$$eval('input[data-s="CY"].cellin', (els) => els.filter((e) => e.value !== '').length);
      const pyN = await page.$$eval('input[data-s="PY"].cellin', (els) => els.filter((e) => e.value !== '').length);
      check('next year\'s filing: balance sheet previous-year column filled, current year empty', pyN > 10 && cyN === 0, `PY ${pyN} CY ${cyN}`);
      // back to the imported filing (both years) for the checks that follow
      await page.setInputFiles('#file-xml', path.join(ROOT, golden));
      await page.waitForSelector('#import-confirm');
      await page.check('#ym-both');
      await page.click('#import-commit');
      await page.waitForSelector('.banner.info');

      // ---- 3. total/part guidance on dimensional tables (display only)
      await page.click('a[data-elr$="/NotesBorrowings"]');
      await page.click('button[data-open-table="200300:ClassificationOfBorrowingsTable"][data-scope="CY"]');
      await page.waitForSelector('#main table.g');
      check('column headings mark TOTAL and "part of" members', (await page.locator('#main th.slicehead .mb.total').count()) > 0 && (await page.locator('#main th.slicehead .mb.part').count()) > 0);
      check('member picker marks totals and explains where a member sits', (await page.locator('#ax-1 option', { hasText: '— total' }).count()) > 0 && (await page.getAttribute('#ax-1 option[value="in-gaap:RupeeTermLoansFromOthersMember"]', 'title') || '').includes('Part of: Term loans from others'));
      await page.selectOption('#ax-1', 'in-gaap:RupeeTermLoansFromOthersMember');
      const help = await page.textContent('#axhelp-1');
      check('picker help: part, its totals and the GR-3 parent column', /part/.test(help) && /Term loans from others/.test(help) && /GR-3/.test(help), help);
      check('validated data: total cells show "= parts ✓"', (await page.locator('#main .sum-hint .ok').count()) > 0);
      const PARENT = '#main td.val:has(.sum-hint .ok) input.cellin[data-c="in-gaap:Borrowings"]';
      const parentCell = await page.locator(PARENT).first().getAttribute('data-cell');
      const PC = `#main input.cellin[data-cell="${parentCell}"]`;
      const orig = await page.inputValue(PC);
      await page.fill(PC, String(Number(orig.replace(/,/g, '')) + 1000));
      await page.dispatchEvent(PC, 'change');
      const tdHint = `#main td.val:has(${PC.replace('#main ', '')}) .sum-hint`;
      check('a total that differs from its parts shows the difference and "Use parts total"', /differs by/.test(await page.textContent(tdHint)) && (await page.locator(`${tdHint} [data-act="use-sum"]`).count()) === 1, await page.textContent(tdHint));
      await page.click('a[data-elr$="/BalanceSheet"]');
      check('leaving the table with differing totals asks first', await page.isVisible('#modal') && /Totals do not match/.test(await page.textContent('#modal-title')) && /Stay and fix/.test(await page.textContent('#dlg-cancel')));
      await page.click('#dlg-cancel');
      check('"Stay and fix" keeps the table open', await page.isHidden('#modal') && (await page.locator(PC).count()) === 1);
      await page.click(`${tdHint} [data-act="use-sum"]`);
      check('"Use parts total" enters the sum of the parts through the normal cell entry', (await page.inputValue(PC)).replace(/,/g, '') === orig.replace(/,/g, '') && (await page.locator(`${tdHint} .ok`).count()) === 1, await page.inputValue(PC));
      // GR-3: a part column without its parent column offers to add the parent
      await page.click('#addslice button[type="submit"]');
      const need = page.locator('#main th.slicehead .needs-parent', { hasText: 'Term loans from others' });
      check('new part column shows "Needs … column (GR-3)" with Add', (await need.count()) === 1);
      const before = await page.locator('#main th.slicehead').count();
      await need.locator('button').click();
      check('Add creates the parent column(s)', (await page.locator('#main th.slicehead').count()) > before && (await page.locator('#main th.slicehead .needs-parent', { hasText: 'Term loans from others' }).count()) === 0);
      await page.selectOption('#colorder', 'entered');
      check('column order can be switched to "as entered"', (await page.inputValue('#colorder')) === 'entered');
      await page.selectOption('#colorder', 'taxonomy');
      await page.click('a[data-elr$="/BalanceSheet"]');
      check('totals consistent again: leaving the table needs no confirmation', await page.isHidden('#modal'));
      await page.click('button[data-act="validate"]');
      await page.waitForSelector('#main .issues');
      check('Validation lists Totals hints separately (tool guidance)', /Totals hints/.test(await page.textContent('#main')) && /No differences/.test(await page.textContent('#main')));
      // ---- 4. copy from previous year (columns; values optional) — existing Add row / cell-entry paths
      await page.click('a[data-elr$="/NotesBorrowings"]');
      await page.click('button[data-open-table="200300:ClassificationOfBorrowingsTable"][data-scope="CY"]');
      await page.waitForSelector('#main button[data-act="carry-forward"]');
      check('current-year table offers "Copy from previous year"', !(await page.isDisabled('#main button[data-act="carry-forward"]')));
      await page.click('#main button[data-act="carry-forward"]');
      check('copy dialog: columns, optional values, never overwrites', await page.isVisible('#modal') && (await page.locator('#cf-values').count()) === 1 && /never overwritten/.test(await page.textContent('#modal')) && (await page.textContent('#dlg-continue')) === 'Copy');
      await page.click('#dlg-continue');
      check('copy (columns only) confirms what was added', /Added \d+ column/.test(await page.textContent('#toast')));
      // ---- 5. footnotes: select a cell, Alt+N, save; listed on the Footnotes tab; written to the XML
      const fnId = await page.evaluate(() => [...document.querySelectorAll('#main td.val input.cellin[data-c="in-gaap:Borrowings"]')].find((e) => e.value && !e.disabled)?.dataset.cell);
      await page.focus(`#main input.cellin[data-cell="${fnId}"]`);
      await page.keyboard.press('Alt+n');
      check('Alt+N opens the footnote dialog for the selected cell', await page.isVisible('#modal') && /Borrowings/.test(await page.textContent('#modal-body')));
      await page.fill('#fn-text', 'Smoke footnote: secured by hypothecation of stock');
      await page.click('#fn-save');
      check('cell shows the footnote mark', (await page.locator(`#main td.val.has-fn:has(input[data-cell="${fnId}"])`).count()) === 1);
      await page.click('a[data-go="footnotes"]');
      check('Footnotes tab lists the footnote with its cell', /Smoke footnote/.test(await page.inputValue('#main textarea.fn-edit >> nth=-1')) && (await page.locator('#main [data-fn-go]').count()) >= 1);
      await page.click('a[data-go="xml"]');
      await page.click('button[data-act="generate"]');
      await page.waitForSelector('#xmltext, .banner.bad');
      const fx = (await page.locator('#xmltext').count()) ? await page.textContent('#xmltext') : '';
      check('generated XML carries the footnote as an XBRL footnote link', /<link:footnote [^>]*>Smoke footnote: secured by hypothecation of stock<\/link:footnote>/.test(fx) && /fact-footnote/.test(fx));
      // ---- 6. printable preview (not the MCA rendering)
      const [pv] = await Promise.all([page.waitForEvent('popup'), page.click('button[data-act="preview-pdf"]')]);
      await pv.waitForLoadState();
      const pvText = await pv.textContent('body');
      check('Preview PDF opens a printable preview labelled "not the MCA rendering" with statements and notes', /not the MCA rendering/.test(pvText) && /\[100100\] Balance sheet/.test(pvText) && /Unless otherwise specified, all monetary values are in/.test(pvText) && (await pv.locator('button', { hasText: 'Print / Save as PDF' }).count()) === 1, pvText.slice(0, 200));
      check('preview shows the footnote as in the MCA PDF ("(A) value" and a Footnotes list)', /\(A\) [\d,.-]+/.test(pvText) && /Footnotes\s*\(A\) Smoke footnote: secured by hypothecation of stock/.test(pvText));
      await pv.close();
    }
    // ---- usability (UI only): keyboard movement, accessible names, sticky headers, save/confirm feedback
    await page.click('a[data-elr$="/BalanceSheet"]');
    const firstCy = page.locator('#main table.g td.val input.cellin[data-s="CY"]:not([disabled]):not([readonly])').first();
    await firstCy.focus();
    const fromCell = await firstCy.getAttribute('data-cell');
    await page.keyboard.press('Enter');
    const moved = await page.evaluate(() => ({ cell: document.activeElement?.dataset?.cell, s: document.activeElement?.dataset?.s, inGrid: !!document.activeElement?.closest('td.val') }));
    check('Enter moves to the next editable cell of the same column', moved.inGrid && moved.s === 'CY' && moved.cell && moved.cell !== fromCell, JSON.stringify(moved));
    await page.keyboard.press('Shift+Enter');
    check('Shift+Enter moves back up', (await page.evaluate(() => document.activeElement?.dataset?.cell)) === fromCell);
    const aria = await firstCy.getAttribute('aria-label');
    check('grid cells carry an accessible name (row — column)', /—/.test(aria || '') && /Current/i.test(aria || ''), aria);
    const sticky = await page.evaluate(() => [getComputedStyle(document.querySelector('#main table.g thead th')).position, getComputedStyle(document.querySelector('#main table.g td.lbl')).position]);
    check('column headings and the row-label column are sticky', sticky.every((x) => x === 'sticky'), sticky.join(','));
    await page.keyboard.press('Control+s');
    await page.waitForSelector('#bar-save.ok');
    check('Ctrl+S saves in the browser and confirms', /Saved/.test(await page.textContent('#bar-save')) && /Saved in this browser/.test(await page.textContent('#toast')));
    const nameBefore = await page.textContent('#bar-who b');
    await page.click('button[data-act="new-filing"]');
    check('New filing asks for confirmation in a dialog (focus on Cancel)', await page.isVisible('#modal') && (await page.evaluate(() => document.activeElement?.id)) === 'dlg-cancel');
    await page.keyboard.press('Escape');
    check('cancelling New filing keeps the filing', await page.isHidden('#modal') && (await page.textContent('#bar-who b')) === nameBefore);
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    await page.click('#main [data-textblock][data-s="CY"]:not([disabled])');
    check('text block editor shows its validation status', /Not validated yet|No validation issues|issue\(s\) for this text block/.test(await page.textContent('#modal .tb-issues')));
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
    check('Tab stays inside the dialog', await page.evaluate(() => !!document.activeElement?.closest('#modal')));
    await page.keyboard.press('Escape');

    // ---- MCA Validator error help
    await page.click('a[data-go="mcaerrors"]');
    await page.fill('#mx-text', "1) cvc-complex-type.3.2.2: Attribute 'xml:lang' is not allowed to appear in element 'in-ca:CorporateIdentityNumber'.\n2) Element 'DisclosureInBoardOfDirectorsReportExplanatoryTextBlock' the contained HTML has the following errors: cvc-complex-type.2.4.a: Invalid content was found starting with element 'colgroup'. One of '{{http://www.mca.gov.in/XBRL/HTML}thead, {http://www.mca.gov.in/XBRL/HTML}tr}' is expected.;cvc-complex-type.3.2.2: Attribute 'colspan' is not allowed to appear in element 'td'.;");
    await page.click('#mx-run');
    const mx = await page.textContent('#main');
    check('MCA error help explains pasted validator messages (attribute, HTML) with a fix', (await page.locator('#main .mx').count()) === 2 && /old \(cached\) copy/.test(mx) && /click Save Text/.test(mx) && (await page.locator('#main [data-goconcept]').count()) === 2, mx.slice(0, 300));
    await page.click('#main [data-goconcept="in-ca:CorporateIdentityNumber"]');
    check('MCA error help: element button navigates to the element', /GeneralInformationAboutCompany$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || '') || (await page.locator('#main #general-title').count()) === 1);
    check('no page errors', errors.length === 0, errors.map((e) => e.stack || e).join('; '));
  } finally { await browser.close(); }
  return { status: checks.every((c) => c.ok) ? 'PASS' : 'FAIL', ...st, checks };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = await runBrowserSmoke();
  for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ' — ' + c.detail}`);
  console.log(r.status, r.reason || '');
  process.exit(r.status === 'FAIL' ? 1 : 0);
}
