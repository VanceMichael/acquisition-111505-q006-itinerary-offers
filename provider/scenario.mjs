export const initialState = () => ({ name: '联程报价查询', revision: 1 });

export async function handle({ url, body, state, json }) {
  const searchId = `search-${state.revision}`;
  const offer = { offerId: `offer-${state.revision}`, segmentRefs: ['seg-a', 'seg-b'], travelerRefs: ['adult-1'], detailToken: `detail-${state.revision}` };
  if (url.pathname === '/offers/search') {
    if (!body?.from || !body?.to) { json(400, { error: '行程条件不完整' }); return true; }
    json(200, { searchId, expiresAt: state.expired ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z', journeys: [
      { segmentId: 'seg-a', flight: 'EX101', from: body.from, to: state.revision === 1 ? 'MID' : 'ALT' },
      { segmentId: 'seg-b', flight: 'EX102', from: state.revision === 1 ? 'MID' : 'ALT', to: body.to }
    ], offers: [offer] }); return true;
  }
  if (url.pathname === '/offers/detail') {
    if (state.expired) { json(410, { error: '报价已过期' }); return true; }
    if (body?.searchId !== searchId || body?.offerId !== offer.offerId || body?.detailToken !== offer.detailToken) { json(409, { error: '详情凭据不属于这次报价' }); return true; }
    json(200, { searchId, ...offer, fareComponents: [{ travelerRef: 'adult-1', segments: ['seg-a', 'seg-b'], amount: state.revision === 1 ? '1250.00' : '1300.00', currency: state.currency || 'CNY', taxIncluded: state.taxKnown ? true : null }], conditions: state.conditionsMissing ? null : { refundable: false } }); return true;
  }
  if (url.pathname === '/offers/requote') { json(200, { searchId, replacesOffer: body?.offerId, replacement: offer }); return true; }
  return false;
}
