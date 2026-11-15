import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('短效详情与整份报价作用域绑定', async context => {
  const { post } = await withSource(context); const search = await (await post('/offers/search', { from: 'HAK', to: 'SHA' })).json();
  const offer = search.offers[0]; const detail = await (await post('/offers/detail', { searchId: search.searchId, ...offer })).json();
  assert.equal(detail.fareComponents[0].amount, '1250.00'); assert.equal(detail.fareComponents[0].taxIncluded, null);
  assert.equal((await post('/offers/detail', { searchId: 'other-search', ...offer })).status, 409);
});
test('重查可改变联程组合且旧凭据失效', async context => {
  const { post, control } = await withSource(context); const first = await (await post('/offers/search', { from: 'HAK', to: 'SHA' })).json();
  await control({ revision: 2 }); const second = await (await post('/offers/search', { from: 'HAK', to: 'SHA' })).json();
  assert.notEqual(first.journeys[0].to, second.journeys[0].to);
  assert.equal((await post('/offers/detail', { searchId: first.searchId, ...first.offers[0] })).status, 409);
});
