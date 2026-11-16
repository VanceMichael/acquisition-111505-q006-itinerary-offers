import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { collectOfferObservations, requoteObservation, SourceError } from './source.mjs';
import { buildReview } from './review.mjs';

const configuration = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));

async function readJsonBody(incoming, reply) {
  const chunks = []; let length = 0;
  for await (const chunk of incoming) { length += chunk.length; if (length > 1048576) return reply(413, { error: '请求体过大' }); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return reply(400, { error: 'JSON 无效' }); }
}

function validateQuery(body) {
  const query = { ...configuration.probeBody, ...(body || {}) };
  for (const field of ['from', 'to']) {
    if (typeof query[field] !== 'string' || !/^[A-Za-z]{3}$/.test(query[field])) throw new Error(`行程条件 ${field} 应为三位机场代码`);
    query[field] = query[field].toUpperCase();
  }
  if (query.from === query.to) throw new Error('出发地与目的地不能相同');
  return query;
}

export async function createIntake(directory, options = {}) {
  const archive = await new Archive(directory).initialize();
  const resolveSourceBase = () => options.sourceBase || process.env.SOURCE_BASE || `http://127.0.0.1:${process.env.SOURCE_PORT || 4200}`;
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    const mapSourceError = error => reply(error.status === 404 ? 404 : 502, { error: error.message, sourceStatus: error.status });
    try {
      if (incoming.method === 'GET' && incoming.url === '/health') return reply(200, { status: 'ok', acquisition: ['manual', 'source'] });
      if (incoming.method === 'GET' && incoming.url === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'GET' && incoming.url === '/api/review') return reply(200, await buildReview(archive));
      if (incoming.method === 'POST' && incoming.url === '/api/collect') {
        const body = await readJsonBody(incoming, reply);
        if (outgoing.writableEnded) return;
        let query;
        try { query = validateQuery(body); } catch (error) { return reply(422, { error: error.message }); }
        try { return reply(201, await collectOfferObservations(archive, resolveSourceBase(), query)); }
        catch (error) { if (error instanceof SourceError) return mapSourceError(error); throw error; }
      }
      if (incoming.method === 'POST' && incoming.url === '/api/requote') {
        const body = await readJsonBody(incoming, reply);
        if (outgoing.writableEnded) return;
        if (typeof body.offerId !== 'string' || !body.offerId) return reply(422, { error: '缺少 offerId' });
        try { return reply(201, await requoteObservation(archive, resolveSourceBase(), body.offerId)); }
        catch (error) { if (error instanceof SourceError) return mapSourceError(error); throw error; }
      }
      if (incoming.method === 'POST' && incoming.url === '/api/manual') {
        const payload = await readJsonBody(incoming, reply);
        if (outgoing.writableEnded) return;
        try { return reply(201, await receiveManual(archive, payload)); } catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
