import { SOURCE } from './source.mjs';

function disclosureOf(data) {
  const pricing = data.pricing;
  const pending = [];
  if (pricing.status !== 'priced') {
    pending.push(pricing.status === 'expired' ? '价格未领取：短效凭据已过期，需重查' : '价格未领取：详情凭据未被来源接受，需重查');
    return {
      priceClaimed: false,
      conditionsDisclosed: false,
      taxBasisDisclosed: false,
      currencyDisclosed: false,
      pending,
    };
  }
  const conditionsDisclosed = pricing.conditions !== null;
  const taxValues = pricing.taxIncluded;
  const taxBasisDisclosed = Array.isArray(taxValues) && taxValues.every(value => value === true || value === false);
  const currencyDisclosed = typeof pricing.currency === 'string';
  if (!conditionsDisclosed) pending.push('计价条件待补取：来源本次未披露 conditions');
  if (!taxBasisDisclosed) pending.push('含税口径待补取：taxIncluded 仍为未知');
  if (!currencyDisclosed) pending.push('币种待确认：计价组件存在多种币种');
  return { priceClaimed: true, conditionsDisclosed, taxBasisDisclosed, currencyDisclosed, pending };
}

function segmentSignature(data) {
  const journeys = new Map(data.search.journeys.map(journey => [journey.segmentId, journey]));
  return data.offer.segmentRefs.map(ref => {
    const journey = journeys.get(ref);
    return journey ? `${ref}:${journey.flight}:${journey.from}>${journey.to}` : `${ref}:?`;
  });
}

function compareTax(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

// 审批视图：只读取已留档观察，不做任何重新查询或覆盖。
// 变化对照只在 lineage 指认的相邻观察之间进行，避免把不相关报价拿来比较。
export async function buildReview(archive) {
  const records = await archive.list();
  const byOffer = new Map();
  for (const record of records.filter(item => item.source === SOURCE)) {
    for (const version of record.versions) byOffer.set(version.data.offerId, { data: version.data, observedAt: version.receivedAt });
  }
  const replaced = new Set();
  for (const entry of byOffer.values()) {
    if (entry.data.lineage?.relation === 'replacement' && entry.data.lineage.replacedOfferId) replaced.add(entry.data.lineage.replacedOfferId);
  }
  const entries = [...byOffer.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const offers = entries.map(({ data, observedAt }) => {
    const disclosure = disclosureOf(data);
    let changes = null;
    if (data.lineage?.relation === 'replacement' && data.lineage.predecessor) {
      const previousEntry = byOffer.get(data.lineage.replacedOfferId);
      if (previousEntry) {
        const previous = previousEntry.data;
        const beforeSegments = segmentSignature(previous);
        const afterSegments = segmentSignature(data);
        changes = {
          predecessor: { searchId: previous.searchId, offerId: previous.offerId, observedAt: previousEntry.observedAt },
          currency: {
            before: previous.pricing.currency,
            after: data.pricing.currency,
            changed: JSON.stringify(previous.pricing.currency) !== JSON.stringify(data.pricing.currency),
          },
          taxBasis: {
            before: previous.pricing.taxIncluded,
            after: data.pricing.taxIncluded,
            changed: compareTax(previous.pricing.taxIncluded, data.pricing.taxIncluded),
          },
          totalAmount: {
            before: previous.pricing.totalAmount,
            after: data.pricing.totalAmount,
            changed: previous.pricing.totalAmount !== data.pricing.totalAmount,
          },
          segments: {
            before: beforeSegments,
            after: afterSegments,
            changed: JSON.stringify(beforeSegments) !== JSON.stringify(afterSegments),
          },
        };
      }
    }
    return {
      offerId: data.offerId,
      searchId: data.searchId,
      observedAt,
      relation: data.lineage?.relation ?? 'initial',
      replacedOfferId: data.lineage?.replacedOfferId ?? null,
      superseded: replaced.has(data.offerId),
      query: data.query,
      segmentRefs: data.offer.segmentRefs,
      travelerRefs: data.offer.travelerRefs,
      pricing: {
        status: data.pricing.status,
        currency: data.pricing.currency,
        taxIncluded: data.pricing.taxIncluded,
        totalAmount: data.pricing.totalAmount,
        fareComponents: data.pricing.fareComponents,
        conditions: data.pricing.conditions,
        error: data.pricing.error,
      },
      disclosure,
      changesFromPredecessor: changes,
      evidence: {
        searchRawSha256: data.search.rawSha256,
        pricingRawSha256: data.pricing.rawSha256,
      },
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    observationCount: offers.length,
    pricedCount: offers.filter(item => item.pricing.status === 'priced').length,
    pendingCount: offers.filter(item => item.disclosure.pending.length > 0).length,
    supersededCount: offers.filter(item => item.superseded).length,
    offers,
  };
}
