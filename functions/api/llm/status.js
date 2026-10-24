import { jsonResponse, serverLLMConfig } from './_llm.mjs';

// 返回服务端模型接口的就绪状态。只暴露是否存在密钥与默认地址/模型，绝不回传密钥本身。
export async function onRequestGet({ env }) {
  const config = serverLLMConfig(env);
  return jsonResponse({
    serverKey: config.configured,
    baseUrl: config.configured ? config.baseUrl : '',
    model: config.model
  });
}
