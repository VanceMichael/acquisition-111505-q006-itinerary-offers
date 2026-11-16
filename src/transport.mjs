export async function request(url, options = {}) {
  const { maxBytes = 1048576, ...fetchOptions } = options;
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), ...fetchOptions });
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new Error(`来源响应超过 ${maxBytes} 字节上限`);
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  return { status: response.status, headers: Object.fromEntries(response.headers), bytes };
}
export function decodeJson(reply) {
  if (reply.status < 200 || reply.status > 299) throw new Error(`来源返回 ${reply.status}`);
  return JSON.parse(reply.bytes.toString('utf8'));
}
