import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider } from '../provider/server.mjs';
import { Archive } from '../src/archive.mjs';
import {
  collectOfferObservations,
  requoteObservation,
  validateSearch,
  validateDetail,
  SourceError,
  findOfferReceipt,
} from '../src/source.mjs';
import { buildReview } from '../src/review.mjs';

async function harness(context) {
  const directory = await mkdtemp(join(tmpdir(), 'auto-'));
  const provider = createProvider(); provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  context.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${provider.address().port}`;
  const archive = await new Archive(directory).initialize();
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, archive, control };
}
const query = { from: 'HAK', to: 'SHA' };

test('自动领取把整组航段与报价作用域作为整体留档', async context => {
  const { base, archive } = await harness(context);
  const result = await collectOfferObservations(archive, base, query);
  assert.equal(result.offerCount, 1);
  assert.equal(result.observations[0].pricingStatus, 'priced');
  const [record] = await archive.list();
  assert.equal(record.source, 'source');
  const data = record.versions[0].data;
  assert.deepEqual(data.offer.segmentRefs, ['seg-a', 'seg-b']);
  assert.deepEqual(data.offer.travelerRefs, ['adult-1']);
  // 原始 search 与 detail 字节分别入 blob，可独立核对
  assert.match(data.search.rawSha256, /^[0-9a-f]{64}$/);
  assert.match(data.pricing.rawSha256, /^[0-9a-f]{64}$/);
  const searchRaw = JSON.parse((await archive.bytes(data.search.rawSha256)).toString());
  assert.equal(searchRaw.searchId, data.searchId);
  const detailRaw = JSON.parse((await archive.bytes(data.pricing.rawSha256)).toString());
  assert.equal(detailRaw.offerId, data.offerId);
  // 计价组件只能引用本报价作用域内的航段和乘客
  const component = data.pricing.fareComponents[0];
  assert.deepEqual(component.segments, ['seg-a', 'seg-b']);
  assert.equal(component.travelerRef, 'adult-1');
  assert.equal(data.pricing.totalAmount, '1250.00');
  assert.equal(data.pricing.currency, 'CNY');
  assert.deepEqual(data.pricing.taxIncluded, [null]);
  assert.deepEqual(data.pricing.conditions, { refundable: false });
  assert.equal(data.lineage.relation, 'initial');
});

test('引用本次查询之外航段的报价被拒绝，无法拼接组合', () => {
  const payload = {
    searchId: 's1', expiresAt: '2099-01-01T00:00:00Z',
    journeys: [{ segmentId: 'seg-a', flight: 'EX101', from: 'HAK', to: 'MID' }],
    offers: [{ offerId: 'o1', segmentRefs: ['seg-a', 'seg-ghost'], travelerRefs: ['adult-1'], detailToken: 't1' }],
  };
  assert.throws(() => validateSearch(payload), /本次查询之外的航段/);
});

test('详情凭据越权或计价越出报价作用域被拒绝', () => {
  const offer = { offerId: 'o1', segmentRefs: ['seg-a'], travelerRefs: ['adult-1'], detailToken: 't1' };
  assert.throws(() => validateDetail({ searchId: 'other', offerId: 'o1', detailToken: 't1', fareComponents: [] }, { searchId: 's1', ...offer }), /searchId/);
  assert.throws(() => validateDetail(
    { searchId: 's1', offerId: 'o1', detailToken: 't1', fareComponents: [{ travelerRef: 'stranger', segments: ['seg-a'], amount: '1.00', currency: 'CNY', taxIncluded: null }] },
    { searchId: 's1', ...offer },
  ), /作用域之外的乘客/);
  assert.throws(() => validateDetail(
    { searchId: 's1', offerId: 'o1', detailToken: 't1', fareComponents: [{ travelerRef: 'adult-1', segments: ['seg-x'], amount: '1.00', currency: 'CNY', taxIncluded: null }] },
    { searchId: 's1', ...offer },
  ), /作用域之外的航段/);
  assert.throws(() => validateDetail(
    { searchId: 's1', offerId: 'o1', detailToken: 't1', fareComponents: [{ travelerRef: 'adult-1', segments: ['seg-a'], amount: '12.5', currency: 'CNY', taxIncluded: 'maybe' }] },
    { searchId: 's1', ...offer },
  ), /三态/);
  assert.throws(() => validateDetail(
    { searchId: 's1', offerId: 'o1', detailToken: 't1', fareComponents: [] },
    { searchId: 's1', ...offer },
  ), /fareComponents/);
});

test('凭据过期时保留待补取观察而不编造价格', async context => {
  const { base, archive, control } = await harness(context);
  await control({ expired: true });
  const result = await collectOfferObservations(archive, base, query);
  assert.equal(result.observations[0].pricingStatus, 'expired');
  const [record] = await archive.list();
  const data = record.versions[0].data;
  assert.equal(data.pricing.status, 'expired');
  assert.equal(data.pricing.fareComponents, null);
  assert.equal(data.pricing.totalAmount, null);
  assert.equal(data.pricing.currency, null);
  // 过期响应的原始字节仍留档
  const expiredRaw = JSON.parse((await archive.bytes(data.pricing.rawSha256)).toString());
  assert.equal(expiredRaw.error, '报价已过期');
});

test('重查得到替代方案时保留两次观察的关系而不覆盖原价', async context => {
  const { base, archive, control } = await harness(context);
  const first = await collectOfferObservations(archive, base, query);
  const firstOfferId = first.observations[0].identity.offer;
  await control({ revision: 2 });
  const second = await requoteObservation(archive, base, firstOfferId);
  assert.equal(second.replacedOfferId, firstOfferId);
  assert.equal(second.lineage.relation, 'replacement');
  assert.equal(second.lineage.predecessor.offerId, firstOfferId);
  // 两个业务身份各自留档，原观察内容原样保留
  const records = await archive.list();
  assert.equal(records.length, 2);
  const original = await findOfferReceipt(archive, firstOfferId);
  assert.equal(original.version.data.pricing.totalAmount, '1250.00');
  const replacement = records.flatMap(r => r.versions).find(v => v.data.offerId === second.identity.offer).data;
  assert.equal(replacement.pricing.totalAmount, '1300.00');
  assert.equal(replacement.search.journeys[0].to, 'ALT');
  assert.equal(original.version.data.search.journeys[0].to, 'MID');
});

test('审批视图标出披露、待补取与币种含税口径变化', async context => {
  const { base, archive, control } = await harness(context);
  const first = await collectOfferObservations(archive, base, query);
  const firstOfferId = first.observations[0].identity.offer;
  await control({ revision: 2, currency: 'USD', taxKnown: true });
  await requoteObservation(archive, base, firstOfferId);
  const review = await buildReview(archive);
  assert.equal(review.observationCount, 2);
  assert.equal(review.supersededCount, 1);
  const original = review.offers.find(item => item.offerId === firstOfferId);
  assert.equal(original.superseded, true);
  assert.equal(original.disclosure.priceClaimed, true);
  assert.equal(original.disclosure.taxBasisDisclosed, false);
  assert.ok(original.disclosure.pending.some(text => text.includes('含税口径')));
  const replacement = review.offers.find(item => item.offerId !== firstOfferId);
  assert.equal(replacement.disclosure.taxBasisDisclosed, true);
  assert.deepEqual(replacement.pricing.taxIncluded, [true]);
  const changes = replacement.changesFromPredecessor;
  assert.equal(changes.currency.before, 'CNY');
  assert.equal(changes.currency.after, 'USD');
  assert.equal(changes.currency.changed, true);
  assert.equal(changes.taxBasis.changed, true);
  assert.equal(changes.segments.changed, true);
  assert.equal(changes.totalAmount.before, '1250.00');
  assert.equal(changes.totalAmount.after, '1300.00');
});

test('conditions 缺失时在审批视图标记待补取', async context => {
  const { base, archive, control } = await harness(context);
  await control({ conditionsMissing: true });
  await collectOfferObservations(archive, base, query);
  const review = await buildReview(archive);
  assert.equal(review.offers[0].disclosure.conditionsDisclosed, false);
  assert.ok(review.offers[0].disclosure.pending.some(text => text.includes('计价条件')));
  assert.equal(review.offers[0].pricing.conditions, null);
});

test('重复领取相同观察复用版本，不产生伪造的新报价', async context => {
  const { base, archive } = await harness(context);
  const first = await collectOfferObservations(archive, base, query);
  const second = await collectOfferObservations(archive, base, query);
  assert.equal(second.observations[0].duplicate, true);
  assert.equal(second.observations[0].version, first.observations[0].version);
  const [record] = await archive.list();
  assert.equal(record.versions.length, 1);
});

test('来源异常以 SourceError 上报，不写入半成品', async context => {
  const { base, archive } = await harness(context);
  await assert.rejects(() => collectOfferObservations(archive, base, { from: 'HAK' }), error => error instanceof SourceError);
  assert.deepEqual(await archive.list(), []);
});
