// Офлайн-тесты freehub: поднимает моки OpenAI-совместимых провайдеров и
// проверяет роутинг, fallback, tool calling, SSE, добавление своего API,
// защиту управляющего API и лимит тела запроса.
//
//   node test/run-tests.mjs
//
// Зависимостей нет, порты выделяются динамически, ~/.freehub не затрагивается.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = path.join(ROOT, 'test', 'mock-openai.cjs');
const FREEHUB = path.join(ROOT, 'freehub.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function freePort() {
  const srv = createHttpServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return res;
    } catch {}
    await sleep(250);
  }
  return null;
}

const procs = [];
function start(args, env) {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  procs.push(p);
  return p;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freehub-test-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });

const [pFail, pOk, pSse, pCustom, pFreehub] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
const decoyPort = await freePort();

const providers = (port, label) => ({
  label,
  baseURL: `http://127.0.0.1:${port}/v1`,
  apiKey: 'mock-key-123',
  defaultModel: 'mock-chat',
  models: [{ id: 'mock-chat', tools: true }, { id: 'mock-pro', tools: true }],
  allowedParams: ['temperature', 'max_tokens'],
});
const config = {
  port: pFreehub,
  host: '127.0.0.1',
  trustedHosts: [],
  autoOpenOnFirstRun: false,
  requestTimeoutMs: 30000,
  modelsCacheMs: 300000,
  autoPriority: ['mockfail', 'mockok', 'mocksse'],
  bridge: { enabled: false, autoStart: false, dir: '', port: decoyPort },
  providers: {
    mockfail: providers(pFail, 'Mock fail'),
    mockok: providers(pOk, 'Mock ok'),
    mocksse: providers(pSse, 'Mock SSE'),
  },
};
const configPath = path.join(home, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

let decoy = null;

try {
  start([MOCK, String(pFail), 'fail']);
  start([MOCK, String(pOk), 'ok']);
  start([MOCK, String(pSse), 'sse']);
  start([MOCK, String(pCustom), 'ok']);
  start([FREEHUB, 'serve'], { FREEHUB_HOME: home });

  const base = `http://127.0.0.1:${pFreehub}`;
  const health = await waitFor(base + '/healthz');
  check('server starts and /healthz answers', !!health, health ? '' : 'no answer');
  if (!health) throw new Error('server did not start');

  const healthJson = await health.json();
  check('healthz reports a version', typeof healthJson.version === 'string' && healthJson.version.length > 0);

  const models = await (await fetch(base + '/v1/models')).json();
  const ids = models.data.map((m) => m.id);
  check('GET /v1/models lists live provider models', ids.includes('mockok/mock-chat') && ids.includes('free'),
    ids.slice(0, 4).join(', '));

  const chat = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'free', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const chatJson = await chat.json();
  check('auto model falls back past 429 to the next provider',
    chat.status === 200 && chat.headers.get('x-freehub-provider') === 'mockok',
    `status=${chat.status} provider=${chat.headers.get('x-freehub-provider')}`);
  check('tool calling survives the proxy',
    chatJson.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'get_weather');

  const sse = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mocksse/mock-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const sseText = await sse.text();
  check('SSE passthrough', sse.headers.get('content-type')?.includes('text/event-stream') && sseText.includes('data: [DONE]'),
    `ct=${sse.headers.get('content-type')}`);

  const badJson = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
  });
  check('invalid JSON -> 400', badJson.status === 400, `status=${badJson.status}`);

  const unknown = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nope/nope', messages: [] }),
  });
  check('unknown provider/model -> 404', unknown.status === 404, `status=${unknown.status}`);

  // --- добавление своего API (custom provider) ---
  const add = await fetch(base + '/api/providers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'myapi', label: 'My API', baseURL: `http://127.0.0.1:${pCustom}/v1`, key: 'mock-key-123',
    }),
  });
  const addJson = await add.json();
  check('POST /api/providers adds a custom API', add.status === 200 && addJson.ok === true && addJson.discovered > 0,
    `status=${add.status} discovered=${addJson.discovered}`);

  const customChat = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'myapi/mock-chat', messages: [{ role: 'user', content: 'hi' }] }),
  });
  check('chat through the newly added API', customChat.status === 200 && customChat.headers.get('x-freehub-provider') === 'myapi',
    `status=${customChat.status} provider=${customChat.headers.get('x-freehub-provider')}`);

  // --- защита управляющего API ---
  const evil = { 'content-type': 'application/json', origin: 'https://evil.example' };
  const evilRead = await fetch(base + '/api/status', { headers: { origin: 'https://evil.example' } });
  check('cross-origin read of /api/status is refused', evilRead.status === 403, `status=${evilRead.status}`);

  const evilWrite = await fetch(base + '/api/keys', {
    method: 'POST', headers: evil, body: JSON.stringify({ id: 'mockok', key: 'stolen' }),
  });
  check('cross-origin write to /api/keys is refused', evilWrite.status === 403, `status=${evilWrite.status}`);

  const sameOrigin = await fetch(base + '/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ id: 'mockok', key: 'mock-key-123' }),
  });
  check('same-origin write to /api/keys works', sameOrigin.status === 200, `status=${sameOrigin.status}`);

  const corsV1 = await fetch(base + '/v1/models', { headers: { origin: 'https://evil.example' } });
  check('OpenAI endpoints stay CORS-open for browser clients',
    corsV1.headers.get('access-control-allow-origin') === '*',
    `ACAO=${corsV1.headers.get('access-control-allow-origin')}`);

  const big = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: Buffer.alloc(21 * 1024 * 1024, 0x61),
  });
  check('oversized body -> 413 instead of a dropped socket', big.status === 413, `status=${big.status}`);

  // --- остановка моста не должна убивать чужой процесс на порту ---
  if (process.platform === 'win32') {
    decoy = spawn(process.execPath, ['-e',
      "require('http').createServer((q,s)=>s.end('decoy')).listen(Number(process.argv[1]),'127.0.0.1')", String(decoyPort)],
    { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 700));
    const stop = await fetch(base + '/api/bridge/stop', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    let alive = true;
    try { process.kill(decoy.pid, 0); } catch { alive = false; }
    check('bridge stop refuses to kill a foreign process on its port', stop.status === 409 && alive,
      `status=${stop.status} alive=${alive}`);
  }
} catch (e) {
  failures.push(`runner: ${e.stack || e.message}`);
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  if (decoy) { try { decoy.kill(); } catch {} }
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
}
