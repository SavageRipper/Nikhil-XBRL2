# MCA C&I XBRL Studio

Local-first, browser-based preparation of MCA C&I 2016 XBRL instance documents. Taxonomy, dimensions,
calculations and business rules are compiled from the MCA authority files in this repository.

**Open the app:** `index.html` (GitHub Pages serves it at the site root). It is the built app — rebuild with `npm run build` after changing any source file and commit the new `index.html`.

Flat repository: every file sits at the root (no folders to create when uploading).

## v12 — the user can always resolve what the tool reports

Guarantee checked by machine on every release (`assurance.mjs`, `npm run test:assurance`, part of `npm test` and the
release gate), on both MCA-validated instances:

1. **Re-key**: starting from an empty filing, every fact of the accepted instance can be typed through the screen's own
   entry path, in any order (taxonomy order, reverse, random) → identical values, 0 validation errors.
2. **Mistakes**: mistakes made through the screen (clear, change, Yes/No flip, other option) raise only errors whose
   location is a cell or table the user can open and edit, and typing the original value back restores the filing
   exactly — no error, no changed value left behind.
3. **Locked cells**: every read-only (calculated) cell shows exactly the value the tool derives; none is locked and empty.
4. **Every rule has a place to fix it**: every element named by an executable MCA business rule (≈10,000 element ×
   year × filing combinations: an empty filing and both MCA instances) locates to a cell or table the user can open.

During development the same checks ran on 8,000+ further mistakes (both MCA instances and a real 2025-26 project, before
and after its fixes): 0 errors without a reachable, editable location. Undo restored the filing exactly every time,
except on the project as it came from v10: there the first edit also fills carrying amounts v10 had left empty
(MCA rule SR-L1380-1), which is intended.

Rules behind it (v12 corrections, all found by these checks):

| Rule | Before | Now |
|---|---|---|
| When is a total locked? | whenever its parts *could* be reported — an opening balance whose breakup is not reported (equity share warrants) could never be typed | only while the tool maintains it: a part has a value and the total is empty-filled/calculated or agrees with its parts. An empty cell is never locked |
| A total typed before its parts | replaced by the sum of whatever parts existed (balance-sheet trade receivables became 0 when the note's allowance 0 was typed, which switched the receivables table off — a dead end) | a total follows its parts when it agreed with them before the edit; a different entered or imported figure is kept and stays editable; GR-1 shows the difference. Result is independent of entry order |
| MCA "Parent child exempt calculation" (interest expense, warrants, refundable deposits, directors' remuneration …) | forced to the sum of the parts and locked | filled from the parts while empty, never locked, never overwrites an entered figure |
| Closing balance = opening + changes | locked (v11) — an audited closing with a rounding difference (CHARVAK reserves, 0.78) could not be typed | filled while empty, stays editable (not an MCA rule) |
| Carrying amount = gross − accumulated (MCA rule) | — | locked only when it agrees; an entered different value stays editable and SR-L1380/1364 point to it |
| Decimals of a calculated total | lowest decimals of the parts — a part imported at `-4` next to `-3` made totals fail "non-significant digits", and undoing the edit did not clear it | never fewer decimals than the total's own digits need |
| Error location of a table total / table rule | the tab, where the element has no row ("cell not shown") | the table's total column (added on click if not shown), the totals table, or the table; a location that is not a valid cell falls back to its table |
| Conditional table whose condition is calculated from the table's own values (trade receivables) or is the table's own total column (share capital) | clearing a value switched the table off, and the error then pointed into a closed table | stays open while it holds values (other conditional tables unchanged — [200500] regression) |
| Error on an axis, a member or a line-item heading (GR-3 parent member, SR-L3592 …) | no location | the table that carries it |
| Typing a calculated cell's own value | refused ("calculated") | accepted |
| A locked cell reached from an error | no hint | explains: correct its parts, or allow editing of calculated cells |

## v11 audit (corrections to v10)

Found by replaying a real FY 2025-26 project (prepared from the MCA-validated INFOBAHN 2024-25 instance) and by checking
that every fact of both MCA-validated instances has a visible cell. Architecture unchanged: same modules, same rule engine,
same generator; the generated XML of both golden instances is byte-identical to v10.

| # | Defect in v10 | Effect | Correction |
|---|---|---|---|
| 1 | Compiler (`dts.mjs`) treated arcs with the same parent/child but different `order`/`preferredLabel` as equivalent (XBRL 2.1 §3.5.3.9.7.4 requires all non-exempt attributes to match) | the **closing-balance row** of all 31 reconciliations was dropped (tangible/intangible assets, reserves, share capital, shares outstanding, other provisions, DBO, plan assets, cash-flow closing cash, …) — closings could not be entered: ML-1/ML-3/ML-14/ML-16 failed | key includes the non-exempt attributes; presentation gains the 31 `periodEndLabel` arcs, every other compiled section (hypercubes, dimensions, tables, calculations, rules) is identical |
| 2 | Dimensional tables had no **total column** (every axis at its default = facts without dimensions) | 61 (INFOBAHN) / 169 (CHARVAK) table totals that MCA-validated filings report could be imported but never entered for a new year (GR-6 "previous year entered, current year not") | `views.totalColumnAllowed` / `tableSlices`: the total column is shown first; "Add row" with every axis at its default adds it |
| 3 | Carrying amount was not derived | stale carrying values (e.g. a copied previous-year depreciation) failed SR-L1380-1 | `derived.js`: carrying = gross − accumulated (MCA SR-L1364-2/1380-1/1484-2/1504-1), for every movement row (480/480 triples in both golden instances) — calculated, read-only |
| 4 | Closing balance was not derived | closings missing | current-year closing = opening (previous-year closing, GR-7) + net change, for the 9 roll-forwards the taxonomy presents (not cash-flow cash, not the directors'-report shareholding) — calculated, read-only |
| 5 | Removing a table column deleted every fact with the same member combination in the whole filing | another table's column (e.g. borrowings long-term) could be deleted with a provisions column | `Session.sliceFacts` — only the table's own line items; the total column keeps statement figures |
| 6 | A table showed columns of another table whose axes are a subset (share-class columns inside the >5 % shareholders table) | values typed there belonged to the wrong table (ML-2) | `tableSlices` keeps a column only if its facts belong to the table (`tablesForFact`, as the rule engine) |
| 7 | "Current year only" import + moving the dates to prepare the next year kept `yearMode='current'` and last year's opening balances as previous-year *opening* facts | GR-1 "parent not entered" at the previous-year opening date | new import mode **Next year's filing** (the filed current year becomes the previous year; periods set; cash-flow method kept; GR-12 elements not carried; no previous-year opening facts, as in INFOBAHN); `setMeta` resets `yearMode`; Validation offers **Remove previous-year opening values** |

New explicit actions (each shows what it will change and asks first): **Recalculate current year** (re-derives every
calculated cell of the current year — totals, carrying amounts, closings — previous-year figures and manual overrides
untouched), **Fill empty totals** (per table and for all tables: empty total cells = sum of the part columns, only on the
axes the MCA rules add up, only in columns already in the table plus the total column when the other year reports it;
never overwrites). A statement figure that was entered or imported (e.g. Tangible assets on the balance sheet) is never
overwritten by a note's total — the note must agree and SR-L1364-2 / SR-L1381-2 / SR-L374-1 / SR-L555-1 report a
difference at the note.

## Run

```
npm install
pip install -r requirements.txt   # Arelle — offline XSD / XBRL 2.1 / Dimensions validator used by tests and release gate
npm run release                   # = compile → tests → build → release gate (below)
```

Pipeline (`npm run release`):

| Stage | Command | What it does |
|---|---|---|
| authority compile | `npm run compile` | unpacks the taxonomy zip to `.taxonomy/`, reads the rule workbook, writes `MCA_AUTHORITY.json` + `BUSINESS_RULE_COVERAGE.json`, prints the corpus report |
| unit tests | `npm run test:unit` | taxonomy, dimensions, typed members, rule corpus, every rule family (rule-by-rule positive/negative), calculations, scaling/decimals/units, applicability, rich text, import year modes |
| internal gate tests | `npm run test:gate` | importer/generator/gate, [200500] release regression |
| XML generation → XSD | `npm run test:xsd` | generated instances validated by Arelle (XML Schema + XBRL 2.1 + XBRL Dimensions), offline |
| golden regression | `npm run test:golden` | `golden-*.xml` import → model → regenerate → re-import → semantic compare; PDF cross-check |
| production build | `npm run build` | `index.html` (= `mca-ci-xbrl.html`), the single-file app with the compiled authority embedded |
| release gate | `node release-gate.mjs` | all of the above + build integrity + headless-browser UI regression; writes `RELEASE_REPORT.json` |

**Rule workbook:** the compiler reads the original MCA workbook `Final_Business_Rule_CI_Taxonomy_2016_V1.3.xls`
(14 sheets, read row by row, no export limit; sha256 `70faff6f5e33d5cf…`). "Specific rules for elements" has 567 rule rows
from [100100] Balance sheet to [400500] Secretarial audit report — not truncated. The older text export
`…V1.3.xls.txt` (truncated at 1000 rows) is kept only as a test fixture; a test proves it is an exact prefix of the workbook.

**Rule coverage** (`BUSINESS_RULE_COVERAGE.json`, one status per clause): EXECUTABLE 961, REVIEW_ONLY_EXTERNAL_DATA 49
(MCA21 master data, e-form, ICAI/ICSI databases, currency / ITC code lists — never auto-passed), NOT_APPLICABLE 153
(element not in the 2016 DTS, superseded duplicate sheets, permissive statements), UNIMPLEMENTED 1 (`ML-20-b`).

**Conditional tables:** "table is mandatory if …" is a requirement (the rule fails when the condition is true and the
table is empty). It disables the table only where the MCA text says "only if" and for the earlier [200100]–[200600]
table rules (incl. the [200500] current-investments regression). Evidence: the MCA-validated INFOBAHN instance reports
[201100] intangible-asset rows while `IntangibleAssets` is 0.

**XSD validation:** genuine schema validation runs through [Arelle](https://arelle.org) (`requirements.txt`),
fully offline (XBRL specification schemas from Arelle's bundled cache, MCA taxonomy from the local zip). If Arelle is
not installed the XSD tests are skipped with an explicit message and the release gate blocks.
It is not the MCA XBRL Validator V5.1 and does not run MCA business rules.

**Rich text:** every text-block (narrative) element is a rich-text editor (bold, italic, underline, numbered and
bulleted lists, indentation, line breaks, paste from Word/HTML). Content is stored in the Filing Manual HTML subset:
bold/italic/underline → `span.highlightedText1/2/3`, lists → `div.noteText1/2` with visible markers, indentation →
`div.noteText3`, headings → `p.headerN`; it converts back to the same formatting on load and import.
Tables follow the MCA Validator's HTML schema (evidence: MCA error file — `colgroup` and `colspan` rejected): only
`table/thead/tbody/tfoot/tr/td/th` and the `class` attribute. Pasted Word/Excel tables are rebuilt on a grid (col,
colgroup, caption dropped; merged cells become empty cells; `&nbsp;` padding before numbers and whitespace-only
paragraphs removed, as they widen columns until the MCA PDF cuts the table) and get `class="bordered"` (▦ toggles
borders). A filing-level option saves bold/italic/underline as plain text instead of `highlightedText1/2/3` (the MCA PDF
renders highlightedText as shaded text). Control characters XML does not allow are removed (vertical tab = line break)
and blocked by the gate.

**Build id:** the header shows `BUILD <id>` (content hash, `BUILD_INFO.json`), and every generated XML starts with
`<!-- Generated by C&I XBRL Studio build <id> -->`. A different id in an XML means it came from a cached old page
(Ctrl+F5).

**MCA error help:** paste the MCA Validator error list; each message (Xerces `cvc-…` codes, the "contained HTML"
messages) is explained with cause and fix, grouped, and linked to the element (`mca-errors.js`). Explanation only — no
validation.

**Workbench behaviour** (one applicability decision — `Applicability.cellStatus` / `planFacts` — drives the UI, import,
validation and generation):
* **Text blocks** show a *Text Block* button; the editor opens in a popup (Save Text / Cancel). Storage is unchanged.
* **Import** keeps a fact only if its cell is applicable (previous year of a GR-12 ELR, the cash-flow statement not
  selected, a field under a "No" answer, a table whose condition is not met). Others are listed in the import report
  and never become filing data.
* **Cash flow method** (`TypeOfCashFlowStatement`) is chosen in *Disclosure of General Information about Company*; on
  import it is read from the XML, else detected from which statement the facts belong to, else asked.
* **Yes/No dependencies** are compiled from the MCA conditional rules (`booleanDependencies` in the authority model).
  Changing Yes → No asks first; values are kept but excluded.
* **Calculated cells** (parents in the tab's own calculation network; carrying amounts = gross − accumulated; current-year
  closing balances = opening + changes — `derived.js`) are auto-populated and read-only; each tab has
  an *Allow editing of calculated cells* option. Overridden values are kept and checked by GR-1.
* **Mandatory marks** (`mandatory-marks.js`, display only): rows show a *Mandatory* label (red: always; blue: because its
  condition is currently met) and mandatory cells a red edge, filled pink while empty. Read from the compiled business
  rules (mandatory, conditional mandatory, Mandatory Line Items per table row, member-specific); rules recorded as
  warnings in `golden-DIVERGENCES.json` are not marked. Nothing in the filing, validation or XML changes.
* **Validation** results carry a location (tab, table, cell = fact key); clicking one opens the tab and focuses the
  cell (errors red, warnings dashed). *Validate current tab* runs the same engine on the tab's facts and rules and
  marks cross-tab checks; XML generation always validates the entire filing.

**Usability (display only — no filing semantics):** column headings and the row-label column stay in view (the grid
scrolls in its own box); alternate-row shading and row highlight on hover/focus; Enter / Shift+Enter (and ↑/↓ in text
cells) move to the same column of the next/previous editable row; Ctrl+S saves in the browser now (the bar shows
*Saved hh:mm*); grid cells have accessible names (row — column), `aria-required` for mandatory marks and `aria-invalid`
for cells with errors; dialogs keep Tab inside, start on Cancel and return focus; *New filing* and removing a table row
that holds values ask first; a text block button shows ⚠ and its issue count after validation, and the editor lists
that text block's issues (last validation + the gate's HTML check of the stored value).

**Totals and parts on dimensional tables** (`member-hints.js` hints are display only; `totals-fill.js` "Fill empty totals" is an explicit action — tool guidance, not MCA rules; nothing in
the filing, validation or XML changes): the member pickers mark totals ("— total") and explain where a member sits
(part of … › …) and whether GR-3 needs its parent column; column headings show **TOTAL** / *part of …*; columns are shown
in taxonomy order (each total before its parts; *As entered* available); a part column whose GR-3 parent column is
missing offers **Add** (the decision is the rule engine's own `gr3RequiredParent`); under each total cell a line shows
*= parts ✓* or the parts total and the difference, with **Use parts total** (entered through the normal cell entry).
Sums are checked only on axes the MCA business rules themselves add up (`sumAxis` in the compiled rules: borrowings,
tangible/intangible asset classes, investments, …), only for amounts and share counts, rounded like XBRL Calculations
1.1. Leaving a table (or Validate / Generate) while totals differ asks *Stay and fix* / *Continue anyway*; Validation
lists them under **Totals hints**, separate from errors and warnings. Both MCA-validated filings: 0 hints, 0 missing
parent columns (several hundred totals compared).

**Copy from previous year** (`carry-forward.js`, current-year tables): adds the previous-year columns (member
combinations) through the normal *Add row* check and, if ticked, copies previous-year values into **empty** current-year
cells through the normal cell entry (applicability, dimensions, decimals, recalculation). Never overwrites; opening-balance
rows (same fact as the previous-year closing, GR-7), closing-balance rows (this year's opening + changes), statement figures
in a total column and calculated cells are not copied.

**Footnotes** (`footnotes.js`, *Footnotes* tab): select a cell with a value on any tab and press **Alt+N** (or *Footnote…*
in the tab tools) to add a footnote, or a new one reusing an existing footnote's text (one footnote per cell, as in
the MCA-validated INFOBAHN and GE Power instances); cells with footnotes show an *fn* mark. The tab lists every
footnote with its cells (Go / remove), edits its text and deletes it. Stored in the filing's existing footnote store and
written by the existing generator as an XBRL footnote link (`xml:lang="en"`, fact-footnote arcs) for generated cells only.
The preview shows them as the MCA PDFs do: "(A) value" in the cell, letters in reading order per table block, and a
"Footnotes" list after the block (INFOBAHN: (A) 38.52 / (B) -32.69 → (A) Grtuity, (B) Dividend Income).

**Preview PDF** (`pdf-preview.js`, Generate XML tab): opens a printable preview of the facts the XML contains
(Print → Save as PDF; or download it as .html). It imitates the general layout of the MCA validator's PDF — company and
period heading, one section per statement/note, "Unless otherwise specified …", current/previous year, dimensional tables
in blocks of columns "..(n)" with axis/member headings, Indian digit grouping, text blocks as "Textual information (n)"
with the MCA classes styled — and is labelled **not the MCA rendering** on every page. INFOBAHN: same 37 statements/notes
as the MCA PDF and every balance-sheet value of the MCA PDF appears. The official PDF comes only from the MCA validator.

**Import:** choosing an XML opens a preview with the current/previous-year split (from the context dates). Choose
**Both years**, **Current year only** or **Next year's filing** before anything is imported; the import report states
what was imported. *Next year's filing* prepares the following year from a filed instance: its current-year facts become the
previous-year column (fact dates unchanged), the reporting periods are set to the next year, the cash-flow method is kept,
elements that do not apply to a previous year (GR-12) are listed as not applicable, and its own previous year and opening
balances are not imported (INFOBAHN golden: 1,308 facts carried, 0 differences).
*Current year only* imports the current-period facts plus the current-year **opening balances**: instant facts at the
previous-year end of the concepts the taxonomy presents with an opening-balance (periodStart) row — share capital,
reserves, tangible/intangible assets, cash, … MCA generic rule GR-7 ("there is a common element for specifying the opening
and closing balance … the Opening balance of current year be shown as the closing balance of previous year") makes that
one XBRL fact, so those items also show it as their previous-year closing. Every other previous-year fact (P&L and cash-flow
durations, balance-sheet comparatives, PY opening instants) is not imported (golden: 77 opening balances carried,
1,231 previous-year facts skipped).

Generated files (`.taxonomy/`, `MCA_AUTHORITY.json`, `BUSINESS_RULE_COVERAGE.json`, `artifact.html`,
`BUILD_INFO.json`, `RELEASE_REPORT.json`) are git-ignored. `index.html` / `mca-ci-xbrl.html` are committed (GitHub Pages).

## Files

| Role | Files |
|---|---|
| MCA authority inputs | `Final_C_and_I_Taxonomy_2016_V1.2.zip`, `Final_Business_Rule_CI_Taxonomy_2016_V1.3.xls` (complete rule workbook), `Annexure_II_Main_Taxonomy_V2.xls.txt`, `Filing_Manual_CNI_V4.0.pdf`; `Final_Business_Rule_C_I_Taxonomy_2016_V1.3.xls.txt` (old truncated export, test fixture only) |
| Golden (MCA-validated) | `golden-INFOBAHN_2024-25.xml`, `golden-INFOBAHN_2024-25.pdf`, `golden-CHARVAK_2024-25.xml`, `golden-DIVERGENCES.json` |
| Authority compiler | `compile.mjs`, `taxonomy-source.mjs`, `dts.mjs`, `tables.mjs`, `rules-source.mjs`, `rule-formalizer.mjs` |
| Runtime engines | `authority.js` (taxonomy), `dimensions.js` (dimension + hypercube), `calculation.js`, `rules.js` (business rules), `expr.js`, `applicability.js`, `model.js` (filing state), `periods.js`, `scaling.js`, `units.js`, `decimal.js`, `importer.js`, `generator.js` (only XML generator), `gate.js` (internal validation), `views.js` (table engine), `session.js` (controller), `derived.js` (carrying amount / closing balance derivations) |
| UI | `app.js`, `richtext.js`, `mandatory-marks.js`, `member-hints.js`, `totals-fill.js`, `carry-forward.js`, `footnotes.js`, `pdf-preview.js`, `mca-errors.js`, `example.js`, `shell.html`, `styles.css` |
| Build / release | `build.mjs`, `release-gate.mjs`, `xsd-validate.mjs`, `browser-smoke.mjs`, `requirements.txt`, `APPROVED_LIMITATIONS.json` |
| Assurance | `assurance.mjs` (re-key / mistakes / locked-cell harness), `assurance.test.mjs` |
| Tests | `*.test.mjs` (incl. `workbench.test.mjs`, `audit-charvak.test.mjs`, `mca-html.test.mjs`, `member-hints.test.mjs`, `carry-forward.test.mjs`, `footnotes.test.mjs`, `pdf-preview.test.mjs`, `audit-v11.test.mjs`), `helpers.mjs`, `fixtures.mjs` |

## Status semantics

* **Internal gate** (in app): structure, contexts, units, decimals, dimensions/hypercubes, calculations,
  executable MCA rules. Generation is blocked on any error.
* **Official MCA validation**: always shown as *not run*. Only the MCA XBRL Validator V5.1 can change that.

## Known limitations (release gate BLOCKED until resolved or approved in `APPROVED_LIMITATIONS.json`)

1. **`ML-20-b` UNIMPLEMENTED** — Mandatory Line Items row 20: "In OutstandingBalancesForRelatedPartyTransactionsAbstract-
   Element for amount shall be mandatory for various transactions" does not identify the required elements (identical in
   both ML sheets of the complete workbook; no specific rule for that abstract). Needs MCA clarification. If the release
   owner approves it, it is shown as **APPROVED LIMITATION / NOT EXECUTED** and never as a PASS.
2. `golden-DIVERGENCES.json` records evidence from the validated INFOBAHN and CHARVAK instances: the V3 schemaRef is
   accepted; CH-4/5/6, SR-L3996-1/3997-1/3998-1 (main product/service from FY 2018-19), SR-L2537-2 (NumberOfSubsidiaryCompanies
   > 0 with "No" subsidiaries) and SR-L2116-1 (KMP remuneration; rule text quotes a value not in the enumeration) report as warnings.
3. Rules corrected from CHARVAK evidence (`audit-charvak.test.mjs`): calculations use XBRL Calculations 1.1 round-to-nearest;
   GR-4 sequence check applies to taxonomy members, not typed identifiers; GR-6 does not pair dimensional rows member by member;
   ML-20 accepts Key Management Personnel transactions; shareholding % sums allow the rounding of the reported decimals.
4. Rules needing data outside the instance are `REVIEW_ONLY_EXTERNAL_DATA` (manual review, never auto-passed).
5. Official MCA XBRL Validator V5.1: **NOT RUN**. GitHub Pages smoke test of the deployed site: **NOT RUN** from the build
   environment (the site is not reachable from it); `browser-smoke.mjs` runs the same checks against the built `index.html`.
