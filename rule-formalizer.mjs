// Business-rule compiler.
// Source workbook text -> clauses -> executable rule AST + coverage ledger.
//
// Every clause receives exactly one status:
//   EXECUTABLE                 formalized; executed by src/core/rules.js
//   REVIEW_ONLY_EXTERNAL_DATA  needs data that is not in the instance (MCA master data, other instance)
//   NOT_APPLICABLE             no executable content in this taxonomy (element absent in 2016 DTS,
//                              pure guidance, or superseded legacy duplicate sheet)
//   UNIMPLEMENTED              not (yet) formalized — counted by the release gate
// (EXECUTED is a runtime status reported by the engine per filing.)
//
// Formalization is either a generic text pattern (implementation "pattern:<id>") or a curated
// formalization (implementation "curated:<id>") pinned to the exact source text by hash: if the MCA
// text changes, the curated entry no longer matches and the clause falls back to UNIMPLEMENTED.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  readWorkbook, specificRules, genericRules, changeRules, mandatoryLineItemSheets,
  exemptMemberSheets, parentChildExemptSheets, countryNames, applicableElrs,
} from './rules-source.mjs';

const h8 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Curated spelling corrections for element references in the MCA rule text that do not
// match any taxonomy name or label. Each maps to the single concept the sentence context implies.
const TYPO_ALIASES = {
  longtermloandandadvances: 'LongTermLoansAndAdvances',
  shorttermloandandadvances: 'ShortTermLoansAndAdvances',
  currentinvestment: 'CurrentInvestments',
  noncurrentinvestment: 'NoncurrentInvestments',
  // [200600] table row: "'TrdaeReceivable' is other than zero" — the table is SubclassificationOfTradeReceivablesTable
  trdaereceivable: 'TradeReceivables',
  // [300400] rows 1245/1247/1248 insert "The" into the element named in row 1244 / 1247
  whethermaintenanceofcostrecordsbythecompanyhasbeenmandatedundercompaniescostrecordsandauditrules2014: 'WhetherMaintenanceOfCostRecordsByCompanyHasBeenMandatedUnderCompaniesCostRecordsAndAuditRules2014',
  whetherauditofcostrecordsofthecompanyhasbeenmandatedunderrulesspecifiedinsn1: 'WhetherAuditOfCostRecordsOfCompanyHasBeenMandatedUnderRulesSpecifiedInSN1',
  // [400400] table rows: misspelt names of the two Yes/No elements of the same ELR
  whetertherearecontractsarrangementstransactionsnotatarmslength: 'WhetherThereAreContractsArrangementsTransactionsNotAtArmsLengthBasis',
  whethertherearecontractsarrangementstransactionsatarmslengthbasis: 'WhetherThereAreMaterialContractsArrangementsTransactionsAtArmsLengthBasis',
  // [400500] rows 4138/4140: 'CategoryOfSecreterialAuditor'
  categoryofsecreterialauditor: 'CategoryOfSecretarialAuditor',
  // [400100] rows 3685-3687: "name of the service provide(r)"
  nameoftheserviceprovide: 'NameOfTheServiceProvider',
  nameoftheserviceprovider: 'NameOfTheServiceProvider',
};

// "Mandatory if corresponding Number of shares is entered and vice-a-versa":
// the corresponding number-of-shares element occupies the parallel position in the
// [200100] increase/decrease presentation blocks (verified by test/rules.test.mjs).
const AMOUNT_NUMBER_PAIRS = {
  AmountOfPublicIssueDuringPeriod: 'NumberOfSharesIssuedInPublicOffering',
  AmountOfBonusIssueDuringPeriod: 'NumberOfSharesIssuedAsBonusShares',
  AmountOfRightsIssueDuringPeriod: 'NumberOfSharesIssuedAsRights',
  AmountOfOtherPrivatePlacementIssueDuringPeriod: 'NumberOfSharesIssuedInOtherPrivatePlacement',
  AmountOfOtherPreferentialAllotmentIssueDuringPeriod: 'NumberOfSharesIssuedAsOtherPreferentialAllotment',
  AmountOfIssueAllottedForContractsWithoutPaymentReceivedInCashDuringPeriod: 'NumberOfSharesAllottedForContractsWithoutPaymentReceivedInCash',
  AmountOfIssueUnderSchemeOfAmalgamationDuringPeriod: 'NumberOfSharesIssuedUnderSchemeOfAmalgamation',
  AmountOfOtherIssuesDuringPeriod: 'NumberOfOtherIssuesOfShares',
  AmountOfOtherIssueArisingOutOfConversionOfSecuritiesDuringPeriod: 'NumberOfOtherIssueOfSharesArisingOutOfConversionOfSecurities',
  DecreaseInAmountOfSharesRedeemed: 'NumberOfSharesRedeemed',
  DecreaseInAmountOfSharesBoughtBack: 'NumberOfSharesBoughtBack',
  OtherDecreaseInAmountOfShares: 'OtherDecreaseInNumberOfShares',
  DecreaseInShareCapitalDuringPeriod: 'DecreaseInNumberOfSharesDuringPeriod',
};

export function compileBusinessRules(file, A) {
  const wb = readWorkbook(file);
  const R = makeResolver(A);
  const rules = [];
  const push = (r) => { rules.push(r); return r; };

  // ---------------------------------------------------------------- specific rules
  const spec = specificRules(wb);
  for (const row of spec.rows) {
    const subject = R.concept(row.element);
    const clauses = splitClauses(row.text);
    clauses.forEach((text, i) => {
      const base = {
        id: `SR-L${row.line}-${i + 1}`,
        family: 'specific',
        source: { sheet: row.sheet, line: row.line, elr: row.elr ? `[${row.elr.code}] ${row.elr.title}` : null, element: row.element, text: row.text, clause: text },
        subject,
      };
      if (!subject) return push({ ...base, status: 'NOT_APPLICABLE', reason: `Element '${row.element}' not present in the C&I 2016 DTS` });
      push({ ...base, ...formalizeSpecific(text, subject, row, R, A) });
    });
  }

  // ---------------------------------------------------------------- changes sheet
  for (const row of changeRules(wb)) {
    const base = { id: `CH-${row.no}`, family: 'change', source: { sheet: row.sheet, line: row.line, element: row.element, text: row.text, clause: row.text, tab: row.tab } };
    const q = R.concept(row.element) || R.table(row.element);
    const m = /^Mandatory if "?DateOfStartOfReportingPeriod"? is more than (\d{2})\/(\d{2})\/(\d{4})$/.exec(row.text);
    if (!q) { push({ ...base, status: 'NOT_APPLICABLE', reason: `Element/table '${row.element}' not present in the C&I 2016 DTS (change introduced for a later taxonomy)` }); continue; }
    if (m) {
      const date = `${m[3]}-${m[2]}-${m[1]}`;
      push({ ...base, subject: q, status: 'EXECUTABLE', implementation: 'pattern:change-date-mandatory', scope: { periods: ['CY'] },
        ast: { type: 'mandatory', concept: q, when: { op: 'cmp', cmp: '>', l: { fact: R.concept('DateOfStartOfReportingPeriod') }, r: { const: date, kind: 'date' } } } });
    } else if (/Manda\w* Line Item/i.test(row.tab) && R.table(row.element) && R.concept(row.text)) {
      push({ ...base, subject: R.concept(row.text), status: 'EXECUTABLE', implementation: 'data:merged into mandatory-line-items rule for the same table', scope: { periods: ['CY', 'PY'] } });
    } else {
      push({ ...base, subject: q, status: 'UNIMPLEMENTED', reason: 'Unrecognised change-rule form' });
    }
  }

  // ---------------------------------------------------------------- generic rules
  for (const g of genericRules(wb)) push({ id: `GR-${g.no}`, family: 'generic', source: { sheet: 'Generic rules', line: g.line, text: g.text, clause: g.text }, ...GENERIC[g.no]?.(A, R) || { status: 'UNIMPLEMENTED', reason: 'No generic handler' } });

  // ---------------------------------------------------------------- mandatory line items
  const mlSheets = mandatoryLineItemSheets(wb);
  const primaryMl = mlSheets[0];
  for (const [si, sheet] of mlSheets.entries()) {
    for (const row of sheet.rows) {
      const base = { id: `ML${si ? 'L' : ''}-${row.no}`, family: 'mandatory-line-items', source: { sheet: sheet.sheet, line: row.line, table: row.table, text: row.text, clause: row.text } };
      if (si > 0) {
        const dup = primaryMl.rows.find((p) => p.no === row.no);
        push({ ...base, status: 'NOT_APPLICABLE', reason: `Legacy duplicate sheet '${sheet.sheet}' (older element names); superseded by '${primaryMl.sheet}' row ${dup ? dup.no : '?'} which is executed` });
        continue;
      }
      const res = formalizeMandatoryLineItems(row, R, A);
      if (res.partial) {
        const { ambiguous, ...main } = res;
        push({ ...base, ...main, status: 'EXECUTABLE', reason: main.unresolvedReason || null, partial: undefined });
        push({ ...base, id: base.id + '-b', source: { ...base.source, clause: ambiguous }, status: 'UNIMPLEMENTED', reason: 'Ambiguous in the MCA source: does not identify which amount elements are required, so it cannot be formalized without an MCA clarification' });
      } else push({ ...base, ...res });
    }
  }
  // change-sheet row 7 adds a mandatory line item to a table
  // (handled in formalizeMandatoryLineItems via CHANGE_ADDITIONS)

  // ---------------------------------------------------------------- data sheets consumed by generic rules
  const exParent = exemptMemberSheets(wb, 'parent');
  const exChild = exemptMemberSheets(wb, 'child');
  const pcExempt = parentChildExemptSheets(wb);
  const exemptions = {
    parentMember: resolveExempt(exParent[0], R),
    childMember: resolveExempt(exChild[0], R),
    calculation: resolvePcExempt(pcExempt[0], R, A),
  };
  const dataRows = [
    ...exParent.flatMap((s, si) => s.rows.map((r, i) => ({ id: `EXP${si ? 'L' : ''}-${i + 1}`, family: 'exempt-parent-member', source: { sheet: s.sheet, line: r.line, text: `${r.table} | ${r.axis} | ${r.member}`, clause: '' }, ...dataStatus(si, r, R, 'GR-3') }))),
    ...exChild.flatMap((s, si) => s.rows.map((r, i) => ({ id: `EXC${si ? 'L' : ''}-${i + 1}`, family: 'exempt-child-member', source: { sheet: s.sheet, line: r.line, text: `${r.table} | ${r.axis} | ${r.member}`, clause: '' }, ...dataStatus(si, r, R, 'GR-3') }))),
    ...pcExempt.flatMap((s, si) => s.rows.map((r, i) => ({ id: `PCE${si ? 'L' : ''}-${i + 1}`, family: 'exempt-calculation', source: { sheet: s.sheet, line: r.line, text: `${r.abstract} | ${r.text}`, clause: '' }, status: 'EXECUTABLE', implementation: 'data:GR-1 exemption list' }))),
  ];
  rules.push(...dataRows);

  const countries = countryNames(wb);
  const elrSheet = applicableElrs(wb);

  // ---------------------------------------------------------------- Yes/No dependencies (derived)
  // A dependency exists only where an executable MCA rule conditions a field or table on a non-dimensional
  // boolean element ("Mandatory if Yes is selected in X", "This table is mandatory if Yes is selected in X").
  // Field names are never used to invent dependencies.
  const isBool = (q) => A.concepts[q]?.type === 'xbrli:booleanItemType';
  const nondimQ = (q) => !(A.conceptHypercubes?.[q] || []).length;
  const boolCond = (w) => (w && w.op === 'cmp' && w.cmp === '==' && w.l?.fact && w.l.ctx === 'nondim' && isBool(w.l.fact) && typeof w.r?.const === 'boolean' ? { parent: w.l.fact, condition: w.r.const } : null);
  const depMap = new Map();
  const dep = (parent, condition) => { const k = parent + '|' + condition; if (!depMap.has(k)) depMap.set(k, { parentConcept: parent, condition, childConcepts: [], tables: [], rules: [] }); return depMap.get(k); };
  for (const r of rules) {
    if (r.status !== 'EXECUTABLE' || !r.ast) continue;
    const a = r.ast;
    let c = null;
    if (a.type === 'mandatory') c = boolCond(a.when);
    else if (a.type === 'eachFactOf' && isBool(a.concept) && nondimQ(a.concept) && a.when?.op === 'cmp' && a.when.l?.self && typeof a.when.r?.const === 'boolean' && a.assert?.op === 'entered' && a.assert.e?.fact) c = { parent: a.concept, condition: a.when.r.const, child: a.assert.e.fact };
    else if (a.type === 'tableRequired') c = boolCond(a.when);
    if (!c) continue;
    const d = dep(c.parent, c.condition);
    if (a.type === 'tableRequired') {
      d.tables.push(...a.tables);
      a.gate = true; // a table that exists for a Yes answer is not available for No (shared applicability)
    } else d.childConcepts.push(c.child || a.concept);
    d.rules.push(r.id);
  }
  const booleanDependencies = [...depMap.values()].map((d) => ({ ...d, childConcepts: [...new Set(d.childConcepts)].filter((q) => q !== d.parentConcept), tables: [...new Set(d.tables)] }));

  // ---------------------------------------------------------------- table applicability (derived)
  const tableApplicability = {};
  for (const r of rules) if (r.status === 'EXECUTABLE' && r.ast?.type === 'tableRequired' && r.ast.when && r.ast.gate !== false) {
    for (const t of r.ast.tables) (tableApplicability[t] ||= []).push({ rule: r.id, when: r.ast.when });
  }

  // ---------------------------------------------------------------- coverage
  for (const r of rules) {
    r.sourceHash = h8(r.source.text + '|' + (r.source.clause || ''));
    r.test = (TESTS[r.implementation?.split(':')[1]] || TESTS[r.family] || (r.status === 'EXECUTABLE' && r.ast ? 'rule-families.test.mjs' : null))?.replace(/^test\//, '') || null;
  }
  const summary = {};
  for (const r of rules) summary[r.status] = (summary[r.status] || 0) + 1;
  const truncatedSheets = wb.sheets.filter((x) => x.truncated).map((x) => x.name);
  const elrSeq = [...new Map(spec.rows.filter((r) => r.elr).map((r) => [r.elr.code, r.elr])).values()];
  const corpus = {
    sourceFile: file.split('/').pop(),
    sourceSha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    sourceForm: wb.form,
    sheets: wb.sheets.map((x) => ({ name: x.name, rows: x.rows.length, truncated: x.truncated })),
    specificRuleRows: spec.rows.length,
    genericRuleCount: genericRules(wb).length,
    mandatoryLineItemRows: mlSheets[0]?.rows.length || 0,
    firstElrInSpecificRules: elrSeq[0] ? `[${elrSeq[0].code}] ${elrSeq[0].title}` : null,
    lastElrInSpecificRules: spec.lastElr ? `[${spec.lastElr.code}] ${spec.lastElr.title}` : null,
    specificRulesSheetTruncated: spec.truncated,
    truncatedSheets,
    truncationNote: spec.truncationNote || null,
    lastElrInSuppliedSpecificRules: spec.lastElr ? `[${spec.lastElr.code}] ${spec.lastElr.title}` : null,
    elrsWithoutSuppliedSpecificRules: spec.truncated ? A.elrs.filter((e) => e.code > (spec.lastElr?.code || '')).map((e) => `[${e.code}] ${e.title}`) : [],
    note: spec.truncated
      ? `The supplied ${wb.form} of sheet "Specific rules for elements" is truncated (${spec.truncationNote}); it ends inside [${spec.lastElr?.code}]. Specific rules for later ELRs are not in the authority package and cannot be executed. Place the original workbook Final_Business_Rule_C_I_Taxonomy_2016_V1.3.xls (or .xlsx) in the repository root and run npm run compile.`
      : null,
  };
  const coverage = {
    generatedBy: 'compiler/rule-formalizer.mjs',
    source: file.split('/').pop(),
    statuses: ['EXECUTABLE', 'EXECUTED', 'REVIEW_ONLY_EXTERNAL_DATA', 'UNIMPLEMENTED', 'NOT_APPLICABLE'],
    summary,
    corpus,
    rules: rules.map((r) => ({
      ruleId: r.id, family: r.family, sourceSheet: r.source.sheet, sourceRow: r.source.line, sourceText: r.source.text, clause: r.source.clause,
      element: r.source.element || r.source.table || null, subject: r.subject || null,
      condition: r.ast?.when ? describe(r.ast.when) : null,
      operator: r.ast ? opOf(r.ast) : null,
      operands: r.ast ? operandsOf(r.ast) : [],
      scope: r.scope || null,
      implementation: r.implementation || null,
      test: r.test,
      status: r.status,
      reason: r.reason || null,
    })),
  };
  const model = {
    rules: rules.map(({ id, family, status, implementation, scope, subject, ast, source, reason }) => ({ id, family, status, implementation, scope, subject, ast, reason, text: source.clause || source.text, element: source.element || source.table || null, sheet: source.sheet, line: source.line, elr: /^\[(\d{6})/.exec(source.elr || '')?.[1] || null })),
    exemptions,
    countries,
    applicableElrs: elrSheet,
    tableApplicability,
    booleanDependencies,
    corpus,
  };
  coverage.booleanDependencies = booleanDependencies;
  return { model, coverage };
}

// =====================================================================================
// resolver
function makeResolver(A) {
  const byLocal = new Map();
  const byNorm = new Map();
  const byLabel = new Map();
  for (const [q, c] of Object.entries(A.concepts)) {
    (byLocal.get(c.name) || byLocal.set(c.name, []).get(c.name)).push(q);
    const n = norm(c.name);
    (byNorm.get(n) || byNorm.set(n, []).get(n)).push(q);
    for (const l of Object.values(c.labels || {})) {
      const k = norm(l.replace(/\[[^\]]*\]/g, ''));
      (byLabel.get(k) || byLabel.set(k, []).get(k)).push(q);
    }
  }
  const pick = (arr) => {
    if (!arr || !arr.length) return null;
    const u = [...new Set(arr)];
    if (u.length === 1) return u[0];
    // prefer reportable items over abstracts/members when a label is shared
    const items = u.filter((q) => A.concepts[q].kind === 'item');
    return items.length === 1 ? items[0] : u.sort()[0];
  };
  const concept = (tok) => {
    if (!tok) return null;
    const t = tok.replace(/^['"\s]+|['"\s]+$/g, '').replace(/\s*\((closing|opening)\)\s*$/i, '').trim();
    if (byLocal.has(t)) return pick(byLocal.get(t));
    const n = norm(t);
    if (TYPO_ALIASES[n]) return pick(byLocal.get(TYPO_ALIASES[n]));
    return pick(byNorm.get(n)) || pick(byLabel.get(n));
  };
  const table = (tok) => {
    const n = norm(tok.replace(/'.*$/, '').replace(/\s+in\s+notes.*$/i, ''));
    const hits = A.tables.filter((t) => norm(t.hypercube.split(':')[1]) === n || norm(t.hypercube.split(':')[1]) === n + 'table');
    return hits.length ? hits.map((t) => t.id) : null;
  };
  const tablesByHc = (local) => A.tables.filter((t) => t.hypercube.split(':')[1] === local).map((t) => t.id);
  const local = (q) => q.split(':')[1];
  const axisOf = (tableIds, axisLocal) => {
    for (const id of tableIds) {
      const t = A.tables.find((x) => x.id === id);
      const ax = t.axes.find((a) => local(a.axis) === axisLocal);
      if (ax) return ax;
    }
    return null;
  };
  return { concept, table, tablesByHc, local, axisOf };
}

// =====================================================================================
// clause splitting
const QUALIFIER = /^(However, in case the first level child|To validate this|For validating this|In case of multiple dates|For eg)/i;
function splitClauses(text) {
  const t = text.replace(/\s+/g, ' ').trim()
    // sentences joined without a space ("...100%.Mandatory if", "...zero.This field")
    .replace(/(%|zero)\.(?=(?:Mandatory|This|Should)\b)/g, '$1. ')
    // row 3610: "... is Yes Value entered here should be 2 percent ..." (two sentences, no stop)
    .replace(/\bis Yes (?=Value entered here)/, 'is Yes. ');
  const parts = t.split(/(?<=[.'"%])\s+(?=(?:Should|Mandatory|This|It|Summation|Either|YES|Valid|Status|But|In case|To validate|For validating|However|Total)\b)|(?<=\.)\s+(?=[A-Z])/);
  const out = [];
  for (let p of parts) {
    p = p.trim().replace(/[\s.]+$/, '').trim();
    if (!p) continue;
    if (QUALIFIER.test(p) && out.length) out[out.length - 1] += '. ' + p;
    else out.push(p);
  }
  return out;
}

// =====================================================================================
// specific-rule formalization
const Q = `['"]([^'"]+)['"]`;
function formalizeSpecific(clause, subject, row, R, A) {
  const s = clause.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
  for (const [re, reason] of EXTERNAL) if (re.test(s)) return { status: 'REVIEW_ONLY_EXTERNAL_DATA', reason, implementation: 'review:external-data' };
  for (const [re, reason] of NO_CONSTRAINT) if (re.test(s)) return { status: 'NOT_APPLICABLE', reason };
  const sub = { fact: subject };
  const ok = (impl, ast, scope) => ({ status: 'EXECUTABLE', implementation: impl, ast, scope: scope || defaultScope(subject, A) });
  const isTableRow = A.concepts[subject].kind === 'hypercube';
  let m;

  // -------- table-level rules
  if (isTableRow) {
    const tables = R.tablesByHc(R.local(subject));
    const gt0 = (q) => ({ op: 'cmp', cmp: '>', l: { fact: q, ctx: 'nondim' }, r: { const: 0 } });
    const ne0 = (q) => ({ op: 'cmp', cmp: '!=', l: { fact: q, ctx: 'nondim' }, r: { const: 0 } });
    const tr = (when, impl) => ok(`pattern:${impl}`, { type: 'tableRequired', tables, when }, { periods: ['CY', 'PY'] });
    if ((m = new RegExp(`mandatory in case (?:value entered in |amount entered in )?${Q} is greater than zero`, 'i').exec(s)) && !/ or /i.test(s)) {
      const q = R.concept(m[1]); if (q) return tr(gt0(q), 'table-if-gt0');
    }
    if ((m = new RegExp(`mandatory in case (?:amount entered in )?${Q} or ${Q} is (greater than|other than) zero`, 'i').exec(s)) ||
        (m = new RegExp(`mandatory in case either ${Q} or ${Q} is (greater than|other than) zero`, 'i').exec(s))) {
      const a = R.concept(m[1]), b = R.concept(m[2]);
      const f = /greater/i.test(m[3]) ? gt0 : ne0;
      if (a && b) return tr({ op: 'or', args: [f(a), f(b)] }, 'table-if-any');
    }
    if ((m = new RegExp(`mandatory (?:in case|if) ${Q} is other than zero`, 'i').exec(s)) || (m = /mandatory if (\w+) in balance sheet is other than zero/i.exec(s))) {
      const q = R.concept(m[1]); if (q) return tr(ne0(q), 'table-if-ne0');
    }
    if ((m = new RegExp(`mandatory in case ${Q} is selected in field ${Q}`, 'i').exec(s))) {
      const q = R.concept(m[2]);
      if (q && /^yes$/i.test(m[1])) return tr({ op: 'cmp', cmp: '==', l: { fact: q, ctx: 'nondim' }, r: { const: true } }, 'table-if-yes');
    }
    if (/details are entered for 'BondsMember or DebenturesMember' under 'Classification of borrowings \[Axis\]' and vice-a-versa/.test(s)) {
      const bt = R.tablesByHc('ClassificationOfBorrowingsTable');
      const members = [R.concept('BondsMember'), R.concept('DebenturesMember')];
      const axis = R.concept('ClassificationOfBorrowingsAxis');
      return ok('curated:bonds-debentures-iff', { type: 'tableIffMembers', tables, otherTables: bt, axis, members }, { periods: ['CY', 'PY'] });
    }
    const x = formalizeExtended(s, subject, row, R, A, ok);
    if (x) return x;
    return { status: 'UNIMPLEMENTED', reason: 'Unrecognised table-level rule form' };
  }

  // -------- external-data dependent (company master data / status)
  if (/company not having share capital|company having share capital|Status of the company \(Pvt\/Public\/Section 8\)/i.test(s)) {
    return { status: 'REVIEW_ONLY_EXTERNAL_DATA', reason: 'Requires company class / share-capital status from MCA21 company master data, which is not part of the instance document', implementation: 'review:external-master-data' };
  }

  // -------- mandatory (unconditional)
  if (/^(This is a mandatory field|It is a mandatory field|This item is mandatory|This item will be Mandatory|This is a Mandatory field)$/i.test(s)) {
    return ok('pattern:mandatory', { type: 'mandatory', concept: subject });
  }
  // -------- sign rules
  if (/^Should be greater than (or )?(equal|eqaul)( to)? zero$/i.test(s) || /^Should be greater than equal to zero$/i.test(s)) {
    return ok('pattern:gte0', { type: 'eachFact', concept: subject, assert: { op: 'cmp', cmp: '>=', l: { self: true }, r: { const: 0 } } });
  }
  if (/^Should be greater than zero$/i.test(s)) return ok('pattern:gt0', { type: 'eachFact', concept: subject, assert: { op: 'cmp', cmp: '>', l: { self: true }, r: { const: 0 } } });
  if (/^Should be less than or equal to 100%$/i.test(s)) {
    // percentItemType values are decimal fractions (Filing Manual Annex II #5: 60% is entered as 0.6)
    return ok('pattern:lte100pct', { type: 'eachFact', concept: subject, assert: { op: 'cmp', cmp: '<=', l: { self: true }, r: { const: 1 } } });
  }
  if (/^Should be less than or equal to system date$/i.test(s)) {
    return ok('pattern:lte-today', { type: 'eachFact', concept: subject, assert: { op: 'cmp', cmp: '<=', l: { self: true }, r: { today: true } } });
  }
  // -------- comparisons with another element (same context)
  if ((m = new RegExp(`^Should be less than or equal to ${Q}$`, 'i').exec(s))) {
    const q = R.concept(m[1]);
    if (q) return ok('pattern:lte-ref', { type: 'eachFact', concept: subject, assert: { op: 'cmp', cmp: '<=', l: { self: true }, r: { fact: q } } });
    if (/Value of shares subscribed - equity \+ Preference/i.test(m[1])) {
      const axis = R.concept('ClassesOfShareCapitalAxis');
      return ok('curated:sharecapital-lte-subscribed', { type: 'assert', assert: { op: 'cmp', cmp: '<=', l: { fact: subject, ctx: 'nondim' }, r: { sumAxis: { concept: R.concept('ValueOfSharesSubscribed'), axis, level: 'firstLevel' } } } });
    }
  }
  if ((m = new RegExp(`^Should be equal to ${Q} multiplied by ${Q}$`, 'i').exec(s))) {
    const a = R.concept(m[1]), b = R.concept(m[2]);
    if (a && b) return ok('pattern:eq-product', { type: 'eachFact', concept: subject, assert: { op: 'cmp', cmp: '==', l: { self: true }, r: { mul: [{ fact: a }, { fact: b }] } } });
  }
  if ((m = new RegExp(`^Should be equal to value entered in element ${Q} in Balance sheet$`, 'i').exec(s))) {
    const q = R.concept(m[1]);
    if (q) return ok('pattern:eq-ref', { type: 'eachFact', concept: subject, assert: { op: 'cmp', cmp: '==', l: { self: true }, r: { fact: q } } });
  }
  // -------- conditional mandatory
  const mand = (when, impl, extra = {}) => ok(`pattern:${impl}`, { type: 'mandatory', concept: subject, when, ...extra });
  if (/^Mandatory in case of Consolidated financial statement instance document$/i.test(s)) return mand({ op: 'reportType', value: 'Consolidated' }, 'mandatory-consolidated');
  if (/^This shall be a mandatory field in case of standalone instance document$/i.test(s)) return mand({ op: 'reportType', value: 'Standalone' }, 'mandatory-standalone');
  if ((m = new RegExp(`^Mandatory,? if ${Q} is yes$`, 'i').exec(s)) || (m = /^Mandatory,? if (\w+) is Yes$/i.exec(s)) || (m = new RegExp(`^Mandatory in case Yes is selected in element ${Q}$`, 'i').exec(s))) {
    const q = R.concept(m[1]);
    if (q) return mand({ op: 'cmp', cmp: '==', l: { fact: q, ctx: 'nondim' }, r: { const: true } }, 'mandatory-if-yes');
  }
  if ((m = new RegExp(`^Mandatory in case value is entered in field ${Q}$`, 'i').exec(s))) {
    const q = R.concept(m[1]);
    if (q) return ok('pattern:mandatory-if-entered', { type: 'eachFactOf', concept: q, assert: { op: 'entered', e: { fact: subject } } });
  }
  if ((m = new RegExp(`^Mandatory if ${Q} is entered and vice a versa$`, 'i').exec(s))) {
    const q = R.concept(m[1]);
    if (q) return ok('pattern:mandatory-iff-entered', { type: 'iffEntered', concepts: [subject, q] });
  }
  if (/^Mandatory if corresponding Number of shares is entered and vice-a-versa$/i.test(s)) {
    const pair = AMOUNT_NUMBER_PAIRS[R.local(subject)];
    const q = pair && R.concept(pair);
    if (q) return ok('curated:amount-number-pair', { type: 'iffEntered', concepts: [subject, q] });
    return { status: 'UNIMPLEMENTED', reason: 'No corresponding number-of-shares element identified' };
  }
  if (/^Mandatory in case Beginning Date of continuing Default is entered$/i.test(s)) {
    const q = R.concept('BeginningDateOfContinuingDefaultForBorrowings');
    return ok('curated:continuing-default', { type: 'eachFactOf', concept: q, assert: { op: 'entered', e: { fact: subject } } });
  }
  if ((m = new RegExp(`^Mandatory in case of ${Q}$`, 'i').exec(s))) {
    const mem = R.concept(m[1]);
    if (mem && A.concepts[mem].kind === 'member') return ok('pattern:mandatory-for-member', { type: 'memberMandatory', concept: subject, member: mem });
  }
  if ((m = new RegExp(`^This shall be mandatory in case details in respect of ${Q} is entered$`, 'i').exec(s))) {
    const mem = R.concept(m[1]);
    if (mem && A.concepts[mem].kind === 'member') return ok('pattern:mandatory-for-member', { type: 'memberMandatory', concept: subject, member: mem });
  }
  const gtWhen = (q) => ({ op: 'cmp', cmp: '>', l: { fact: q, ctx: 'nondim' }, r: { const: 0 } });
  if ((m = new RegExp(`^(?:Mandatory,? if|This is mandatory in case) (?:value (?:entered )?in (?:field )?)?${Q}(?: in (?:balance sheet|financial statements?))? is greater than zero$`, 'i').exec(s)) ||
      (m = /^Mandatory if (\w+) is greater than zero$/i.exec(s))) {
    const q = R.concept(m[1]);
    if (q) return isNondimOnly(q, A) || /in (balance sheet|financial statements?)/i.test(s) ? mand(gtWhen(q), 'mandatory-if-gt0') : ok('pattern:mandatory-if-gt0', { type: 'eachFactOf', concept: q, when: { op: 'cmp', cmp: '>', l: { self: true }, r: { const: 0 } }, assert: { op: 'entered', e: { fact: subject } } });
  }
  if ((m = new RegExp(`^Mandatory in case ${Q} is other than zero$`, 'i').exec(s)) || (m = /^This is mandatory in case Value in (\w+) is other than Zero$/i.exec(s))) {
    const q = R.concept(m[1]);
    if (q) return isNondimOnly(q, A) ? mand({ op: 'cmp', cmp: '!=', l: { fact: q, ctx: 'nondim' }, r: { const: 0 } }, 'mandatory-if-ne0')
      : ok('pattern:mandatory-if-ne0', { type: 'eachFactOf', concept: q, when: { op: 'cmp', cmp: '!=', l: { self: true }, r: { const: 0 } }, assert: { op: 'entered', e: { fact: subject } } });
  }
  // -------- formats
  if (/^Valid CIN$/i.test(s)) return ok('pattern:format-cin', { type: 'eachFact', concept: subject, assert: { op: 'format', format: 'CIN', e: { self: true } } });
  if (/^Should be valid PAN as per Income_tax_PAN format$/i.test(s)) return ok('pattern:format-pan', { type: 'eachFact', concept: subject, assert: { op: 'format', format: 'PAN', e: { self: true } } });
  if (/^Should be valid country name as per List of countries$/i.test(s)) return ok('pattern:format-country', { type: 'eachFact', concept: subject, assert: { op: 'format', format: 'country', e: { self: true } } });

  // -------- curated summation / cross-table rules
  const local = R.local(subject);
  const ax = (n) => R.concept(n);
  const sumEq = (impl, target, sumSpec) => ok(`curated:${impl}`, { type: 'assert', assert: { op: 'cmp', cmp: '==', l: { sumAxis: sumSpec }, r: { fact: target, ctx: 'nondim' } } });
  const classPattern = { axis: ax('ClassesOfShareCapitalAxis'), pattern: '^(Equity|Preference)Shares\\d+Member$' };
  if (/^Summation of 'Value of Shares paid up' for\s+'EquitySharesMembers 1\.\.10'/i.test(s) || /^Summation of 'ShareCapital' \(Closing\)'/i.test(s)) {
    return sumEq('sharecapital-classes-sum', R.concept('ShareCapital'), { concept: subject, ...classPattern, level: 'pattern' });
  }
  if (/^Total Value of Reserves- \(Closing Balance\) should be equal to value entered in 'ReservesAndSurplus'/i.test(s)) {
    return sumEq('reserves-first-level', R.concept('ReservesAndSurplus'), { concept: subject, axis: ax('ComponentsOfReservesAxis'), level: 'firstLevel' });
  }
  if ((m = /^Summation of various Borrowings members\s+for (Long|Short) term period should be equal to '(\w+)'/i.exec(s))) {
    return sumEq('borrowings-first-level', R.concept(m[2]), { concept: subject, axis: ax('ClassificationOfBorrowingsAxis'), level: 'firstLevel', fixed: { [ax('ClassificationBasedOnTimePeriodAxis')]: R.concept(`${m[1]}TermMember`) } });
  }
  if ((m = /^Summation of '(\w+)' for all dimensional members should be equal to '(\w+)' in (Financial statements|Balance sheet)$/i.exec(s))) {
    const tables = A.tables.filter((t) => t.lineItems.includes(subject));
    const typedAxis = tables.flatMap((t) => t.axes).find((a) => a.typed);
    if (typedAxis) return sumEq('typed-members-sum', R.concept(m[2]), { concept: subject, axis: typedAxis.axis, level: 'all' });
  }
  if ((m = /^Summation of '(\w+)' and '(\w+)' should be equal to '(\w+)' in (financial statements|Balance Sheet)$/i.exec(s))) {
    const a = R.concept(m[1]), b = R.concept(m[2]), c = R.concept(m[3]);
    if (a && b && c) return ok('pattern:sum-two-eq', { type: 'assert', assert: { op: 'cmp', cmp: '==', l: { add: [{ fact: a, ctx: 'nondim' }, { fact: b, ctx: 'nondim' }] }, r: { fact: c, ctx: 'nondim' } } });
  }
  if ((m = /^Summation of all (Provisions|LoansAndAdvances) - Long term member and Short term member should be equal to '(\w+)' and '(\w+)' respectively/i.exec(s))) {
    const time = ax('ClassificationBasedOnTimePeriodAxis');
    const firstLevelAxis = m[1] === 'LoansAndAdvances' ? ax('ClassificationOfLoansAndAdvancesAxis') : null;
    const spec = (term) => firstLevelAxis
      ? { concept: subject, axis: firstLevelAxis, level: 'firstLevel', fixed: { [time]: R.concept(`${term}TermMember`) } }
      : { concept: subject, axis: time, level: 'members', members: [R.concept(`${term}TermMember`)] };
    return ok(`curated:${m[1].toLowerCase()}-term-sum`, { type: 'assert', assert: { op: 'and', args: [
      { op: 'cmp', cmp: '==', l: { sumAxis: spec('Long') }, r: { fact: R.concept(m[2]), ctx: 'nondim' } },
      { op: 'cmp', cmp: '==', l: { sumAxis: spec('Short') }, r: { fact: R.concept(m[3]), ctx: 'nondim' } },
    ] } });
  }
  if (/^Either CIN of shareholder or PAN of shareholder is Mandatory in case Country of incorporation or residence of shareholder is India$/i.test(s)) {
    return ok('curated:shareholder-cin-or-pan', { type: 'eachFactOf', concept: R.concept('CountryOfIncorporationOrResidenceOfShareholder'),
      when: { op: 'cmp', cmp: '==', l: { upper: { self: true } }, r: { const: 'INDIA' } },
      assert: { op: 'or', args: [{ op: 'entered', e: { fact: R.concept('CINOfShareholder') } }, { op: 'entered', e: { fact: R.concept('PANOfShareholder') } }] } });
  }
  if (/^Summation of all shareholder members should be less than or equal to summation of\s+'Number of Shares Paid Up'/i.test(s)) {
    return ok('curated:shareholders-lte-paidup', { type: 'assert', assert: { op: 'cmp', cmp: '<=',
      l: { sumAxis: { concept: subject, axis: ax('NameOfShareholderAxis'), level: 'all', anyOther: true } },
      r: { sumAxis: { concept: R.concept('NumberOfSharesPaidUp'), ...classPattern, level: 'pattern' } } } });
  }
  if ((m = /^Summation of all shareholder for (equity|preference) members should be less than or equal to 100%$/i.exec(s))) {
    const under = R.concept(m[1] === 'equity' ? 'EquitySharesMember' : 'PreferenceSharesMember');
    // per class of share: sum over shareholders within each class member under the equity/preference node <= 100%
    return ok('curated:shareholding-pct-lte-100', { type: 'groupSum', concept: subject, groupAxis: ax('ClassesOfShareCapitalAxis'), groupUnder: under, sumAxis: ax('NameOfShareholderAxis'), cmp: '<=', limit: 1 });
  }
  if (/^Either this element or NumberOfPersonsOnPrivatePlacementOfPreferenceShare is mandatory if 'NumberOfSharesIssuedInPrivatePlacement' is greater than zero$/i.test(s)) {
    // 'NumberOfSharesIssuedInPrivatePlacement' is not a 2016 element; the 2016 private-placement share counts are
    // NumberOfSharesIssuedInPrivatePlacementArisingOutOfConversion... and NumberOfSharesIssuedInOtherPrivatePlacement.
    const counts = ['NumberOfSharesIssuedInPrivatePlacementArisingOutOfConversionOfDebenturesPreferenceSharesDuringPeriod', 'NumberOfSharesIssuedInOtherPrivatePlacement'].map((n) => R.concept(n));
    return ok('curated:private-placement-persons', { type: 'assert',
      when: { op: 'or', args: counts.map((c) => ({ op: 'anyFact', concept: c, pred: { op: 'cmp', cmp: '>', l: { self: true }, r: { const: 0 } } })) },
      assert: { op: 'or', args: [{ op: 'entered', e: { fact: subject, ctx: 'nondim' } }, { op: 'entered', e: { fact: R.concept('NumberOfPersonsOnPrivatePlacementOfPreferenceShare'), ctx: 'nondim' } }] } });
  }
  if ((m = /^Mandatory if (NumberOfPersonsOnPrivatePlacementOf\w+) is greater than zero$/i.exec(s))) {
    const q = R.concept(m[1]);
    if (q) return mand(gtWhen(q), 'mandatory-if-gt0');
  }
  if (/^YES should be selected in case amount entered in 'AmountOfPublicIssueDuringPeriod' is greater than zero$/i.test(s)) {
    return ok('curated:public-offering-yes', { type: 'assert',
      when: { op: 'anyFact', concept: R.concept('AmountOfPublicIssueDuringPeriod'), pred: { op: 'cmp', cmp: '>', l: { self: true }, r: { const: 0 } } },
      assert: { op: 'cmp', cmp: '==', l: { fact: subject, ctx: 'nondim' }, r: { const: true } } }, { periods: ['CY'] });
  }
  const x = formalizeExtended(s, subject, row, R, A, ok);
  if (x) return x;
  return { status: 'UNIMPLEMENTED', reason: 'No pattern or curated formalization matched this clause' };
}

function isNondimOnly(q, A) { return !(A.conceptHypercubes[q] || []).length; }

// Mandatory facts are evaluated for CY, and for PY unless the concept's ELRs are excluded for
// previous year by GR-12 (handled at runtime) — the scope here lists the candidate periods.
function defaultScope(q, A) {
  return { periods: ['CY', 'PY'] };
}

// =====================================================================================
// mandatory line items
// Row-scoped token corrections: the 2016 table has a single combined element for the name.
const ML_TOKEN_ALIASES = {
  DisclosureOfKeyManagerialPersonnelsAndDirectorsAndRemunerationToKeyManagerialPersonnelsAndDirectorsTable: { NameOfDirector: 'NameOfKeyManagerialPersonnelOrDirector' },
};
const AT_LEAST_ONE_ALSO = { RelatedPartyTransactionsAbstract: ['TransactionRelatingToKeyManagementPersonnelAbstract'] };
const CHANGE_ADDITIONS = { DetailsOfMaterialContractsArrangementsTransactionsAtArmsLengthBasisTable: ['WhetherApprovalTakenFromBoardForMaterialContractsorArrangementsorTransactionsWithRelatedParty'] };
function formalizeMandatoryLineItems(row, R, A) {
  const tname = row.table.replace(/'.*$/, '').replace(/\s+in\s+Notes.*$/i, '').replace(/\s+/g, '').replace(/LineItems$/, 'Table').trim();
  let tables = R.table(tname) || R.table(tname + 'Table');
  if (!tables) return { status: 'NOT_APPLICABLE', reason: `Table '${row.table}' not present in the C&I 2016 DTS` };
  const tdefs = tables.map((id) => A.tables.find((t) => t.id === id));
  const lineItems = [...new Set(tdefs.flatMap((t) => t.lineItems))];
  const text = row.text.replace(/\s+/g, ' ');
  const tokens = (str) => (str.replace(/\([^)]*\)/g, ' ').match(/[A-Z][A-Za-z0-9-]{5,}/g) || []);
  const unresolved = [];
  const aliases = ML_TOKEN_ALIASES[R.local(tdefs[0].hypercube)] || {};
  const resolveList = (str) => tokens(str).map((tk) => {
    const q = R.concept(aliases[tk] || tk.replace(/-/g, ''));
    if (!q || !lineItems.includes(q)) { unresolved.push(tk); return null; }
    return q;
  }).filter(Boolean);
  let mandatory = [];
  const atLeastOneGroups = [];
  let mode;
  const notes = [];
  if ((/^All elements are mandatory except/i.test(text)) || /^All elements mandatory except/i.test(text)) {
    mode = 'all-except';
    const exceptPart = text.replace(/^All elements (are )?mandatory except( for)?( -)?/i, '');
    if (/elements in (\w+Abstract)/i.test(exceptPart)) {
      const abs = R.concept(/elements in (\w+Abstract)/i.exec(exceptPart)[1]);
      const under = descendants(tdefs, abs);
      mandatory = lineItems.filter((q) => !under.includes(q));
    } else {
      const ex = new Set(resolveList(exceptPart.replace(/\b(and)\b/g, ' ')));
      mandatory = lineItems.filter((q) => !ex.has(q));
    }
  } else if (/^All elements are mandatory$/i.test(text)) {
    mode = 'all'; mandatory = lineItems.slice();
  } else {
    mode = 'list';
    let body = text.replace(/^(Mandatory elements are|Elements mandatory are|Mandatory Elements are|Elements mandatory|Element for 'Provisions' is mandatory)\s*[-:;]?\s*/i, (x) => (/Provisions/.test(x) ? 'Provisions ' : ''));
    // "Atleast one element in XAbstract"
    let ae;
    while ((ae = /All elements in (\w+Abstract)/i.exec(body))) {
      mandatory.push(...descendants(tdefs, R.concept(ae[1])).filter((q) => !A.concepts[q].abstract));
      body = body.replace(ae[0], '');
    }
    const al = /Atleast one element in (\w+Abstract)/i.exec(body);
    if (al) {
      const abs = R.concept(al[1]);
      const group = descendants(tdefs, abs);
      // Evidence (MCA-validated CHARVAK_2024-25.xml): Key Management Personnel rows whose only transaction is
      // RemunerationForKeyManagerialPersonnel (sibling TransactionRelatingToKeyManagementPersonnelAbstract) were
      // accepted, so transactions reported under that abstract also satisfy "at least one transaction".
      for (const extra of AT_LEAST_ONE_ALSO[R.local(abs)] || []) group.push(...descendants(tdefs, R.concept(extra)));
      atLeastOneGroups.push([...new Set(group)]);
      body = body.replace(al[0], '');
    }
    const ob = /In (OutstandingBalancesForRelatedPartyTransactionsAbstract)- Element for amount shall be mandatory for various transactions,?/i.exec(body);
    if (ob) {
      notes.push(ob[0].trim().replace(/,$/, ''));
      body = body.replace(ob[0], '');
    }
    mandatory.push(...resolveList(body));
  }
  for (const add of CHANGE_ADDITIONS[R.local(tdefs[0].hypercube)] || []) { const q = R.concept(add); if (q && !mandatory.includes(q)) mandatory.push(q); }
  const ast = { type: 'lineItemsMandatory', tables, concepts: [...new Set(mandatory)], atLeastOne: atLeastOneGroups };
  const res = { status: 'EXECUTABLE', implementation: `pattern:mandatory-line-items-${mode}`, ast, scope: { periods: ['CY', 'PY'] } };
  if (unresolved.length) res.unresolvedTokens = [...new Set(unresolved)];
  if (notes.length) { res.partial = true; res.ambiguous = notes.join('; '); }
  if (unresolved.length) { res.reason = `Tokens not matching a line item of the table in the 2016 DTS (not executable): ${[...new Set(unresolved)].join(', ')}`; res.unresolvedReason = res.reason; }
  return res;
}
function descendants(tdefs, abs) {
  const out = [];
  for (const t of tdefs) {
    const kids = new Map();
    for (const n of t.lineItemTree) (kids.get(n.parent) || kids.set(n.parent, []).get(n.parent)).push(n.concept);
    const stack = [abs];
    while (stack.length) { const c = stack.pop(); for (const k of kids.get(c) || []) { out.push(k); stack.push(k); } }
  }
  return [...new Set(out)];
}

// =====================================================================================
// exemption data
function resolveExempt(sheet, R) {
  return (sheet?.rows || []).map((r) => ({ table: r.table, axis: R.concept(r.axis), member: R.concept(r.member), line: r.line })).filter((x) => x.axis && x.member);
}
function dataStatus(si, r, R, consumer) {
  if (si > 0) return { status: 'NOT_APPLICABLE', reason: 'Legacy duplicate sheet; the primary sheet is consumed' };
  if (!R.concept(r.axis) || !R.concept(r.member)) return { status: 'NOT_APPLICABLE', reason: 'Axis/member not present in the C&I 2016 DTS' };
  return { status: 'EXECUTABLE', implementation: `data:${consumer} exemption list` };
}
function resolvePcExempt(sheet, R, A) {
  const out = [];
  for (const r of sheet?.rows || []) {
    const abs = R.concept(r.abstract);
    let mode = 'all', except = [];
    const m = /All (?:child )?elements are exempt except (.+)$/i.exec(r.text);
    if (m) { mode = 'except'; except = (m[1].match(/[A-Z]\w{5,}/g) || []).map((t) => R.concept(t)).filter(Boolean); }
    const f = /Following child elements are exempt:\s*(.+)$/i.exec(r.text);
    if (f) { mode = 'listed'; except = (f[1].match(/[A-Z]\w{5,}/g) || []).map((t) => R.concept(t)).filter(Boolean); }
    const elr = !abs ? A.elrs.find((e) => norm(e.title) === norm(r.abstract))?.uri || null : null;
    out.push({ abstract: abs, elr, mode, concepts: except, line: r.line, text: r.text });
  }
  return out;
}

// =====================================================================================
// generic rules — each handled by a dedicated engine routine in src/core/rules.js
const G = (impl, extra = {}) => ({ status: 'EXECUTABLE', implementation: `generic:${impl}`, ast: { type: 'generic', handler: impl, ...extra } });
const GENERIC = {
  1: () => G('calc-parent-child'),
  2: () => G('mandatory-line-items-driver'),
  3: (A, R) => G('dimension-parent-child-members', { excludedLineItems: ['DescriptionOfNatureAndPurposeOfOtherReserves', 'NatureOfOtherLoansAndAdvances', 'NatureOfOtherInventories', 'NatureOfOtherTangibleAssets', 'NatureOfOtherIntangibleAssets'].map((n) => R.concept(n)).filter(Boolean) }),
  4: () => G('sequential-members'),
  5: () => G('no-images'),
  6: (A, R) => G('cy-py-pairing', { exemptElrCodes: ['201900'] }),
  7: () => ({ ...G('opening-equals-prior-closing'), note: 'Structural: opening (current) and closing (previous) share one instant context, so they cannot diverge; the engine also verifies imported duplicates.' }),
  8: () => G('monetary-max-2-decimals'),
  9: (A, R) => G('inr-currency', { exemptTables: R.tablesByHc('DetailsOfSubsidiariesTable').concat(R.tablesByHc('DisclosureOfDetailsOfSubsidiariesTable')) }),
  10: () => ({ status: 'REVIEW_ONLY_EXTERNAL_DATA', implementation: 'review:incorporation-date', reason: 'Date of incorporation is MCA21 master data; the C&I 2016 DTS has no date-of-incorporation element, so the instance cannot be checked against it' }),
  11: (A) => G('elr-not-for-consolidated', { codes: ['202800', '300700', '400300', '400400', '202300', '202400', '202500', '400500', '301000'] }),
  12: (A) => G('elr-not-for-prior-year', {
    codes: ['400200', '202400', '202500', '400100', '202800', '300700', '400300', '400400', '202300', '202600', '400500', '301000'],
    exceptions: { '400100': ['PeriodCoveredByFinancialStatements', 'DateOfStartOfReportingPeriod', 'DateOfEndOfReportingPeriod'], '400400': ['NumberOfSharesHeld', 'NumberOfDematSharesHeld', 'NumberOfPhysicalSharesHeld', 'PercentageOfTotalSharesHeld', 'PercentageOfSharesPledgedEncumberedToTotalShares', 'PrincipalAmount', 'InterestDueButNotPaid', 'InterestAccruedButNotDue', 'Indebtedness'] },
  }),
  13: () => ({ ...G('general-info-consolidated', { allowed: ['DisclosureOfCompanyInformationAbstract', 'NameOfCompany', 'CorporateIdentityNumber', 'PermanentAccountNumberOfEntity', 'AddressOfRegisteredOfficeOfCompany', 'TypeOfIndustry', 'PeriodCoveredByFinancialStatements', 'DateOfStartOfReportingPeriod', 'DateOfEndOfReportingPeriod', 'NatureOfReportStandaloneConsolidated', 'ContentOfReport', 'DescriptionOfPresentationCurrency', 'LevelOfRoundingUsedInFinancialStatements', 'TypeOfCashFlowStatement'] }), note: 'Second sentence (values identical across the standalone and consolidated instance documents) needs the other instance: REVIEW_ONLY_EXTERNAL_DATA, reported by the engine as such.' }),
  14: () => G('elr-not-for-standalone', { codes: ['202600'] }),
  15: (A, R) => G('mandatory-axes', { tables: {
    DisclosureOfShareholdingMoreThanFivePerCentInCompanyTable: ['ClassesOfShareCapitalAxis', 'NameOfShareholderAxis'],
    ClassificationOfBorrowingsTable: ['ClassificationBasedOnTimePeriodAxis', 'ClassificationOfBorrowingsAxis', 'SubclassificationOfBorrowingsAxis'],
    DisclosureOfTangibleAssetsTable: ['ClassesOfTangibleAssetsAxis', 'CarryingAmountAccumulatedDepreciationAndGrossCarryingAmountAxis'],
    DisclosureOfIntangibleAssetsTable: ['ClassesOfIntangibleAssetsAxis', 'CarryingAmountAccumulatedAmortizationAndImpairmentAndGrossCarryingAmountAxis'],
    LoansAndAdvancesTable: ['ClassificationBasedOnTimePeriodAxis', 'ClassificationOfLoansAndAdvancesAxis', 'ClassificationOfAssetsBasedOnSecurityAxis'],
  } }),
  16: () => ({ status: 'NOT_APPLICABLE', reason: 'Guidance on completeness of reporting; not machine-checkable against the instance' }),
  17: () => G('taxonomy-period-applicability', { from: '2014-04-01' }),
};

// =====================================================================================
// test references (suite files that exercise each implementation family)
const TESTS = {
  mandatory: 'test/rules.test.mjs#mandatory', gte0: 'test/rules.test.mjs#sign', gt0: 'test/rules.test.mjs#sign', 'lte100pct': 'test/rules.test.mjs#sign',
  'lte-today': 'test/rules.test.mjs#dates', 'lte-ref': 'test/rules.test.mjs#compare', 'eq-product': 'test/rules.test.mjs#compare', 'eq-ref': 'test/rules.test.mjs#compare',
  'mandatory-consolidated': 'test/rules.test.mjs#reportType', 'mandatory-standalone': 'test/rules.test.mjs#reportType', 'mandatory-if-yes': 'test/rules.test.mjs#conditional',
  'mandatory-if-entered': 'test/rules.test.mjs#conditional', 'mandatory-iff-entered': 'test/rules.test.mjs#conditional', 'amount-number-pair': 'test/rules.test.mjs#conditional',
  'continuing-default': 'test/rules.test.mjs#conditional', 'mandatory-for-member': 'test/rules.test.mjs#member', 'mandatory-if-gt0': 'test/rules.test.mjs#conditional', 'mandatory-if-ne0': 'test/rules.test.mjs#conditional',
  'format-cin': 'test/rules.test.mjs#formats', 'format-pan': 'test/rules.test.mjs#formats', 'format-country': 'test/rules.test.mjs#formats',
  'table-if-gt0': 'test/applicability.test.mjs', 'table-if-any': 'test/applicability.test.mjs', 'table-if-ne0': 'test/applicability.test.mjs', 'table-if-yes': 'test/applicability.test.mjs',
  'bonds-debentures-iff': 'test/rules.test.mjs#tables', 'sharecapital-lte-subscribed': 'test/rules.test.mjs#sums', 'sharecapital-classes-sum': 'test/rules.test.mjs#sums', 'reserves-first-level': 'test/rules.test.mjs#sums',
  'borrowings-first-level': 'test/rules.test.mjs#sums', 'typed-members-sum': 'test/rules.test.mjs#sums', 'sum-two-eq': 'test/rules.test.mjs#sums', 'provisions-term-sum': 'test/rules.test.mjs#sums', 'loansandadvances-term-sum': 'test/rules.test.mjs#sums',
  'shareholder-cin-or-pan': 'test/rules.test.mjs#formats', 'shareholders-lte-paidup': 'test/rules.test.mjs#sums', 'shareholding-pct-lte-100': 'test/rules.test.mjs#sums', 'private-placement-persons': 'test/rules.test.mjs#conditional', 'public-offering-yes': 'test/rules.test.mjs#conditional',
  'change-date-mandatory': 'test/rules.test.mjs#change', 'mandatory-line-items': 'test/rules.test.mjs#lineItems',
  'mandatory-line-items-list': 'test/rules.test.mjs#lineItems', 'mandatory-line-items-all': 'test/rules.test.mjs#lineItems', 'mandatory-line-items-all-except': 'test/rules.test.mjs#lineItems',
  'calc-parent-child': 'test/calculation.test.mjs', 'mandatory-line-items-driver': 'test/rules.test.mjs#lineItems', 'dimension-parent-child-members': 'test/rules.test.mjs#generic',
  'sequential-members': 'test/typed.test.mjs', 'no-images': 'test/rules.test.mjs#generic', 'cy-py-pairing': 'test/rules.test.mjs#generic', 'opening-equals-prior-closing': 'test/periods.test.mjs',
  'monetary-max-2-decimals': 'test/rules.test.mjs#generic', 'inr-currency': 'test/rules.test.mjs#generic', 'elr-not-for-consolidated': 'test/applicability.test.mjs', 'elr-not-for-prior-year': 'test/applicability.test.mjs',
  'general-info-consolidated': 'test/applicability.test.mjs', 'elr-not-for-standalone': 'test/applicability.test.mjs', 'mandatory-axes': 'test/rules.test.mjs#generic', 'taxonomy-period-applicability': 'test/rules.test.mjs#generic',
  'exempt-parent-member': 'test/rules.test.mjs#generic', 'exempt-child-member': 'test/rules.test.mjs#generic', 'exempt-calculation': 'test/calculation.test.mjs',
};

// =====================================================================================
// descriptions for the coverage ledger
function describe(p) {
  if (!p) return null;
  switch (p.op) {
    case 'cmp': return `${dx(p.l)} ${p.cmp} ${dx(p.r)}`;
    case 'and': case 'or': return p.args.map(describe).join(` ${p.op.toUpperCase()} `);
    case 'not': return `NOT ${describe(p.arg)}`;
    case 'entered': return `entered(${dx(p.e)})`;
    case 'reportType': return `reportType = ${p.value}`;
    case 'format': return `${p.format}(${dx(p.e)})`;
    case 'anyFact': return `any ${p.concept} where ${describe(p.pred)}`;
    case 'existsFact': return `exists ${p.concept} where ${describe(p.pred)}`;
    case 'iff': return `(${describe(p.args[0])}) IFF (${describe(p.args[1])})`;
    case 'notInFacts': return `${dx(p.e)} not in ${p.concept}`;
    case 'hasMember': return `member = ${p.member}`;
    case 'tableData': return `data in ${p.tables.join(', ')}`;
    case 'memberHasData': return `${p.member} reported in ${p.tables.join(', ')}`;
    default: return p.op;
  }
}
function dx(e) {
  if (!e) return '?';
  if (e.self) return '$self';
  if (e.fact) return e.fact + (e.ctx === 'nondim' ? '[no-dim]' : '') + (e.scope ? `[${e.scope}]` : '');
  if ('const' in e) return JSON.stringify(e.const);
  if (e.mul) return e.mul.map(dx).join(' × ');
  if (e.add) return e.add.map(dx).join(' + ');
  if (e.today) return 'today';
  if (e.upper) return `upper(${dx(e.upper)})`;
  if (e.sumAxis) return `Σ ${e.sumAxis.concept} over ${e.sumAxis.axis} (${e.sumAxis.level})`;
  if (e.avgAxis) return `avg ${e.avgAxis.concept} over ${e.avgAxis.axis}`;
  if (e.maxFacts) return `latest(${e.maxFacts.join(', ')})`;
  if (e.addMonths) return `${dx(e.addMonths.e)} + ${e.addMonths.n} months`;
  if (e.addDays) return `${dx(e.addDays.e)} + ${e.addDays.n} days`;
  return JSON.stringify(e);
}
function opOf(ast) {
  if (ast.type === 'eachFact' || ast.type === 'assert' || ast.type === 'eachFactOf') return ast.assert?.op === 'cmp' ? ast.assert.cmp : ast.assert?.op || ast.type;
  return ast.type;
}
function operandsOf(ast) {
  const out = new Set();
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if ((k === 'fact' || k === 'concept') && typeof v === 'string') out.add(v);
      else if (k === 'concepts' && Array.isArray(v)) v.forEach((c) => out.add(c));
      else if (typeof v === 'object') walk(v);
    }
  };
  walk(ast);
  return [...out];
}

// =====================================================================================
// Clause families of the complete V1.3 workbook ([200600]–[400500]) — additions.
// Each family is a literal reading of the MCA sentence; anything needing data outside the instance
// is REVIEW_ONLY_EXTERNAL_DATA, anything without an executable constraint is NOT_APPLICABLE.
const EXTERNAL = [
  [/^Name (?:of the company )?should be based on/i, 'Name must match the MCA21 master record of the CIN/DIN entered — master data is not part of the instance document'],
  [/^If value of .DesignationOfKeyManagerialPersonnelOrDirector. is one of the below then Name should be/i, 'Name must match the MCA21 DIN/PAN master record — master data is not part of the instance document'],
  [/^Should be valid DIN$/i, 'DIN validity is established against the MCA21 DIN register, which is not part of the instance document'],
  [/associated with (?:the )?compan/i, 'Association of the person with the company is established from MCA21 master data, which is not part of the instance document'],
  [/^Should be same as entered in the Form/i, 'Comparison with the e-form (AOC-4 XBRL) in which the instance is attached; the form is not part of the instance document'],
  [/^(?:Valid SRN|Should be valid SRN|Should belong to CIN of subsidiary company|Z99999999 should be entered only)/i, 'SRN validity/ownership is established from MCA21 filing records, which are not part of the instance document'],
  [/(?:ICAI|ICSI) database/i, 'Validity is established against the ICAI/ICSI member database, which is not part of the instance document'],
  [/^Status of the company/i, 'Requires company class from MCA21 company master data, which is not part of the instance document'],
  [/in case of OPC, 2 in case of private company/i, 'Requires company class (OPC/Private/Public/Producer) from MCA21 company master data, which is not part of the instance document'],
  [/currency code as per the list of currency codes/i, 'The list of currency codes is not part of the MCA authority package (workbook sheets, taxonomy, Filing Manual)'],
  [/ITC\/NPCS/i, 'The ITC/NPCS product code master is not part of the MCA authority package'],
];
const NO_CONSTRAINT = [
  [/^This can be less than the date of incorporation of the filing company$/i, 'Permissive statement: allows a value, imposes no validation constraint'],
];

const QQ = `['"]\\s*([^'"]+?)\\s*['"]`;
// "... mandatory ..." heads used across the workbook
const MAND_HEAD = String.raw`(?:Mandatory(?: to enter)?|Shall be mandatory|Should be mandatory|Table should be mandatory|Table is mandatory|This (?:is a |is )?mandatory(?: field| item| element)?|This (?:field|item|element|table|Table) (?:is|will be|becomes) (?:mandatory|Mandatory|mandtory))`;

// Condition grammar of conditional-mandatory sentences. Returns { concepts, pred(ref) } where ref(q)
// yields the operand expression for concept q, or null.
function parseCondition(c, R, A) {
  let m;
  const enumOf = (q) => A.types?.[A.concepts[q]?.type]?.enumerations || null;
  const date = (d, mo, y) => `${y}-${mo}-${d}`;
  const yes = (q, v) => ({ concepts: [q], pred: (ref) => ({ op: 'cmp', cmp: '==', l: ref(q), r: { const: v } }) });
  if ((m = new RegExp(`^'?(Yes|No)'? (?:is )?selected in (?:field |element )?(?:${QQ}|(\\w+))$`, 'i').exec(c))) {
    const q = R.concept(m[2] || m[3]); if (q && A.concepts[q].type === 'xbrli:booleanItemType') return yes(q, /^yes$/i.test(m[1]));
  }
  if ((m = new RegExp(`^(?:${QQ}|(\\w+)) is (?:selected as )?'?(Yes|No)'?$`, 'i').exec(c))) {
    const q = R.concept(m[1] || m[2]); if (q && A.concepts[q].type === 'xbrli:booleanItemType') return yes(q, /^yes$/i.test(m[3]));
  }
  if ((m = new RegExp(`^(?:${QQ}|(\\w+)) is entered$`, 'i').exec(c))) {
    const q = R.concept(m[1] || m[2]); if (q) return { concepts: [q], pred: (ref) => ({ op: 'entered', e: ref(q) }) };
  }
  if ((m = /^name of the service provider? (?:is )?entered$/i.exec(c))) {
    const q = R.concept('NameOfTheServiceProvider'); if (q) return { concepts: [q], pred: (ref) => ({ op: 'entered', e: ref(q) }) };
  }
  if ((m = /^Yes is selected in "where the books of account and other books and papers are maintained on cloud-?"?$/i.exec(c))) {
    const q = R.concept('WhetherBooksOfAccountAndOtherBooksAndPapersAreMaintainedOnCloud'); if (q) return yes(q, true);
  }
  const num = (cmp) => (q) => ({ concepts: [q], nondim: true, pred: (ref) => ({ op: 'cmp', cmp, l: ref(q), r: { const: 0 } }) });
  if ((m = new RegExp(`^(?:value entered in |amount of |amount entered in )?(?:${QQ}|(\\w+))(?: in (?:balance sheet|financial statements?))? is greater than zero$`, 'i').exec(c))) {
    const q = R.concept(m[1] || m[2]); if (q && A.concepts[q].kind === 'item') return num('>')(q);
  }
  if ((m = new RegExp(`^(?:${QQ}|(\\w+))(?: in (?:balance sheet|financial statements?))? is other than zero(?: in (?:balance sheet|financial statements?))?$`, 'i').exec(c))) {
    const q = R.concept(m[1] || m[2]); if (q && A.concepts[q].kind === 'item') return num('!=')(q);
  }
  if ((m = new RegExp(`^${QQ}\\s*or\\s*${QQ} is greater than zero$`, 'i').exec(c))) {
    const a = R.concept(m[1]), b = R.concept(m[2]);
    if (a && b) return { concepts: [a, b], nondim: true, pred: (ref) => ({ op: 'or', args: [a, b].map((q) => ({ op: 'cmp', cmp: '>', l: ref(q), r: { const: 0 } })) }) };
  }
  if ((m = new RegExp(`^${QQ} is selected in ${QQ}$`, 'i').exec(c))) {
    const q = R.concept(m[2]); const en = q && enumOf(q);
    const v = en && (en.find((e) => e.toLowerCase() === m[1].toLowerCase()) || ENUM_ALIASES[m[1].toLowerCase()]);
    if (v && en.includes(v)) return { concepts: [q], pred: (ref) => ({ op: 'cmp', cmp: '==', l: { upper: ref(q) }, r: { const: v.toUpperCase() } }) };
  }
  if ((m = /^(\w+) is other than "([^"]+)"$/i.exec(c))) {
    const q = R.concept(m[1]); const en = q && enumOf(q);
    const v = en && en.find((e) => e.toLowerCase() === m[2].toLowerCase());
    if (v) return { concepts: [q], pred: (ref) => ({ op: 'cmp', cmp: '!=', l: { upper: ref(q) }, r: { const: v.toUpperCase() } }) };
  }
  if ((m = /^"?DateOfStartOfReportingPeriod"? is more than (\d{2})\/(\d{2})\/(\d{4})$/i.exec(c))) {
    const q = R.concept('DateOfStartOfReportingPeriod');
    return { concepts: [q], nondim: true, pred: (ref) => ({ op: 'cmp', cmp: '>', l: ref(q), r: { const: date(m[1], m[2], m[3]), kind: 'date' } }) };
  }
  return null;
}
// Enumerated values quoted in the rule text that differ in wording from the taxonomy enumeration.
// Each has exactly one counterpart in the element's enumeration.
const ENUM_ALIASES = { 'key managerial personnel': 'Key Management Personnel' };

function tablesOfRow(subject, row, A) {
  const all = A.tables.filter((t) => t.lineItems.includes(subject));
  const here = row.elr ? all.filter((t) => t.code === row.elr.code || t.id.startsWith(row.elr.code)) : [];
  return (here.length ? here : all).map((t) => t.id);
}

function formalizeExtended(s, subject, row, R, A, ok) {
  let m;
  const isTable = A.concepts[subject].kind === 'hypercube';
  const nondim = (q) => isNondimOnly(q, A);
  const nd = (q) => ({ fact: q, ctx: 'nondim' });
  const self = { self: true };
  const each = (impl, assert, extra = {}, scope) => ok(`pattern:${impl}`, { type: 'eachFact', concept: subject, assert, ...extra }, scope);
  const refOf = (q) => (nondim(q) ? nd(q) : { fact: q });

  // -------- table-level
  if (isTable) {
    const tables = R.tablesByHc(R.local(subject));
    if (!tables.length) return null;
    if (/^(?:This (?:is a|ia a) mandatory table|This table is mandatory)$/i.test(s)) return ok('pattern:table-mandatory', { type: 'tableRequired', tables, when: null }, { periods: ['CY', 'PY'] });
    if ((m = new RegExp(`^${MAND_HEAD}(?: only)?,? (?:if|in case) (.+)$`, 'i').exec(s))) {
      const c = parseCondition(m[1].trim(), R, A);
      // "mandatory if" is a requirement, not an availability restriction: the MCA-validated INFOBAHN
      // instance reports [201100] intangible-asset rows while IntangibleAssets = 0. Only "mandatory only if"
      // also restricts the table to the condition (gate).
      const gate = /\bonly if\b/i.test(s);
      if (c && (c.nondim || c.concepts.every(nondim))) return ok('pattern:table-conditional', { type: 'tableRequired', tables, when: c.pred(nd), gate }, { periods: ['CY', 'PY'] });
      if (c) return ok('pattern:table-conditional', { type: 'tableRequired', tables, when: { op: 'anyFact', concept: c.concepts[0], pred: c.pred(() => self) }, gate }, { periods: ['CY', 'PY'] });
    }
    if ((m = /^All Details(?: \(Except name of audit firm\))? of atleast one (?:director|auditor) (?:should be entered|to be mandatory)$/i.exec(s))) {
      const except = /Except name of audit firm/i.test(s) ? [R.concept('NameOfAuditFirm')] : [];
      return ok('pattern:table-one-complete-member', { type: 'tableOneComplete', tables, except }, { periods: ['CY'] });
    }
    return null;
  }

  // -------- line-items abstract
  if (/LineItems$/.test(R.local(subject)) && /^In case a line item is provided for any member then the same line item cannot be provided against any other member$/i.test(s)) {
    const tables = R.tablesByHc(R.local(subject).replace(/LineItems$/, 'Table'));
    if (tables.length) return ok('pattern:line-item-single-member', { type: 'lineItemSingleMember', tables }, { periods: ['CY', 'PY'] });
  }
  if (A.concepts[subject].abstract && /^Mandatory if/i.test(s)) {
    return { status: 'NOT_APPLICABLE', reason: 'Abstract element: cannot carry a value; the same condition is executed on each of its line items (following rows)' };
  }

  // -------- unconditional mandatory
  if (/^(?:This is mandatory field|This field is mandatory|This is a mandatory item|This is a mandatory element)$/i.test(s)) return ok('pattern:mandatory', { type: 'mandatory', concept: subject });
  if (/^Mandatory Line item$/i.test(s)) return ok('pattern:mandatory-line-item', { type: 'lineItemsMandatory', tables: tablesOfRow(subject, row, A), concepts: [subject] });
  // -------- report type / current year
  if (/^This is a mandatory field (?:only )?(?:in case of |for )?stand ?alone (?:instance|intance) document(?: only)?$/i.test(s) || /^This is a mandatory field in case of standalone instance document(?: only)?$/i.test(s)) {
    return ok('pattern:mandatory-standalone', { type: 'mandatory', concept: subject, when: { op: 'reportType', value: 'Standalone' } });
  }
  if (/^This is a mandatory field only in case of stand alone intance document$/i.test(s)) return ok('pattern:mandatory-standalone', { type: 'mandatory', concept: subject, when: { op: 'reportType', value: 'Standalone' } });
  if (/^This is mandatory (?:field )?in case of current financial year$/i.test(s)) return ok('pattern:mandatory-current-year', { type: 'mandatory', concept: subject }, { periods: ['CY'] });
  if (/^This is mandatory field in case of current financial year and stand alone instance document only$/i.test(s)) return ok('pattern:mandatory-current-year-standalone', { type: 'mandatory', concept: subject, when: { op: 'reportType', value: 'Standalone' } }, { periods: ['CY'] });

  // -------- sign / range
  if (/^(?:Should|Shall|It should) be (?:greater than or equal to|equal to or greater than) zero(?: \(if entered\))?$/i.test(s)) return each('gte0', { op: 'cmp', cmp: '>=', l: self, r: { const: 0 } });
  if (/^This should be greater than zero$/i.test(s)) return each('gt0', { op: 'cmp', cmp: '>', l: self, r: { const: 0 } });
  if (/^Should not be greater than 100%$/i.test(s)) return each('lte100pct', { op: 'cmp', cmp: '<=', l: self, r: { const: 1 } });
  if (/^Should be less than system date$/i.test(s)) return each('lt-today', { op: 'cmp', cmp: '<', l: self, r: { today: true } });
  if (/^Difference between this date and system date should be greater than or equal to 18 years$/i.test(s)) return each('min-age-18', { op: 'cmp', cmp: '<=', l: self, r: { addMonths: { e: { today: true }, n: -216 } } });

  // -------- formats
  if (/^(?:Should|It should) be (?:a )?valid PAN as per (?:the )?income[ _]tax(?:[ _]PAN)? format$/i.test(s) || /^Should be a valid PAN as per the income tax format$/i.test(s)) return each('format-pan', { op: 'format', format: 'PAN', e: self });
  if (/^Should be (?:a )?valid CIN(?:, if provided)?$/i.test(s)) return each('format-cin', { op: 'format', format: 'CIN', e: self });
  if (/^Should be a valid country as per the list of countries$/i.test(s)) return each('format-country', { op: 'format', format: 'country', e: self });
  if (/^Should be INR$/i.test(s)) return each('eq-const', { op: 'cmp', cmp: '==', l: { upper: self }, r: { const: 'INR' } });
  if (/^Only Commercial and Industrial can be selected for the time being$/i.test(s)) return each('eq-const', { op: 'cmp', cmp: '==', l: self, r: { const: 'Commercial and Industrial' } }, {}, { periods: ['CY'] });

  // -------- different from the filing company / auditor
  const CIN = R.concept('CorporateIdentityNumber'), PAN = R.concept('PermanentAccountNumberOfEntity');
  const cy = (q) => ({ fact: q, ctx: 'nondim', scope: 'CY' });
  if (/^Should be different from CIN of filing company(?: \(CorporateIdentityNumber\))?$/i.test(s)) return each('ne-filing-cin', { op: 'cmp', cmp: '!=', l: { upper: self }, r: { upper: cy(CIN) } });
  if (/^Should be different from (?:the )?PAN of (?:the )?(?:filing )?company$/i.test(s)) return each('ne-filing-pan', { op: 'cmp', cmp: '!=', l: { upper: self }, r: { upper: cy(PAN) } });
  if (/^Should be different from the PAN of company and auditor$/i.test(s)) {
    return each('ne-filing-pan-auditor', { op: 'and', args: [
      { op: 'cmp', cmp: '!=', l: { upper: self }, r: { upper: cy(PAN) } },
      { op: 'notInFacts', e: self, concept: R.concept('PermanentAccountNumberOfAuditorOrAuditorsFirm') },
    ] });
  }
  // -------- uniqueness across the members of a repetitive (typed) table
  if (/should be unique/i.test(s) && /repetitive|dimension|tuple/i.test(s)) return ok('pattern:unique-across-members', { type: 'unique', concept: subject, tables: tablesOfRow(subject, row, A) });

  // -------- comparisons with another element
  if ((m = new RegExp(`^Should be greater than or equal to (?:${QQ}|(\\w+))(?: entered)?$`, 'i').exec(s))) {
    const q = R.concept(m[1] || m[2]);
    if (q) return each('gte-ref', { op: 'cmp', cmp: '>=', l: self, r: refOf(q) });
  }
  if ((m = /^Should be greater than or equal to (\d{2})\.(\d{2})\.(\d{4})$/.exec(s))) return each('gte-date', { op: 'cmp', cmp: '>=', l: self, r: { const: `${m[3]}-${m[2]}-${m[1]}`, kind: 'date' } });
  if (/^Should be greater than or equal to Date of signing balance sheet by director or secretary or manager\. In case of multiple dates, latest date should be considered$/i.test(s)) {
    const qs = ['DateOfSigningOfFinancialStatementsByDirector', 'DateOfSigningOfFinancialStatementsByCompanySecretary', 'DateOfSigningOfFinancialStatementsByManager'].map((n) => R.concept(n));
    return each('gte-latest-of', { op: 'cmp', cmp: '>=', l: self, r: { maxFacts: qs } });
  }
  if (/^Difference between start date and end date should not be greater than 18 months$/i.test(s)) {
    return each('max-18-months', { op: 'cmp', cmp: '<', l: self, r: { addMonths: { e: nd(R.concept('DateOfStartOfReportingPeriod')), n: 18 } } });
  }
  if (/^In case of previous year, date entered in this field should be one day less than date entered in field 'DateOfStartOfReportingPeriod' for current year\.?'?$/i.test(s)) {
    return each('py-end-before-cy-start', { op: 'cmp', cmp: '==', l: self, r: { addDays: { e: cy(R.concept('DateOfStartOfReportingPeriod')), n: -1 } } }, {}, { periods: ['PY'] });
  }
  if ((m = /^Value in CarryingAmountMember should be equal to '(\w+)' less '(\w+)'$/i.exec(s))) {
    const gross = R.concept(m[1]), acc = R.concept(m[2]), carrying = R.concept('CarryingAmountMember');
    const ax = A.tables.filter((t) => t.lineItems.includes(subject)).flatMap((t) => t.axes).find((a) => [gross, acc, carrying].every((x) => a.members.some((y) => y.member === x)));
    if (ax) return ok('pattern:member-difference', { type: 'memberArith', concept: subject, axis: ax.axis, target: carrying, plus: [gross], minus: [acc] });
  }
  if ((m = /^Summation of CarryingAmountMember for the following (?:first level child )?members in ClassesOf ?(Tangible|Intangible)AssetsAxis should be equal to '(\w+)' in Balance sheet: (.+)$/i.exec(s))) {
    const axis = R.concept(`ClassesOf${m[1]}AssetsAxis`);
    const listed = m[3].trim().split(/\s+/);
    const members = listed.map((n) => R.concept(n) || R.concept(n.replace(/Member$/, 'sMember')));
    if (axis && members.every(Boolean)) return ok('pattern:listed-members-sum', { type: 'assert', assert: { op: 'cmp', cmp: '==', l: { sumAxis: { concept: subject, axis, level: 'members', members } }, r: nd(R.concept(m[2])) } });
  }
  if ((m = /^Summation of (\w+) - (\w+); (\w+); (\w+) should be equal to '(\w+)' in financial statements$/i.exec(s))) {
    const members = [m[2], m[3], m[4]].map((n) => R.concept(n));
    const ax = A.tables.filter((t) => t.lineItems.includes(subject)).flatMap((t) => t.axes).find((a) => members.every((x) => a.members.some((y) => y.member === x)));
    if (ax && R.concept(m[1]) === subject) return ok('pattern:listed-members-sum', { type: 'assert', assert: { op: 'cmp', cmp: '==', l: { sumAxis: { concept: subject, axis: ax.axis, level: 'members', members } }, r: nd(R.concept(m[5])) } });
  }

  // -------- CSR ([301000] / [301000a])
  if (/^Value entered in this field Financial Year Member 1, should match with the value entered in the ELR "100200" for the element "ProfitBeforeTax" for the previous reporting period$/i.test(s)) {
    return each('fy1-eq-py-pbt', { op: 'cmp', cmp: '==', l: self, r: { fact: R.concept('ProfitBeforeTax'), ctx: 'nondim', scope: 'PY' } }, { when: { op: 'hasMember', member: R.concept('FinancialYearMember1') } }, { periods: ['CY'] });
  }
  if (/^Details of atleast year one member will be mandatory if Disclosure of net profits for last three financial years \[Table\] becomes mandatory$/i.test(s)) {
    const tables = R.tablesByHc('DisclosureOfNetProfitsForLastThreeFinancialYearsTable');
    const csr = R.concept('WhetherProvisionsOfCorporateSocialResponsibilityAreApplicableOnCompany');
    return ok('curated:csr-fy1-member', { type: 'assert', when: { op: 'cmp', cmp: '==', l: nd(csr), r: { const: true } }, assert: { op: 'memberHasData', tables, member: R.concept('FinancialYearMember1') } }, { periods: ['CY'] });
  }
  if ((m = /^Value entered here should be equivalent to average of values entered in "(\w+)"$/i.exec(s))) {
    const q = R.concept(m[1]);
    const ax = q && A.tables.find((t) => t.lineItems.includes(q))?.axes[0];
    if (ax) return each('eq-average-of-members', { op: 'cmp', cmp: '==', approx: true, l: self, r: { avgAxis: { concept: q, axis: ax.axis, level: 'all' } } }, {}, { periods: ['CY'] });
  }
  if (/^Value entered here should be 2 percent of "AverageNetProfitForLastThreeFinancialYears" if "AverageNetProfitForLastThreeFinancialYears" is greater than zero$/i.test(s)) {
    const avg = R.concept('AverageNetProfitForLastThreeFinancialYears');
    return each('eq-2pct-average', { op: 'cmp', cmp: '==', approx: true, l: self, r: { mul: [nd(avg), { const: '0.02' }] } }, { when: { op: 'cmp', cmp: '>', l: nd(avg), r: { const: 0 } } }, { periods: ['CY'] });
  }
  if (/^(?:The amount entered here should be same as "CSRExpenditure" in ELR 100200 of 'Statement of profit and loss"\s*)+$/i.test(s)) {
    return each('eq-ref', { op: 'cmp', cmp: '==', l: self, r: nd(R.concept('CSRExpenditure')) }, {}, { periods: ['CY'] });
  }
  if (/^AND It should match with the total of CSR spending amount in the 'ClassificationOfCSRSpendingTable' table element 'AmountSpentOnProjectsOrPrograms'$/i.test(s)) {
    const q = R.concept('AmountSpentOnProjectsOrPrograms');
    const ax = A.tables.find((t) => t.lineItems.includes(q)).axes[0];
    return each('eq-table-total', { op: 'cmp', cmp: '==', l: self, r: { sumAxis: { concept: q, axis: ax.axis, level: 'all' } } }, {}, { periods: ['CY'] });
  }

  // -------- related parties / group entities
  if (/^\(Holding company\) or \(Ultimate Holding company\) should be selected in atleast one dimensional member in case Yes is selected in 'WhetherCompanyIsSubsidiaryCompany' and vice-a-versa$/i.test(s)) {
    const sub = R.concept('WhetherCompanyIsSubsidiaryCompany');
    const holding = { op: 'existsFact', concept: subject, pred: { op: 'or', args: ['HOLDING COMPANY', 'ULTIMATE HOLDING COMPANY'].map((v) => ({ op: 'cmp', cmp: '==', l: { upper: self }, r: { const: v } })) } };
    return ok('curated:holding-iff-subsidiary', { type: 'assert', when: { op: 'entered', e: cy(sub) }, assert: { op: 'iff', args: [{ op: 'cmp', cmp: '==', l: cy(sub), r: { const: true } }, holding] } });
  }
  const sameTable = (pred) => A.tables.filter((t) => t.lineItems.includes(subject)).flatMap((t) => t.lineItems).find(pred);
  if (/^Either .+ is mandatory if country is India$/i.test(s) || /^Mandatory if country is India$/i.test(s)) {
    const country = sameTable((q) => /^CountryOfIncorporationOrResidence/.test(R.local(q)));
    const local = R.local(subject);
    const swaps = (n) => (/^CINOf/.test(n) ? [n.replace(/^CINOf/, 'PANOf'), n.replace(/^CINOf/, 'PermanentAccountNumberOf')] : [n.replace(/^(?:PANOf|PermanentAccountNumberOf)/, 'CINOf')]);
    let partner = null;
    if (/^Either/.test(s)) {
      for (const tok of [...s.matchAll(/'?([A-Za-z]+)'?/g)].map((x) => x[1])) { const q = R.concept(tok); if (q && q !== subject && sameTable((x) => x === q)) { partner = q; break; } }
      if (!partner) for (const cand of swaps(local)) { const q = R.concept(cand); if (q && q !== subject && sameTable((x) => x === q)) { partner = q; break; } }
    }
    const india = { op: 'cmp', cmp: '==', l: { upper: self }, r: { const: 'INDIA' } };
    if (country && (partner || /^Mandatory/.test(s))) {
      const assert = partner ? { op: 'or', args: [{ op: 'entered', e: { fact: subject } }, { op: 'entered', e: { fact: partner } }] } : { op: 'entered', e: { fact: subject } };
      return ok(partner ? 'pattern:cin-or-pan-if-india' : 'pattern:mandatory-if-india', { type: 'eachFactOf', concept: country, when: india, assert });
    }
  }
  if ((m = /^Mandatory if 'CINOfSubsidiaryCompany' is entered and (yes|No) is selected in field 'WhetherSubsidiaryHasFiledBalanceSheet'$/i.exec(s))) {
    const filed = R.concept('WhetherSubsidiaryHasFiledBalanceSheet'), cin = R.concept('CINOfSubsidiaryCompany');
    return ok('pattern:mandatory-if-entered-and-yes', { type: 'eachFactOf', concept: filed, when: { op: 'and', args: [{ op: 'cmp', cmp: '==', l: self, r: { const: /^yes$/i.test(m[1]) } }, { op: 'entered', e: { fact: cin } }] }, assert: { op: 'entered', e: { fact: subject } } });
  }
  if (/^Details of atleast one subsidiary shall be mandatory if yes is selected in field 'WhetherCompanyHasSubsidiaryCompanies'$/i.test(s)) {
    const tables = A.tables.filter((t) => t.lineItems.includes(R.concept('CINOfSubsidiaryCompany'))).map((t) => t.id);
    // gate: the next clause of the same cell says "Subsidiary details can be entered only if yes is selected"
    return ok('pattern:table-conditional', { type: 'tableRequired', tables, when: { op: 'cmp', cmp: '==', l: nd(subject), r: { const: true } }, gate: true }, { periods: ['CY'] });
  }
  if (/^Subsidiary details can be entered only if yes is selected in this field$/i.test(s)) {
    const tables = A.tables.filter((t) => t.lineItems.includes(R.concept('CINOfSubsidiaryCompany'))).map((t) => t.id);
    return ok('pattern:table-only-if-yes', { type: 'assert', when: { op: 'tableData', tables }, assert: { op: 'cmp', cmp: '==', l: nd(subject), r: { const: true } } }, { periods: ['CY'] });
  }
  // -------- cash-flow method
  if (/^Elements for cash flow- direct or indirect shall be applicable based on the value selected in field Type of cash flow/i.test(s)) {
    return ok('pattern:cash-flow-method', { type: 'cashFlowMethod', concept: subject }, { periods: ['CY', 'PY'] });
  }
  // -------- membership mandatory (unquoted member)
  if ((m = /^Mandatory in case of (\w+Member)$/i.exec(s))) {
    const mem = R.concept(m[1]);
    if (mem && A.concepts[mem].kind === 'member') return ok('pattern:mandatory-for-member', { type: 'memberMandatory', concept: subject, member: mem });
  }

  // -------- conditional mandatory (generic condition grammar)
  if ((m = new RegExp(`^${MAND_HEAD}(?: only)?,? (?:if|in case)\\s*(.+)$`, 'i').exec(s))) {
    const c = parseCondition(m[1].trim(), R, A);
    if (c) {
      if (c.nondim || c.concepts.every(nondim)) return ok('pattern:mandatory-conditional', { type: 'mandatory', concept: subject, when: c.pred(nd) }, c.concepts.some((q) => R.local(q) === 'DateOfStartOfReportingPeriod') ? { periods: ['CY'] } : undefined);
      if (c.concepts.length === 1) return ok('pattern:mandatory-conditional', { type: 'eachFactOf', concept: c.concepts[0], when: c.pred(() => self), assert: { op: 'entered', e: { fact: subject } } });
    }
    const tok = new RegExp(`^${QQ} is entered$`, 'i').exec(m[1].trim());
    if (tok && !R.concept(tok[1])) return { status: 'NOT_APPLICABLE', reason: `Condition element '${tok[1]}' is not present in the C&I 2016 DTS, so the condition can never be met` };
  }
  return null;
}
