import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

async function stack(context) {
  const directory = await mkdtemp(join(tmpdir(), 'auto-http-'));
  const provider = createProvider(); provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const source = `http://127.0.0.1:${provider.address().port}`;
  const service = await createIntake(directory, { sourceBase: source }); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => {
    service.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => service.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value ?? {}) });
  return { base, control, post };
}

test('自动采集、审批视图与重查链路通过 HTTP 工作', async context => {
  const { base, control, post } = await stack(context);
  const health = await (await fetch(base + '/health')).json();
  assert.deepEqual(health.acquisition, ['manual', 'source']);

  const collected = await post('/api/collect', { from: 'HAK', to: 'SHA' });
  assert.equal(collected.status, 201);
  const collectedBody = await collected.json();
  assert.equal(collectedBody.offerCount, 1);
  const offerId = collectedBody.observations[0].identity.offer;

  const review = await (await fetch(base + '/api/review')).json();
  assert.equal(review.observationCount, 1);
  assert.equal(review.offers[0].pricing.status, 'priced');
  assert.equal(review.offers[0].disclosure.conditionsDisclosed, true);

  await control({ revision: 2, currency: 'USD', taxKnown: true });
  const requote = await post('/api/requote', { offerId });
  assert.equal(requote.status, 201);
  const requoteBody = await requote.json();
  assert.equal(requoteBody.replacedOfferId, offerId);

  const reviewAfter = await (await fetch(base + '/api/review')).json();
  assert.equal(reviewAfter.observationCount, 2);
  const replacement = reviewAfter.offers.find(item => item.offerId !== offerId);
  assert.equal(replacement.changesFromPredecessor.currency.changed, true);
  assert.equal(replacement.changesFromPredecessor.currency.after, 'USD');
  assert.equal(replacement.relation, 'replacement');

  // 人工与自动记录共存于同一归档但来源不混淆
  const manual = await post('/api/manual', { search: 'manual-search', offer: 'o1', segments: ['a-b', 'b-c'], amount: '1250.00', currency: 'CNY', taxIncluded: null });
  assert.equal(manual.status, 201);
  const records = await (await fetch(base + '/api/records')).json();
  assert.deepEqual([...new Set(records.map(record => record.source))].sort(), ['manual', 'source']);
});

test('采集请求校验与来源故障映射', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-http-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createIntake(directory, { sourceBase: 'http://127.0.0.1:9' });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value ?? {}) });

  const invalid = await post('/api/collect', { from: 'HA', to: 'SHA' });
  assert.equal(invalid.status, 422);
  const missing = await post('/api/requote', {});
  assert.equal(missing.status, 422);
  const unknown = await post('/api/requote', { offerId: 'no-such-offer' });
  assert.equal(unknown.status, 404);
  const unreachable = await post('/api/collect', { from: 'HAK', to: 'SHA' });
  assert.equal(unreachable.status, 502);
});
