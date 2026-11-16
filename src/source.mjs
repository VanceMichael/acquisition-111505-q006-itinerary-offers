import { request } from './transport.mjs';

export const SOURCE = 'source';

export class SourceError extends Error {
  constructor(message, status = null, body = null) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.body = body;
  }
}

const AMOUNT = /^\d+(?:\.\d+)?$/;
const CURRENCY = /^[A-Z]{3}$/;

async function postJson(base, path, body, maxBytes) {
  let reply;
  try {
    reply = await request(new URL(path, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      maxBytes,
    });
  } catch (error) {
    throw new SourceError(`无法联系来源: ${error.message}`);
  }
  const text = reply.bytes.toString('utf8');
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch { throw new SourceError('来源响应不是有效 JSON', reply.status, text); }
  }
  return { status: reply.status, body: parsed, raw: reply.bytes };
}

// 所有校验都针对一次响应内部的引用闭包：offer 的 segmentRefs 必须落在本次
// search 的 journeys 里，fareComponents 必须落在该 offer 自己的作用域内。
// 校验器从不接收别的报价对象，因此结构上无法把不同报价的便宜航段拼到一起。
export function validateSearch(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SourceError('search 响应应为对象');
  if (typeof payload.searchId !== 'string' || !payload.searchId) throw new SourceError('search 缺少 searchId');
  if (typeof payload.expiresAt !== 'string' || Number.isNaN(Date.parse(payload.expiresAt))) throw new SourceError('search 缺少可解析的 expiresAt');
  if (!Array.isArray(payload.journeys) || payload.journeys.length === 0) throw new SourceError('search 缺少航段组 journeys');
  const segmentIds = new Set();
  for (const journey of payload.journeys) {
    if (!journey || typeof journey !== 'object') throw new SourceError('航段应为对象');
    if (typeof journey.segmentId !== 'string' || !journey.segmentId) throw new SourceError('航段缺少 segmentId');
    if (segmentIds.has(journey.segmentId)) throw new SourceError(`航段标识重复: ${journey.segmentId}`);
    for (const field of ['flight', 'from', 'to']) {
      if (typeof journey[field] !== 'string' || !journey[field]) throw new SourceError(`航段 ${journey.segmentId} 缺少字段 ${field}`);
    }
    segmentIds.add(journey.segmentId);
  }
  if (!Array.isArray(payload.offers)) throw new SourceError('search 缺少 offers 列表');
  const offerIds = new Set();
  for (const offer of payload.offers) {
    if (!offer || typeof offer !== 'object') throw new SourceError('报价应为对象');
    if (typeof offer.offerId !== 'string' || !offer.offerId) throw new SourceError('报价缺少 offerId');
    if (offerIds.has(offer.offerId)) throw new SourceError(`报价标识重复: ${offer.offerId}`);
    offerIds.add(offer.offerId);
    if (!Array.isArray(offer.segmentRefs) || offer.segmentRefs.length === 0) throw new SourceError(`报价 ${offer.offerId} 缺少 segmentRefs`);
    for (const ref of offer.segmentRefs) {
      if (!segmentIds.has(ref)) throw new SourceError(`报价 ${offer.offerId} 引用了本次查询之外的航段 ${ref}`);
    }
    if (!Array.isArray(offer.travelerRefs) || offer.travelerRefs.length === 0) throw new SourceError(`报价 ${offer.offerId} 缺少 travelerRefs`);
    if (offer.travelerRefs.some(ref => typeof ref !== 'string' || !ref)) throw new SourceError(`报价 ${offer.offerId} 的 travelerRefs 应为非空字符串`);
    if (new Set(offer.travelerRefs).size !== offer.travelerRefs.length) throw new SourceError(`报价 ${offer.offerId} 的 travelerRefs 重复`);
    if (typeof offer.detailToken !== 'string' || !offer.detailToken) throw new SourceError(`报价 ${offer.offerId} 缺少短效凭据 detailToken`);
  }
  return payload;
}

export function validateDetail(payload, expected) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SourceError('detail 响应应为对象');
  if (payload.searchId !== expected.searchId) throw new SourceError('detail 的 searchId 与报价不一致');
  if (payload.offerId !== expected.offerId) throw new SourceError('detail 的 offerId 与报价不一致');
  if (payload.detailToken !== expected.detailToken) throw new SourceError('detail 返回的凭据与领取时不一致');
  const scopeSegments = new Set(expected.segmentRefs);
  const scopeTravelers = new Set(expected.travelerRefs);
  if (!Array.isArray(payload.fareComponents) || payload.fareComponents.length === 0) throw new SourceError('detail 缺少 fareComponents');
  const seenTravelers = new Set();
  for (const component of payload.fareComponents) {
    if (!component || typeof component !== 'object') throw new SourceError('计价组件应为对象');
    if (!scopeTravelers.has(component.travelerRef)) throw new SourceError(`计价组件引用了报价作用域之外的乘客 ${component.travelerRef}`);
    if (seenTravelers.has(component.travelerRef)) throw new SourceError(`乘客 ${component.travelerRef} 出现多条计价组件`);
    seenTravelers.add(component.travelerRef);
    if (!Array.isArray(component.segments) || component.segments.length === 0) throw new SourceError('计价组件缺少 segments');
    for (const ref of component.segments) {
      if (!scopeSegments.has(ref)) throw new SourceError(`计价组件引用了报价作用域之外的航段 ${ref}`);
    }
    if (typeof component.amount !== 'string' || !AMOUNT.test(component.amount)) throw new SourceError('计价金额应为十进制字符串');
    if (typeof component.currency !== 'string' || !CURRENCY.test(component.currency)) throw new SourceError('币种应为 ISO 4217 三字母代码');
    if (component.taxIncluded !== true && component.taxIncluded !== false && component.taxIncluded !== null) throw new SourceError('taxIncluded 必须是三态值');
  }
  for (const ref of scopeTravelers) {
    if (!seenTravelers.has(ref)) throw new SourceError(`乘客 ${ref} 缺少对应计价组件`);
  }
  if (payload.conditions !== null && (typeof payload.conditions !== 'object' || Array.isArray(payload.conditions))) throw new SourceError('conditions 应为对象或显式 null');
  return payload;
}

async function fetchPricing(base, searchId, offer, detailOffer = offer) {
  const reply = await postJson(base, '/offers/detail', {
    searchId,
    offerId: detailOffer.offerId,
    detailToken: detailOffer.detailToken,
  });
  if (reply.status === 410) return { status: 'expired', statusCode: 410, detail: null, raw: reply.raw, error: reply.body?.error || '报价已过期' };
  if (reply.status === 409) return { status: 'invalid-credential', statusCode: 409, detail: null, raw: reply.raw, error: reply.body?.error || '详情凭据不属于这次报价' };
  if (reply.status < 200 || reply.status > 299) throw new SourceError(`detail 返回 ${reply.status}`, reply.status, reply.body);
  const detail = validateDetail(reply.body, { searchId, ...offer });
  return { status: 'priced', statusCode: reply.status, detail, raw: reply.raw, error: null };
}

function pricingSection(result) {
  if (result.status !== 'priced') {
    return {
      status: result.status,
      detailToken: result.status === 'expired' ? null : 'present-but-rejected',
      fareComponents: null,
      conditions: null,
      currency: null,
      taxIncluded: null,
      totalAmount: null,
      error: result.error,
    };
  }
  const currency = [...new Set(result.detail.fareComponents.map(component => component.currency))];
  const total = result.detail.fareComponents.reduce((sum, component) => sum + Number(component.amount), 0);
  return {
    status: 'priced',
    detailToken: result.detail.detailToken,
    fareComponents: structuredClone(result.detail.fareComponents),
    conditions: result.detail.conditions === null ? null : structuredClone(result.detail.conditions),
    currency: currency.length === 1 ? currency[0] : currency,
    taxIncluded: [...new Set(result.detail.fareComponents.map(component => component.taxIncluded))],
    totalAmount: total.toFixed(2),
    error: null,
  };
}

async function buildObservation(archive, base, search, offer, searchBlob, lineage, maxBytes, detailOffer = offer) {
  const pricing = await fetchPricing(base, search.searchId, offer, detailOffer);
  const detailBlob = await archive.storeBlob(pricing.raw);
  const data = {
    kind: 'source-offer-observation',
    searchId: search.searchId,
    offerId: offer.offerId,
    query: structuredClone(search.query),
    search: {
      expiresAt: search.expiresAt,
      // 整组航段按来源原样保存，offer 只能通过 segmentRefs 引用其中的航段
      journeys: structuredClone(search.journeys),
      offers: structuredClone(search.offers),
      rawSha256: searchBlob.sha256,
    },
    offer: structuredClone(offer),
    pricing: { ...pricingSection(pricing), rawSha256: detailBlob.sha256 },
    lineage,
  };
  return data;
}

// 自动查询领取：只做查询、领取与留档，不触发预订或购买。
// 一次查询的全部航段与每个报价的乘客/计价作用域作为整体保存。
export async function collectOfferObservations(archive, base, query, options = {}) {
  const maxBytes = options.maxBytes || 1048576;
  const reply = await postJson(base, '/offers/search', query, maxBytes);
  if (reply.status < 200 || reply.status > 299) throw new SourceError(`search 返回 ${reply.status}`, reply.status, reply.body);
  const search = validateSearch(reply.body);
  search.query = structuredClone(query);
  const searchBlob = await archive.storeBlob(reply.raw);
  const observations = [];
  for (const offer of search.offers) {
    const data = await buildObservation(archive, base, search, offer, searchBlob, {
      relation: 'initial',
      replacedOfferId: null,
      predecessor: null,
    }, maxBytes);
    const identity = { search: search.searchId, offer: offer.offerId };
    const receipt = await archive.accept(SOURCE, identity, data, Buffer.from(JSON.stringify(data)));
    observations.push({ identity, ...receipt, pricingStatus: data.pricing.status });
  }
  return { searchId: search.searchId, expiresAt: search.expiresAt, offerCount: search.offers.length, searchBlob: searchBlob.sha256, observations };
}

export async function findOfferReceipt(archive, offerId) {
  const records = (await archive.list()).filter(record => record.source === SOURCE);
  for (const record of records) {
    const versions = record.versions.filter(version => version.data?.offerId === offerId);
    if (versions.length) return { record, version: versions[versions.length - 1] };
  }
  return null;
}

// 过期后重查：保留原观察不动，新观察通过 lineage 与原报价建立关系，
// 任何一步失败都不写入半条记录。
export async function requoteObservation(archive, base, offerId, options = {}) {
  const maxBytes = options.maxBytes || 1048576;
  const found = await findOfferReceipt(archive, offerId);
  if (!found) throw new SourceError(`未找到报价 ${offerId} 的留档观察`, 404, null);
  const predecessor = found.version.data;

  const requoteReply = await postJson(base, '/offers/requote', { searchId: predecessor.searchId, offerId }, maxBytes);
  if (requoteReply.status < 200 || requoteReply.status > 299) throw new SourceError(`requote 返回 ${requoteReply.status}`, requoteReply.status, requoteReply.body);
  const requote = requoteReply.body;
  if (!requote || typeof requote !== 'object' || !requote.replacement) throw new SourceError('requote 缺少 replacement');
  if (requote.replacesOffer !== offerId) throw new SourceError('requote 的 replacesOffer 与原报价不符');
  const replacementOffer = requote.replacement;
  const requoteBlob = await archive.storeBlob(requoteReply.raw);

  // 替代方案的航段组必须重新整组查询领取，不能沿用原观察中的航段
  const searchReply = await postJson(base, '/offers/search', predecessor.query, maxBytes);
  if (searchReply.status < 200 || searchReply.status > 299) throw new SourceError(`重查 search 返回 ${searchReply.status}`, searchReply.status, searchReply.body);
  const search = validateSearch(searchReply.body);
  search.query = structuredClone(predecessor.query);
  if (!search.offers.some(item => item.offerId === replacementOffer.offerId)) throw new SourceError('重查结果中没有 requote 指定的替代报价');
  const offer = search.offers.find(item => item.offerId === replacementOffer.offerId);
  const searchBlob = await archive.storeBlob(searchReply.raw);

  const data = await buildObservation(archive, base, search, offer, searchBlob, {
    relation: 'replacement',
    replacedOfferId: offerId,
    predecessor: { searchId: predecessor.searchId, offerId, requoteRawSha256: requoteBlob.sha256 },
  }, maxBytes, replacementOffer);
  const identity = { search: search.searchId, offer: offer.offerId };
  const receipt = await archive.accept(SOURCE, identity, data, Buffer.from(JSON.stringify(data)));
  return { identity, ...receipt, pricingStatus: data.pricing.status, replacedOfferId: offerId, lineage: data.lineage };
}
