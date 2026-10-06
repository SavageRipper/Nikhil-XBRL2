// Deterministic test filings built only through the Session controller.
import { newSession, q, authority } from './helpers.mjs';

import { completeMandatory, sampleValue } from './example.js';
export const placeholder = (A, c) => sampleValue(A, c);

// Every unconditionally mandatory element (CY and PY where applicable) and one complete member in
// every unconditionally mandatory table — the same completion the in-app example uses.
export function baseSession(meta = {}) {
  return completeMandatory(newSession(meta), { name: 'Test Co' });
}

const set = (s, local, cy, py) => { s.setValue(q(local), 'CY', String(cy)); if (py != null) s.setValue(q(local), 'PY', String(py)); };

// Balanced balance sheet whose only assets are current investments, funded by short-term borrowings? No —
// funded by trade payables to keep note tables minimal.
export function withCurrentInvestments(s, cy = 1000, py = 800) {
  set(s, 'CurrentInvestments', cy, py);
  set(s, 'CurrentAssets', cy, py);
  set(s, 'Assets', cy, py);
  set(s, 'TradePayables', cy, py);
  set(s, 'CurrentLiabilities', cy, py);
  set(s, 'EquityAndLiabilities', cy, py);
  set(s, 'AggregateAmountOfQuotedCurrentInvestments', 0, 0);
  set(s, 'AggregateAmountOfUnquotedCurrentInvestments', cy, py);
  set(s, 'AggregateProvisionForDiminutionInValueOfCurrentInvestments', 0, 0);
  return s;
}

export const CI_TABLE = '200500:DetailsOfCurrentInvestmentsTable';
// one typed row per scope in the current-investments table, consistent with the BS total
export function currentInvestmentRows(s, rows = { CY: [['1', 1000]], PY: [['1', 800]] }) {
  const A = authority();
  const axis = q('ClassificationOfCurrentInvestmentsAxis');
  for (const [scope, list] of Object.entries(rows)) {
    for (const [member, amount] of list) {
      const dims = [{ axis, typed: member }];
      const put = (local, v) => s.setTableValue(CI_TABLE, scope, dims, q(local), v);
      put('TypeOfCurrentInvestments', A.enumerations(q('TypeOfCurrentInvestments'))[0]);
      put('ClassOfCurrentInvestments', A.enumerations(q('ClassOfCurrentInvestments'))[0]);
      put('CurrentInvestments', String(amount));
      put('BasisOfValuationOfCurrentInvestments', 'Lower of cost and fair value');
      put('NameOfBodyCorporateInWhomInvestmentHasBeenMade', 'Alpha Mutual Fund');
    }
  }
  return s;
}

export function validCurrentInvestmentsSession(meta) {
  return currentInvestmentRows(withCurrentInvestments(baseSession(meta)));
}

// Id of the MCA rule that makes the [200500] current-investments table mandatory (rule ids carry the
// source row of the rule workbook, so they are looked up, never hard-coded).
export function ciTableRuleId() {
  const r = authority().rules.rules.find((x) => x.status === 'EXECUTABLE' && x.ast?.type === 'tableRequired' && x.ast.tables.includes(CI_TABLE));
  if (!r) throw new Error('no table rule for ' + CI_TABLE);
  return r.id;
}

// Related-party table is applicable only when "WhetherThereAreAnyRelatedPartyTransactionsDuringYear" is Yes
// (MCA rule on DisclosureOfRelationshipAndTransactionsBetweenRelatedPartiesTable).
export function enableRelatedParties(s) {
  for (const scope of s.filing.meta.firstFinancialYear ? ['CY'] : ['CY', 'PY']) s.setValue(q('WhetherThereAreAnyRelatedPartyTransactionsDuringYear'), scope, 'true');
  return s;
}
