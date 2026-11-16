import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = createProvider();
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const source = `http://127.0.0.1:${provider.address().port}`;
const intake = await createIntake(directory, { sourceBase: source });
try {
  intake.listen(0, '127.0.0.1');
  await once(intake, 'listening');
  const base = `http://127.0.0.1:${intake.address().port}`;
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value ?? {}) });
  const control = value => fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

  // 1. 自动查询领取：整组航段、乘客适用范围与计价条件按来源原样整体留档
  const collected = await (await post('/api/collect', { from: 'HAK', to: 'SHA' })).json();
  console.log(JSON.stringify({ 自动采集: { searchId: collected.searchId, 报价数: collected.offerCount, 状态: collected.observations.map(item => item.pricingStatus) } }));
  const offerId = collected.observations[0].identity.offer;

  // 2. 审批视图：披露项、待补取项与原始证据摘要
  const review = await (await fetch(base + '/api/review')).json();
  console.log(JSON.stringify({ 审批视图: { 观察数: review.observationCount, 待补取: review.offers[0].disclosure.pending, 含税口径: review.offers[0].pricing.taxIncluded } }));

  // 3. 来源情景切换为替代报价：币种与含税口径同时改变
  await control({ revision: 2, currency: 'USD', taxKnown: true });
  const requote = await (await post('/api/requote', { offerId })).json();
  console.log(JSON.stringify({ 重查留档: { 新报价: requote.identity.offer, 关系: requote.lineage.relation, 替代: requote.replacedOfferId } }));

  // 4. 再次审批：两次观察都在，变化只在 lineage 相邻观察间对照
  const reviewAfter = await (await fetch(base + '/api/review')).json();
  const replacement = reviewAfter.offers.find(item => item.offerId !== offerId);
  console.log(JSON.stringify({ 变化对照: { 币种: replacement.changesFromPredecessor.currency, 含税: replacement.changesFromPredecessor.taxBasis, 航段变化: replacement.changesFromPredecessor.segments.changed } }));

  // 5. 人工收件仍与自动来源隔离
  const accepted = await post('/api/manual', sample);
  console.log(JSON.stringify({ 人工收件: await accepted.json() }));
  const records = await (await fetch(base + '/api/records')).json();
  console.log(JSON.stringify({ 归档来源: [...new Set(records.map(record => record.source))], 观察总数: reviewAfter.observationCount }));
} finally { intake.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]); await rm(directory, { recursive: true, force: true }); }
