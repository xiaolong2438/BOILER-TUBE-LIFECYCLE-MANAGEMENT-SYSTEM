import { jsonResponse, relayUpstream, serverLLMConfig } from './_llm.mjs';

const MAX_BODY_BYTES = 6 * 1024 * 1024; // 视觉请求包含 base64 图片，需要比纯文本更大的上限
const MAX_TOKENS_CEILING = 4000;
const MAX_IMAGE_BYTES_BASE64 = 4 * 1024 * 1024;

// 视觉消息的 content 为分段数组：[{type:'text',text}, {type:'image_url',image_url:{url:'data:...'}}]
function validContentPart(part) {
  if(!part || typeof part !== 'object') return false;
  if(part.type === 'text') return typeof part.text === 'string' && part.text.length <= 64000;
  if(part.type === 'image_url') {
    const url = part.image_url && typeof part.image_url.url === 'string' ? part.image_url.url : '';
    return /^data:image\/(png|jpe?g|webp);base64,/i.test(url) && url.length <= MAX_IMAGE_BYTES_BASE64;
  }
  return false;
}

function validMessage(item) {
  if(!item || typeof item.role !== 'string') return false;
  if(typeof item.content === 'string') return item.content.length <= 64000;
  if(Array.isArray(item.content)) return item.content.length <= 8 && item.content.every(validContentPart);
  return false;
}

// 对话补全代理：上游地址与密钥全部取自服务端环境变量；
// 请求方只能选择模型 id、消息与采样参数，防止密钥被引到任意主机。
export async function onRequestPost({ request, env }) {
  const config = serverLLMConfig(env);
  if(!config.configured) return jsonResponse({ error: '服务端未配置模型密钥（LLM_API_KEY），请在 Cloudflare 环境变量中设置。' }, 400);

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if(contentLength > MAX_BODY_BYTES) return jsonResponse({ error: '请求体过大。' }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '请求体不是有效 JSON。' }, 400);
  }

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if(!messages || messages.length === 0 || !messages.every(validMessage)) {
    return jsonResponse({ error: 'messages 不能为空，且每条消息必须包含 role 与 content（文本或 text/image_url 分段）。' }, 400);
  }

  const model = String(body.model || config.model || '').trim();
  if(!model) return jsonResponse({ error: '未指定模型：请先在页面识别并选择模型，或在服务端配置 LLM_MODEL。' }, 400);

  const temperature = Number(body.temperature);
  const maxTokens = Number(body.max_tokens);

  return relayUpstream(fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : 0.2,
      max_tokens: Math.min(MAX_TOKENS_CEILING, Math.max(16, Number.isFinite(maxTokens) ? maxTokens : 1800))
    })
  }));
}
