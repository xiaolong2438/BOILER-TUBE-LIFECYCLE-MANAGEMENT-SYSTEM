"""AI 数据助手端到端冒烟（真实浏览器，无后端/无模型）。
Run: python tests/run-assistant-browser.py
复用隔离临时 profile 与回环服务器，不触碰真实用户数据。
"""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import html
import json
import os
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
page = (ROOT / '炉管全生命周期管理系统.html').read_text(encoding='utf-8')
page = re.sub(r'<script\b[^>]*src="https?://[^\"]*"[^>]*></script>', '', page)
bootstrap = '''<base href="/">
<script>
window.__testErrors=[]; window.__externalRequests=[];
window.addEventListener('error', e=>window.__testErrors.push(String(e.error?.stack || e.message)));
window.addEventListener('unhandledrejection', e=>window.__testErrors.push(String(e.reason?.stack || e.reason)));
window.fetch = function(url) {
  if(/^https?:/.test(String(url))) window.__externalRequests.push(String(url));
  return new Response('{}',{status:404,headers:{'Content-Type':'application/json'}});
};
window.confirm = function(){ return true; };
</script>'''
page = page.replace('<head>', '<head>' + bootstrap, 1)
page = page.replace('</body>', '''<script src="tests/assistant-browser-runtime.js" defer></script>
<script>window.addEventListener('DOMContentLoaded', async()=>{
  let result; try { result=await window.runAssistantTests(); }
  catch(error) { result={passed:false,error:String(error.stack || error),errors:window.__testErrors}; }
  const pre=document.createElement('pre');pre.id='runtime-test-results';pre.textContent=JSON.stringify(result);document.body.appendChild(pre);
});</script></body>''', 1)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.startswith('/__assistant_test__'):
            content = page.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        else:
            super().do_GET()


edge = next((str(p) for p in [
    Path(os.environ.get('PROGRAMFILES(X86)', 'C:/Program Files (x86)')) / 'Microsoft/Edge/Application/msedge.exe',
    Path(os.environ.get('PROGRAMFILES', 'C:/Program Files')) / 'Microsoft/Edge/Application/msedge.exe',
] if p.exists()), None)
if not edge:
    raise SystemExit('Microsoft Edge not found')

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
Thread(target=server.serve_forever, daemon=True).start()
profile = tempfile.mkdtemp(prefix='boiler-assistant-test-')
try:
    run = subprocess.run([edge, '--headless=new', '--disable-gpu', '--no-first-run',
        '--no-default-browser-check', '--disable-background-networking', f'--user-data-dir={profile}',
        '--virtual-time-budget=9000', '--dump-dom', f'http://127.0.0.1:{server.server_port}/__assistant_test__'],
        capture_output=True, timeout=120)
    dom = run.stdout.decode('utf-8', errors='replace')
    match = re.search(r'<pre id="runtime-test-results">(.*?)</pre>', dom, re.S)
    if not match:
        print(run.stderr.decode('utf-8', errors='replace')[-3000:])
        raise SystemExit('FAIL: browser produced no test result (script initialization may have failed).')
    result = json.loads(html.unescape(match.group(1)))
    print(json.dumps(result, ensure_ascii=True, indent=2))
    if not result['passed']:
        raise SystemExit(1)
finally:
    server.shutdown()
