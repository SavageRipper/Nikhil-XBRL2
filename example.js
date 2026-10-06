// Example filing shown on first open (clearly marked as example data in the UI).
// Built only through the Session controller, so it obeys every applicability and dimension rule.
// Deterministic sample values that satisfy the format / ordering rules of the MCA corpus
// (signing dates after the board meeting, distinct valid PANs, INR, ...).
const DATES = {
  DateOfBoardMeetingWhenFinalAccountsWereApproved: '2017-05-10',
  DateOfSigningOfFinancialStatementsByDirector: '2017-05-10',
  DateOfSigningOfFinancialStatementsByCompanySecretary: '2017-05-10',
  DateOfSigningOfFinancialStatementsByChiefFinancialOfficer: '2017-05-10',
  DateOfSigningOfFinancialStatementsByManager: '2017-05-10',
  DateOfSigningOfBalanceSheetByAuditors: '2017-05-12',
  DateOfSigningAuditReportByAuditors: '2017-05-12',
  DateOfBoardOfDirectorsMeetingInWhichBoardReportReferredToUnderSection134WasApproved: '2017-05-10',
  DateOfSigningBoardReport: '2017-05-10',
  DateOfBirthOfKeyManagerialPersonnelOrDirector: '1970-01-01',
};
const STRINGS = { PermanentAccountNumberOfEntity: 'AAACE1234A', TypeOfIndustry: 'Commercial and Industrial', DescriptionOfPresentationCurrency: 'INR', SRNOfFormADT1: 'Z99999999' };

export function sampleValue(A, c, seq = { pan: 0 }) {
  const local = A.concept(c).name;
  const t = A.dataType(c);
  if (A.isNumeric(c)) return '0';
  if (t === 'boolean') return 'false';
  if (DATES[local]) return DATES[local];
  if (STRINGS[local]) return STRINGS[local];
  const en = A.enumerations(c);
  if (en && en.length) return en[0];
  if (t === 'date') return '2017-05-10';
  if (/^(PermanentAccountNumber|PAN)/.test(local)) return `ABCDE${String(1000 + (++seq.pan % 9000))}F`;
  if (/DirectorIdentificationNumber/.test(local)) return '00012345';
  if (/^CIN/.test(local)) return 'U72200KA2010PTC654321';
  if (/^Country/.test(local)) return 'INDIA';
  if (t === 'textBlock') return 'Nil';
  return 'Sample';
}

// Every unconditionally mandatory element (and report-type mandatory element of this report type) for
// CY and PY where applicable, and one complete member in every unconditionally mandatory (typed) table.
export function completeMandatory(S, { name = 'Sample' } = {}) {
  const A = S.A;
  const q = (l) => A.qnameOfLocal(l);
  const seq = { pan: 0 };
  const meta = S.filing.meta;
  const scopes = meta.firstFinancialYear ? ['CY'] : ['CY', 'PY'];
  if (!S.getValue(q('NameOfCompany'), 'CY')) S.setValue(q('NameOfCompany'), 'CY', name);
  if (!S.getValue(q('TypeOfCashFlowStatement'), 'CY')) S.setValue(q('TypeOfCashFlowStatement'), 'CY', 'Indirect Method');
  for (const r of A.rules.rules) {
    if (r.status !== 'EXECUTABLE' || r.ast?.type !== 'mandatory') continue;
    if (r.ast.when && !(r.ast.when.op === 'reportType' && r.ast.when.value === meta.reportType)) continue;
    const c = r.ast.concept;
    if (A.conceptHypercubes?.[c]?.length) continue; // dimensional: filled through its table below
    for (const scope of r.scope?.periods || ['CY', 'PY']) {
      if (!scopes.includes(scope) || !S.conceptStatus(c, scope).applicable || S.getValue(c, scope)) continue;
      S.setValue(c, scope, sampleValue(A, c, seq));
    }
  }
  if (meta.reportType === 'Standalone') for (const scope of scopes) S.setValue(q('WhetherMoneyRaisedFromPublicOfferingDuringYear'), scope, 'false');
  for (const r of A.rules.rules) {
    if (r.status !== 'EXECUTABLE' || r.ast?.type !== 'tableRequired' || r.ast.when) continue;
    for (const id of r.ast.tables) {
      const t = A.table(id);
      if (!t.axes.every((x) => x.typed)) continue;
      for (const scope of scopes) {
        if (!S.tableStatus(id, scope).applicable) continue;
        const dims = t.axes.map((x) => ({ axis: x.axis, typed: '1' }));
        for (const c of t.lineItems) {
          if (A.concept(c).abstract || !S.conceptStatus(c, scope).applicable) continue;
          S.setTableValue(id, scope, dims, c, sampleValue(A, c, seq));
        }
      }
    }
  }
  return S;
}

export function buildExample(S) {
  const A = S.A;
  const q = (l) => A.qnameOfLocal(l);
  S.setMeta({ name: 'Example Pvt Ltd (sample data)', cin: 'U72200KA2010PTC123456', reportType: 'Standalone', level: 'Actual', displayPlaces: 0,
    periods: { cy: { start: '2016-04-01', end: '2017-03-31' }, py: { start: '2015-04-01', end: '2016-03-31' } } });
  S.setValue(q('NameOfCompany'), 'CY', 'Example Pvt Ltd');
  completeMandatory(S, { name: 'Example Pvt Ltd' });
  const bs = { CurrentInvestments: [250000, 200000], CurrentAssets: [250000, 200000], Assets: [250000, 200000], TradePayables: [250000, 200000], CurrentLiabilities: [250000, 200000], EquityAndLiabilities: [250000, 200000],
    AggregateAmountOfQuotedCurrentInvestments: [0, 0], AggregateAmountOfUnquotedCurrentInvestments: [250000, 200000], AggregateProvisionForDiminutionInValueOfCurrentInvestments: [0, 0] };
  for (const [l, [cy, py]] of Object.entries(bs)) { S.setValue(q(l), 'CY', String(cy)); S.setValue(q(l), 'PY', String(py)); }
  const T = '200500:DetailsOfCurrentInvestmentsTable';
  const axis = q('ClassificationOfCurrentInvestmentsAxis');
  for (const [scope, amt] of [['CY', 250000], ['PY', 200000]]) {
    const dims = [{ axis, typed: 'CurrentInvestment1' }];
    S.setTableValue(T, scope, dims, q('TypeOfCurrentInvestments'), 'Investments in mutual funds');
    S.setTableValue(T, scope, dims, q('ClassOfCurrentInvestments'), A.enumerations(q('ClassOfCurrentInvestments'))[0]);
    S.setTableValue(T, scope, dims, q('CurrentInvestments'), String(amt));
    S.setTableValue(T, scope, dims, q('BasisOfValuationOfCurrentInvestments'), 'Lower of cost and fair value');
    S.setTableValue(T, scope, dims, q('NameOfBodyCorporateInWhomInvestmentHasBeenMade'), 'Sample Liquid Fund');
  }
}
