import { jsonResponse, relayUpstream, serverLLMConfig } from './_llm.mjs';

// 模型列表代理：密钥只存在于服务端环境变量，请求方无法指定上游地址。
export async function onRequestGet({ env }) {
  const config = serverLLMConfig(env);
  if(!config.configured) return jsonResponse({ error: '服务端未配置模型密钥（LLM_API_KEY），请在 Cloudflare 环境变量中设置。' }, 400);
  return relayUpstream(fetch(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } }));
}
