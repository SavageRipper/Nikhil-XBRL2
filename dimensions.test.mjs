// Suites: explicit dimensions, typed dimensions (syntax), hypercube validity, all/notAll/default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, q, newSession } from './helpers.mjs';
import { checkDimensionSyntax, dimensionallyValid } from './dimensions.js';
import { DimensionError } from './session.js';

const A = authority();
const TA = { classes: q('ClassesOfTangibleAssetsAxis'), sub: q('SubClassesOfTangibleAssetsAxis'), carry: q('CarryingAmountAccumulatedDepreciationAndGrossCarryingAmountAxis') };

test('explicit: valid member accepted; unknown/foreign/default/unusable rejected', () => {
  assert.deepEqual(checkDimensionSyntax(A, [{ axis: TA.classes, member: q('LandMember') }]), []);
  const codes = (dims) => checkDimensionSyntax(A, dims).map((e) => e.code);
  assert.ok(codes([{ axis: q('ClassesOfTangibleAssetsAxis'), member: q('GoodwillMember') }]).includes('dim.memberNotInDomain'));
  assert.ok(codes([{ axis: TA.classes, member: q('CompanyTotalTangibleAssetsMember') }]).includes('dim.defaultReported'));
  // a member declared usable="false" in every hypercube that uses it
  let unusable = null;
  for (const hc of Object.values(A.json.hypercubes)) for (const ax of hc.axes) for (const m of ax.members || []) {
    if (!m.usable && !A.axisInfo(ax.axis).members.get(m.member).usable) unusable ||= { axis: ax.axis, member: m.member };
  }
  assert.ok(unusable, 'taxonomy has an unusable member');
  assert.ok(codes([unusable]).includes('dim.memberNotUsable'));
  // the unusable domain of the time-period axis is also its default
  assert.ok(codes([{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('ClassificationBasedOnTimePeriodMember') }]).includes('dim.defaultReported'));
  assert.ok(codes([{ axis: TA.classes, member: q('LandMember') }, { axis: TA.classes, member: q('BuildingsMember') }]).includes('dim.duplicateAxis'));
  assert.ok(codes([{ axis: 'in-gaap:NoSuchAxis', member: q('LandMember') }]).includes('dim.unknownAxis'));
});

test('typed: typed axis needs a non-empty typed value, never an explicit member', () => {
  const ax = q('CategoriesOfRelatedPartiesAxis');
  assert.equal(A.concept(ax).kind, 'typedAxis');
  assert.deepEqual(checkDimensionSyntax(A, [{ axis: ax, typed: 'RelatedParty1' }]), []);
  assert.ok(checkDimensionSyntax(A, [{ axis: ax, typed: '  ' }]).some((e) => e.code === 'dim.emptyTyped'));
  assert.ok(checkDimensionSyntax(A, [{ axis: ax, member: q('LandMember') }]).some((e) => e.code === 'dim.typedAsExplicit'));
  assert.ok(checkDimensionSyntax(A, [{ axis: TA.classes, typed: 'x' }]).some((e) => e.code === 'dim.explicitAsTyped'));
});

test('hypercube: closed "all" table accepts its axes, rejects foreign axis; defaults fill absent axes', () => {
  const ok = dimensionallyValid(A, q('TangibleAssets'), [{ axis: TA.classes, member: q('LandMember') }]);
  assert.equal(ok.valid, true, ok.reason);
  const foreign = dimensionallyValid(A, q('TangibleAssets'), [{ axis: TA.classes, member: q('LandMember') }, { axis: q('ClassificationOfBorrowingsAxis'), member: q('TermLoansMember') }]);
  assert.equal(foreign.valid, false);
  // non-dimensional item with dimensions (Filing Manual #35)
  assert.equal(dimensionallyValid(A, q('RevenueFromOperations'), [{ axis: TA.classes, member: q('LandMember') }]).valid, false);
  assert.equal(dimensionallyValid(A, q('RevenueFromOperations'), []).valid, true);
});

test('notAll: NatureOfOtherTangibleAssets excluded on member combinations listed in the not-all ELR', () => {
  const t = A.table('201000:DisclosureOfTangibleAssetsTable');
  const na = t.notAll.find((n) => n.primary === q('NatureOfOtherTangibleAssets'));
  const classesNA = na.axes.find((a) => a.axis === TA.classes).members;
  const excludedClass = classesNA.find((m) => m !== A.dimensionDefault(TA.classes));
  const allowedClass = t.axes.find((a) => a.axis === TA.classes).members.map((m) => m.member).find((m) => !classesNA.includes(m) && m !== A.dimensionDefault(TA.classes));
  assert.ok(allowedClass, 'some class member is outside the notAll domain');
  const bad = dimensionallyValid(A, q('NatureOfOtherTangibleAssets'), [{ axis: TA.classes, member: excludedClass }]);
  assert.equal(bad.valid, false);
  assert.match(bad.reason, /notAll/);
  const good = dimensionallyValid(A, q('NatureOfOtherTangibleAssets'), [{ axis: TA.classes, member: allowedClass }]);
  assert.equal(good.valid, true, good.reason);
});

test('controller rejects dimensionally invalid writes (authoritative layer, not UI)', () => {
  const s = newSession();
  s.setValue(q('LongTermBorrowings'), 'CY', '500');
  const id = '200300:ClassificationOfBorrowingsTable';
  assert.throws(() => s.setTableValue(id, 'CY', [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('ClassificationBasedOnTimePeriodMember') }], q('Borrowings'), '1'), DimensionError);
  assert.throws(() => s.setTableValue(id, 'CY', [{ axis: TA.classes, member: q('LandMember') }], q('Borrowings'), '1'), DimensionError);
  // the table's total column (every axis at its default) is reported WITHOUT dimensions, as the MCA-validated
  // INFOBAHN instance reports e.g. ValueOfSharesAuthorised / Reserves / ChangesInTangibleAssets (context ICur/DCur);
  // a table whose axes have no default (typed related-party axis) has no total column
  const tot = s.setTableValue(id, 'CY', [], q('Borrowings'), '1');
  assert.equal(tot.dims.length, 0);
  assert.throws(() => s.validateSlice('201600:DisclosureOfRelationshipAndTransactionsBetweenRelatedPartiesTable', []), DimensionError);
  const f = s.setTableValue(id, 'CY', [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('LongTermMember') }, { axis: q('ClassificationOfBorrowingsAxis'), member: q('TermLoansFromBanksMember') }], q('Borrowings'), '500');
  assert.equal(f.dims.length, 2);
});
