import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, "..", p), "utf8");
const chat = read("functions/api/llm/chat.js");
const models = read("functions/api/llm/models.js");
const status = read("functions/api/llm/status.js");
const js = read("assets/app/app-v7.9.js");

// 服务端代理：密钥只能来自环境变量，上游地址不受请求方控制（防密钥外带/SSRF）。
assert.match(chat, /serverLLMConfig\(env\)/);
assert.match(chat, /if\(!config\.configured\)/);
assert.match(chat, /config\.baseUrl\}\/chat\/completions/);
assert.doesNotMatch(chat, /body\.baseUrl|request.*baseUrl.*\|\|/);
assert.match(models, /config\.baseUrl\}\/models/);
assert.match(status, /serverKey: config\.configured/);
assert.doesNotMatch(status, /apiKey/);

// 前端：未填写本地 Key 且服务端可用时走 /api/llm/*；填写了本地 Key 仍可直连。
assert.match(js, /async function refreshLLMServerStatus\(/);
assert.match(js, /function usingServerLLM\(config = getLLMFormConfig\(\)\)/);
assert.match(js, /Boolean\(llmServerStatus\?\.serverKey\) && !config\.apiKey/);
assert.match(js, /fetch\('\/api\/llm\/chat', \{[\s\S]*?method: 'POST'/);
assert.match(js, /fetch\('\/api\/llm\/models'\)/);
assert.match(js, /refreshLLMServerStatus\(\);/);

console.log("ok - LLM server-side proxy keeps the API key out of the browser");
