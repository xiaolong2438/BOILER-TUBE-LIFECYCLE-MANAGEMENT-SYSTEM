# Homepage LLM Interface Design

Goal: add a homepage panel that lets the operator call common large language models for deeper boiler-tube analysis.

Approved approach: implement an OpenAI-compatible chat-completions client directly in the existing single-file HTML app. The panel stores API Base URL, API Key, model name, and temperature in browser localStorage.

UI:
- Add a "Standard LLM Deep Analysis" card on the dashboard near the existing warnings and simulated AI entry point.
- Include provider preset, custom Base URL, API Key, model, temperature, analysis prompt, action buttons, and a result area.
- Keep styling consistent with the current cyber dashboard cards, forms, and AI purple accent.

Data flow:
- Read and write config from localStorage key `boiler_llm_config`.
- Build a context prompt from dashboard summary, current sample warnings, selected lifecycle samples, and local user event counts.
- Send a POST request to `${baseUrl}/chat/completions` with `Authorization: Bearer <apiKey>` and OpenAI-compatible `messages`.
- Render returned text from `choices[0].message.content`; show clear errors for missing config, network failure, non-2xx HTTP status, or malformed response.

Security note:
- API keys are saved in this browser only. This is convenient for a personal/offline workstation, but the user should avoid saving production keys on shared machines.

Verification:
- Add a Node assertion test that scans the HTML for the new UI, localStorage persistence, OpenAI-compatible request shape, and error handling.
- Run the new test before implementation to verify it fails, then after implementation to verify it passes.
- Open the HTML in the in-app browser and confirm the dashboard panel renders.
