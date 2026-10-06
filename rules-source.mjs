// Reads the MCA business-rule workbook into row records that keep exact source text and location.
// Two source forms are accepted:
//   * the original workbook (.xls / .xlsx) — read directly, every row of every sheet, no export limit
//   * a tab-separated text export ("## Sheet: <name>" blocks) — may carry "... (truncated at N rows)"
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx';

export function readWorkbook(file) {
  return /\.xlsx?$/i.test(file) ? readWorkbookBinary(file) : readWorkbookText(file);
}

export function readWorkbookBinary(file) {
  const wb = XLSX.read(readFileSync(file), { type: 'buffer', cellDates: false });
  const sheets = wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, blankrows: true, defval: '' });
    const out = [];
    rows.forEach((cells, i) => {
      const c = cells.map((x) => String(x ?? '').replace(/\r?\n/g, ' '));
      if (c.every((x) => x.trim() === '')) return;
      out.push({ line: i + 1, cells: c }); // line = worksheet row number
    });
    return { name: name.trim(), startLine: 1, rows: out, truncated: false };
  });
  return { file, form: 'workbook', sheets };
}

export function readWorkbookText(file) {
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  const sheets = [];
  let cur = null;
  lines.forEach((line, i) => {
    const m = /^## Sheet: (.*)$/.exec(line);
    if (m) { cur = { name: m[1].trim(), startLine: i + 1, rows: [], truncated: false }; sheets.push(cur); return; }
    if (!cur) return;
    if (/^\.\.\. \(truncated at \d+ rows\)/.test(line)) { cur.truncated = true; cur.truncationNote = line.trim(); return; }
    if (line.trim() === '') return;
    cur.rows.push({ line: i + 1, cells: line.split('\t') });
  });
  return { file, form: 'text-export', sheets };
}

// "Specific rules for elements": ELR header rows "[nnnnnn] Title" then element rows.
export function specificRules(wb) {
  const sheet = wb.sheets.find((s) => s.name === 'Specific rules for elements');
  const out = [];
  let elr = null;
  for (const r of sheet.rows) {
    const [a, b] = r.cells;
    const h = /^\[(\d{6}[a-z]?)\]\s*(.*)$/.exec((a || '').trim());
    if (h) { elr = { code: h[1], title: h[2].trim() }; continue; }
    if (!b || !b.trim() || a === 'ELR/ Element Name') continue;
    out.push({ sheet: sheet.name, line: r.line, elr, element: a.trim(), text: b.trim() });
  }
  return { rows: out, truncated: sheet.truncated, truncationNote: sheet.truncationNote, lastElr: elr };
}

export function genericRules(wb) {
  const sheet = wb.sheets.find((s) => s.name === 'Generic rules');
  return sheet.rows.filter((r) => /^\d+$/.test(r.cells[0])).map((r) => ({ sheet: sheet.name, line: r.line, no: Number(r.cells[0]), text: r.cells[1].trim() }));
}

export function changeRules(wb) {
  const sheet = wb.sheets.find((s) => s.name === 'Changes to Business Rules');
  return sheet.rows.filter((r) => /^\d+$/.test(r.cells[0])).map((r) => ({
    sheet: sheet.name, line: r.line, no: Number(r.cells[0]), dateSerial: r.cells[1], tab: r.cells[2], element: (r.cells[3] || '').trim(), text: (r.cells[4] || '').trim(),
  }));
}

export function mandatoryLineItemSheets(wb) {
  return wb.sheets.filter((s) => /^Mandatory line.items$/i.test(s.name)).map((s) => ({
    sheet: s.name,
    rows: s.rows.filter((r) => /^\d+$/.test(r.cells[0])).map((r) => ({ line: r.line, no: Number(r.cells[0]), table: (r.cells[1] || '').trim(), text: (r.cells[2] || '').trim() })),
  }));
}

// Exempt parent/child member sheets: rows "Table \t Axis \t Member" with blank
// table/axis cells meaning "same as previous row".
export function exemptMemberSheets(wb, kind) {
  const re = kind === 'parent' ? /^Exempt parent member.?.?Dimension$/i : /^Exempt Child member.?.?Dimension$/i;
  return wb.sheets.filter((s) => re.test(s.name.replace(/\s+/g, ' '))).map((s) => {
    let table = null, axis = null;
    const rows = [];
    for (const r of s.rows) {
      const [t, a, m] = r.cells.map((c) => (c || '').trim());
      if (/^Name of Table$/i.test(t) || /^In following cases/i.test(t)) continue;
      if (t) table = t;
      if (a) axis = a;
      if (m) rows.push({ line: r.line, table, axis, member: m });
    }
    return { sheet: s.name, truncated: s.truncated, rows };
  });
}

export function parentChildExemptSheets(wb) {
  return wb.sheets.filter((s) => /^Parent.child exempt.calculation$/i.test(s.name.replace(/\s+/g, ' '))).map((s) => ({
    sheet: s.name,
    rows: s.rows.filter((r) => r.cells[0] && !/^Abstract's name$/i.test(r.cells[0].trim())).map((r) => ({ line: r.line, abstract: r.cells[0].trim(), text: (r.cells[1] || '').trim() })),
  }));
}

export function countryNames(wb) {
  const names = new Set();
  for (const s of wb.sheets.filter((x) => /^Country Codes?$/i.test(x.name))) {
    for (const r of s.rows) for (const c of r.cells) {
      const v = c.trim();
      if (v && !/^Country Name$/i.test(v)) names.add(v);
    }
  }
  return [...names].sort();
}

export function applicableElrs(wb) {
  const sheet = wb.sheets.find((s) => s.name === 'Applicable ELR');
  return sheet.rows.filter((r) => /^\d+$/.test(r.cells[0])).map((r) => {
    const m = /^\[(\d{6}[a-zA-Z]?)\]/.exec(r.cells[2].trim());
    return { line: r.line, id: r.cells[1].trim(), name: r.cells[2].trim(), code: m ? m[1] : null, applicableTo: (r.cells[3] || '').trim() };
  });
}
