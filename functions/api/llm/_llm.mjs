const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export function serverLLMConfig(env) {
  const apiKey = String(env.LLM_API_KEY || '').trim();
  return {
    apiKey,
    configured: Boolean(apiKey),
    baseUrl: String(env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: String(env.LLM_MODEL || '').trim()
  };
}

export async function relayUpstream(upstreamPromise) {
  let upstream;
  try {
    upstream = await upstreamPromise;
  } catch {
    return jsonResponse({ error: '无法连接模型服务商接口，请稍后重试。' }, 502);
  }
  const raw = await upstream.text();
  return new Response(raw, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
