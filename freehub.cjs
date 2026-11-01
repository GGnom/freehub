#!/usr/bin/env node
// freehub — локальный OpenAI-совместимый шлюз к бесплатным нейронкам с tool calling.
// Один exe: поднимает http://127.0.0.1:8787/v1, открывает консоли сервисов за ключами,
// читает ключи из env / ~/.freehub/keys.json / ~/.zcode/webkey/keys.json,
// роутит запросы к провайдерам, делает fallback при ошибках, нормализует параметры.
// Node >= 18, зависимостей нет. Документация: ~/.freehub/README.md

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');

const HOME = os.homedir();
const DIR = process.env.FREEHUB_HOME || path.join(HOME, '.freehub');
const CONFIG_FILE = path.join(DIR, 'config.json');
const KEYS_FILE = path.join(DIR, 'keys.json');
const WEBKEY_KEYS = path.join(HOME, '.zcode', 'webkey', 'keys.json');
const LOG_FILE = path.join(DIR, 'freehub.log');
// Версия: package.json рядом (когда запущен из репозитория); в SEA-exe файла нет.
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.2.0'; }
})();
// ---------------------------------------------------------------------------
// Каталог провайдеров. free: 'free' — бесплатный тариф, 'trial' — стартовые токены,
// 'cheap' — платный, но дешёвый. models — стартовый каталог (живой список /v1/models
// провайдера заменяет его, когда ключ есть). allowedParams — что прокидываем в upstream
// кроме обязательных model/messages/tools/tool_choice/stream.
const DEFAULT_PROVIDERS = [
  {
    id: 'groq', label: 'Groq', free: 'free',
    consoleUrl: 'https://console.groq.com/keys',
    modelExclude: 'whisper|tts|guard|playai|distil-|prompt',
    baseURL: 'https://api.groq.com/openai/v1',
    envVars: ['GROQ_API_KEY'], webkeySvc: 'groq', maxImages: 0,
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      { id: 'llama-3.3-70b-versatile', tools: true, note: 'основная, быстрая' },
      { id: 'llama-3.1-8b-instant', tools: true, note: 'самая быстрая' },
      { id: 'openai/gpt-oss-120b', tools: true },
      { id: 'openai/gpt-oss-20b', tools: true },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'response_format',
      'parallel_tool_calls', 'stream_options'],
    priority: 10,
  },
  {
    id: 'gemini', label: 'Google AI Studio (Gemini)', free: 'free',
    consoleUrl: 'https://aistudio.google.com/apikey',
    modelExclude: 'embedding|aqa|imagen|veo|tts|native-audio|image-generation|live|thinking-exp',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], webkeySvc: 'gemini',
    defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-flash', tools: true, note: 'щедрый free tier' },
      { id: 'gemini-2.5-pro', tools: true },
      { id: 'gemini-2.0-flash', tools: true },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'response_format',
      'parallel_tool_calls'],
    priority: 20,
  },
  {
    id: 'cerebras', label: 'Cerebras', free: 'free',
    consoleUrl: 'https://cloud.cerebras.ai/',
    modelExclude: 'guard',
    baseURL: 'https://api.cerebras.ai/v1',
    envVars: ['CEREBRAS_API_KEY'], webkeySvc: null, maxImages: 0,
    defaultModel: 'llama-3.3-70b',
    models: [
      { id: 'llama-3.3-70b', tools: true, note: 'очень быстро' },
      { id: 'qwen-3-32b', tools: true },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'response_format',
      'parallel_tool_calls'],
    priority: 30,
  },
  {
    id: 'github', label: 'GitHub Models (по GitHub-токену)', free: 'free',
    consoleUrl: 'https://github.com/settings/tokens',
    baseURL: 'https://models.github.ai/inference',
    envVars: ['GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN'], webkeySvc: 'github',
    defaultModel: 'openai/gpt-4o-mini',
    models: [
      { id: 'openai/gpt-4o-mini', tools: true, note: 'бесплатная квота' },
      { id: 'openai/gpt-4o', tools: true },
      { id: 'meta/Llama-3.3-70B-Instruct', tools: true },
      { id: 'mistral-ai/Mistral-Small-2503', tools: true },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'response_format',
      'parallel_tool_calls', 'stream_options'],
    priority: 35,
  },
  {
    id: 'mistral', label: 'Mistral La Plateforme', free: 'free',
    consoleUrl: 'https://console.mistral.ai/api-keys',
    modelExclude: 'embed|moderation|ocr|voxtral',
    baseURL: 'https://api.mistral.ai/v1',
    envVars: ['MISTRAL_API_KEY'], webkeySvc: null,
    defaultModel: 'mistral-small-latest',
    models: [
      { id: 'mistral-small-latest', tools: true },
      { id: 'open-mistral-nemo', tools: true },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'response_format',
      'parallel_tool_calls', 'stream_options'],
    priority: 40,
  },
  {
    id: 'openrouter', label: 'OpenRouter (:free модели)', free: 'free',
    consoleUrl: 'https://openrouter.ai/keys',
    baseURL: 'https://openrouter.ai/api/v1',
    envVars: ['OPENROUTER_API_KEY'], webkeySvc: 'openrouter',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', tools: true },
      { id: 'qwen/qwen-2.5-72b-instruct:free', tools: true },
      { id: 'deepseek/deepseek-chat-v3-0324:free', tools: false, note: 'бесплатная, без tools' },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'response_format',
      'parallel_tool_calls', 'stream_options'],
    priority: 50,
  },
  {
    id: 'nvidia', label: 'NVIDIA NIM (build.nvidia.com)', free: 'free',
    consoleUrl: 'https://build.nvidia.com/settings/api-keys',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    envVars: ['NVIDIA_API_KEY', 'NVAPI_KEY'], webkeySvc: 'nvidia', maxImages: 0,
    defaultModel: 'meta/llama-3.3-70b-instruct',
    models: [
      { id: 'meta/llama-3.3-70b-instruct', tools: true, note: 'стартовые кредиты' },
      { id: 'qwen/qwen2.5-coder-32b-instruct', tools: true },
      { id: 'openai/gpt-oss-120b', tools: true },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'response_format',
      'parallel_tool_calls', 'stream_options'],
    priority: 55,
  },
  {
    id: 'huggingface', label: 'HuggingFace Router', free: 'free',
    consoleUrl: 'https://huggingface.co/settings/tokens',
    baseURL: 'https://router.huggingface.co/v1',
    envVars: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'], webkeySvc: 'huggingface',
    defaultModel: 'qwen/qwen3-32b',
    models: [
      { id: 'qwen/qwen3-32b', tools: true, note: 'free tier' },
      { id: 'meta-llama/Llama-3.3-70B-Instruct', tools: true },
      { id: 'deepseek-ai/DeepSeek-V3-0324', tools: true },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'response_format',
      'parallel_tool_calls', 'stream_options'],
    priority: 57,
  },
  {
    id: 'together', label: 'Together AI (trial-кредиты)', free: 'trial',
    consoleUrl: 'https://api.together.ai/settings/api-keys',
    baseURL: 'https://api.together.ai/v1',
    envVars: ['TOGETHER_API_KEY'], webkeySvc: 'together', maxImages: 0,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', tools: true },
      { id: 'Qwen/Qwen2.5-Coder-32B-Instruct-Turbo', tools: true },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'response_format',
      'parallel_tool_calls', 'stream_options'],
    priority: 58,
  },
  {
    id: 'cloudflare', label: 'Cloudflare Workers AI (нужен account id)', free: 'free',
    consoleUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    baseURL: 'https://api.cloudflare.com/client/v4/accounts/{{accountId}}/ai/v1',
    envVars: ['CLOUDFLARE_API_TOKEN'], webkeySvc: null,
    defaultModel: '@cf/meta/llama-3.3-70b-instruct',
    models: [
      { id: '@cf/meta/llama-3.3-70b-instruct', tools: true },
      { id: '@cf/qwen/qwen2.5-coder-32b-instruct', tools: true },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'response_format'],
    priority: 62,
  },
  {
    id: 'dashscope', label: 'Qwen / DashScope (Aliyun)', free: 'trial',
    consoleUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    modelExclude: 'embedding|rerank|audio|tts|asr|dolly|nli|zero-shot|dialogue|summary|analytic|visual|charact|clip',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envVars: ['DASHSCOPE_API_KEY'], webkeySvc: 'dashscope', maxImages: 0,
    defaultModel: 'qwen-plus',
    models: [
      { id: 'qwen-plus', tools: true, note: 'стартовая бесплатная квота' },
      { id: 'qwen-max', tools: true },
      { id: 'qwen-turbo', tools: true },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'response_format'],
    priority: 60,
  },
  {
    id: 'moonshot', label: 'Kimi / Moonshot', free: 'trial',
    consoleUrl: 'https://platform.moonshot.cn/console/api-key',
    modelExclude: 'embedding|audio|vision',
    baseURL: 'https://api.moonshot.cn/v1',
    envVars: ['MOONSHOT_API_KEY'], webkeySvc: 'moonshot', maxImages: 0,
    defaultModel: 'kimi-k2-0905-preview',
    models: [
      { id: 'kimi-k2-0905-preview', tools: true, note: 'стартовые токены' },
      { id: 'moonshot-v1-8k', tools: true },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'response_format'],
    priority: 70,
  },
  {
    id: 'zai', label: 'Z.ai / GLM', free: 'cheap',
    consoleUrl: 'https://z.ai/manage-apikey/apikey-list',
    modelExclude: 'embedding|rerank|audio|tts|asr|cogview|cogvideo',
    baseURL: 'https://api.z.ai/api/paas/v4',
    envVars: ['ZAI_API_KEY'], webkeySvc: 'zai', maxImages: 0,
    defaultModel: 'glm-4.5-flash',
    models: [
      { id: 'glm-4.5-flash', tools: true, note: 'дешёвая/бесплатная линейка' },
      { id: 'glm-4.6', tools: true },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'response_format'],
    priority: 80,
  },
  {
    id: 'deepseek', label: 'DeepSeek', free: 'cheap',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    baseURL: 'https://api.deepseek.com/v1',
    envVars: ['DEEPSEEK_API_KEY'], webkeySvc: 'deepseek', maxImages: 0,
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', tools: true },
      { id: 'deepseek-reasoner', tools: true, note: 'reasoning' },
    ],
    allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop', 'response_format',
      'parallel_tool_calls', 'stream_options'],
    priority: 90,
  },
];

const BASE_ALLOWED = ['temperature', 'top_p', 'max_tokens', 'stop', 'seed',
  'presence_penalty', 'frequency_penalty', 'response_format'];
const ALWAYS_PASSED = ['model', 'messages', 'tools', 'tool_choice', 'stream'];

// ---------------------------------------------------------------------------
// Мост веб-чатов (chat-bridge): freehub поднимает его отдельным процессом,
// потому что Playwright/Chromium нельзя упаковать в SEA-exe. Мост работает
// как обычный OpenAI-совместимый провайдер: модели, ключ, tool calling.

function detectBridgeDir() {
  const candidates = [];
  if (process.env.FREEHUB_BRIDGE_DIR) candidates.push(process.env.FREEHUB_BRIDGE_DIR);
  candidates.push(path.join(HOME, 'chat-bridge'));
  candidates.push(path.resolve(process.cwd(), 'chat-bridge'));
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'dist', 'index.js')) ||
          fs.existsSync(path.join(dir, 'src', 'index.ts'))) return path.resolve(dir);
    } catch {}
  }
  return '';
}

function defaultConfig() {
  return {
    port: 8787,
    host: '127.0.0.1',
    // Дополнительные имена хостов, которые может присылать браузер (например,
    // имя машины в локальной сети). Проверяются для управляющего API /api/*.
    trustedHosts: [],
    autoOpenOnFirstRun: true,
    requestTimeoutMs: 180000,
    modelsCacheMs: 300000,
    modelsRefreshMs: 600000,
    bridge: {
      enabled: true,
      autoStart: true,
      dir: detectBridgeDir(),
      port: 8789,
      apiKey: 'sk-local-change-me',
      qwenWeb: true,
      providerId: 'webchat',
    },
    autoPriority: DEFAULT_PROVIDERS.slice().sort((a, b) => a.priority - b.priority).map((p) => p.id)
      .concat(['ollama', 'lmstudio']),
    providers: {
      ollama: {
        label: 'Ollama (локально, безлимитно)', free: 'local',
        consoleUrl: 'https://ollama.com/download',
        baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'ollama',
        defaultModel: 'qwen3:8b',
        models: [
          { id: 'qwen3:8b', tools: true },
          { id: 'qwen2.5-coder:7b', tools: true },
          { id: 'qwen2.5:7b', tools: true },
        ],
        modelExclude: 'embed|bge|nomic|minilm',
        allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop'],
        priority: 300,
      },
      lmstudio: {
        label: 'LM Studio (локально)', free: 'local',
        consoleUrl: 'https://lmstudio.ai/',
        baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'lm-studio',
        defaultModel: 'local-model',
        models: [],
        allowedParams: ['temperature', 'top_p', 'max_tokens', 'stop'],
        priority: 310,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Конфиг и ключи

function loadJson(file, fallback) {
  try {
    // некоторые редакторы (и PowerShell 5) пишут UTF-8 BOM — JSON.parse на нём падает
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch { return fallback; }
}
function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2);
  // Атомарная замена: обрыв процесса не оставляет наполовину записанный JSON.
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

function loadConfig() {
  const disk = loadJson(CONFIG_FILE, {});
  const cfg = { ...defaultConfig(), ...disk };
  cfg.providers = disk.providers || {};
  cfg.bridge = { ...defaultConfig().bridge, ...(disk.bridge || {}) };
  return cfg;
}

function providerCfg(cfg, id) {
  return { id, ...(DEFAULT_PROVIDERS.find((p) => p.id === id) || {}), ...(cfg.providers[id] || {}) };
}
function allProviders(cfg) {
  const ids = [...DEFAULT_PROVIDERS.map((p) => p.id), ...Object.keys(cfg.providers)];
  return [...new Set(ids)].map((id) => providerCfg(cfg, id)).filter((p) => p.enabled !== false && p.id);
}

function loadKeys() {
  const own = loadJson(KEYS_FILE, {});
  const webkey = loadJson(WEBKEY_KEYS, { services: {} }).services || {};
  const resolved = {}; // id -> {key, source}
  for (const p of DEFAULT_PROVIDERS) {
    let key = null, source = null;
    for (const v of p.envVars || []) {
      if (process.env[v]) { key = process.env[v]; source = 'env ' + v; break; }
    }
    if (!key && own[p.id]) { key = own[p.id]; source = '~/.freehub/keys.json'; }
    if (!key && p.webkeySvc && webkey[p.webkeySvc]?.key) {
      key = webkey[p.webkeySvc].key; source = 'webkey';
    }
    if (key) resolved[p.id] = { key, source };
  }
  // пользовательские провайдеры из конфига (ключ — из конфига или keys.json)
  const custom = loadJson(CONFIG_FILE, {}).providers || {};
  for (const [id, pc] of Object.entries(custom)) {
    if (DEFAULT_PROVIDERS.some((p) => p.id === id)) continue;
    if (pc.apiKey) resolved[id] = { key: pc.apiKey, source: 'config' };
    else if (own[id]) resolved[id] = { key: own[id], source: '~/.freehub/keys.json' };
  }
  return resolved;
}

function mask(k) {
  if (!k) return '—';
  return k.length <= 10 ? k.slice(0, 2) + '…' : k.slice(0, 4) + '…' + k.slice(-3);
}

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`;
  try { fs.appendFileSync(LOG_FILE, s + '\n'); } catch {}
  console.log(s);
}

// ---------------------------------------------------------------------------
// Менеджер моста веб-чатов

const BRIDGE_LOG = path.join(DIR, 'bridge.log');
let bridgeProc = null;
let bridgeStartedAt = 0;
let bridgeLastError = '';
let bridgeRetryAt = 0;
let bridgeFailures = 0;

function bridgeCfg(cfg) {
  const b = { ...defaultConfig().bridge, ...((cfg && cfg.bridge) || {}) };
  b.dir = b.dir ? path.resolve(String(b.dir)) : detectBridgeDir();
  b.port = Number(b.port) || 8789;
  b.enabled = b.enabled !== false;
  b.autoStart = b.autoStart !== false;
  return b;
}
function bridgeBase(b) { return `http://127.0.0.1:${b.port}`; }
function bridgeEntry(b) { return path.join(b.dir || '', 'dist', 'index.js'); }
function bridgeAvailable(b) { return !!b.dir && fs.existsSync(bridgeEntry(b)); }

function resolveNode() {
  if (process.env.FREEHUB_NODE) return process.env.FREEHUB_NODE;
  // SEA-exe: process.execPath — это freehub.exe, запускать его вместо node нельзя
  if (process.execPath && /^node(\.exe)?$/i.test(path.basename(process.execPath))) return process.execPath;
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, 'node' + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  for (const p of ['C:\\Program Files\\nodejs\\node.exe', '/usr/local/bin/node', '/usr/bin/node']) {
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

async function bridgeHealth(b, timeoutMs = 1500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(bridgeBase(b) + '/health', { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function waitBridge(b, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const h = await bridgeHealth(b);
    if (h) return h;
    if (!bridgeProc) return null; // процесс уже упал — незачем ждать
    await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

function startBridge(cfg) {
  const b = bridgeCfg(cfg);
  if (!b.enabled) throw new Error('мост выключен в конфиге (bridge.enabled=false)');
  if (bridgeProc && !bridgeProc.killed) return { started: false, reason: 'already-running', pid: bridgeProc.pid };
  if (!bridgeAvailable(b)) {
    throw new Error(`не найден ${path.join(b.dir || '—', 'dist', 'index.js')}: укажи каталог chat-bridge в настройках моста и собери его (npm run build)`);
  }
  const node = resolveNode();
  if (!node) throw new Error('не найден node.exe: для моста нужен Node.js (или задай FREEHUB_NODE)');
  fs.mkdirSync(DIR, { recursive: true });
  const out = fs.openSync(BRIDGE_LOG, 'a');
  fs.writeSync(out, `\n[${new Date().toISOString()}] --- freehub: запуск моста ${node} ${bridgeEntry(b)} (cwd ${b.dir}) ---\n`);
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(b.port),
    BRIDGE_DATA_DIR: path.join(b.dir, 'data'),
    BRIDGE_API_KEYS: b.apiKey || 'sk-local-change-me',
    QWEN_WEB_ENABLED: b.qwenWeb === false ? 'false' : 'true',
  };
  const child = spawn(node, [bridgeEntry(b)], {
    cwd: b.dir, env, stdio: ['ignore', out, out], windowsHide: true,
  });
  try { fs.closeSync(out); } catch {}
  bridgeProc = child;
  bridgeStartedAt = Date.now();
  bridgeLastError = '';
  child.on('error', (e) => {
    bridgeLastError = e.message;
    log(`bridge: ошибка запуска: ${e.message}`);
    if (bridgeProc === child) bridgeProc = null;
  });
  child.on('exit', (code, signal) => {
    log(`bridge: процесс завершился (code=${code}, signal=${signal || '—'})`);
    if (bridgeProc === child) bridgeProc = null;
    if (code !== 0) {
      bridgeFailures++;
      bridgeRetryAt = Date.now() + Math.min(300000, 15000 * 2 ** Math.min(bridgeFailures, 4));
    }
  });
  log(`bridge: запущен pid=${child.pid} на ${bridgeBase(b)} (лог ${BRIDGE_LOG})`);
  return { started: true, pid: child.pid };
}

function portPid(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        if (cols[1].endsWith(':' + port)) return Number(cols[cols.length - 1]) || null;
      }
    } else {
      const out = execFileSync('sh', ['-c', `lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null | head -n1`], { encoding: 'utf8' });
      return Number(out.trim()) || null;
    }
  } catch {}
  return null;
}

// Проверяем, что процесс на порту — действительно chat-bridge, а не чужой сервис:
// останавливать произвольный процесс по номеру порта нельзя.
function isBridgeProcess(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      return /chat-bridge/i.test(out);
    }
    return /chat-bridge/i.test(fs.readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8'));
  } catch { return false; }
}

function stopBridge(cfg) {
  const b = bridgeCfg(cfg);
  const owned = !!bridgeProc;
  const pid = owned ? bridgeProc.pid : portPid(b.port);
  if (!pid) return { stopped: false, reason: 'not-running' };
  if (!owned && !isBridgeProcess(pid)) {
    log(`bridge: порт ${b.port} занят посторонним процессом pid=${pid} — не останавливаю`);
    return { stopped: false, reason: 'foreign-process', pid };
  }
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    try { bridgeProc?.kill(); } catch {}
  }
  bridgeProc = null;
  bridgeFailures = 0;
  bridgeRetryAt = 0;
  log(`bridge: остановлен pid=${pid}`);
  return { stopped: true, pid };
}

function bridgeProviderId(cfg, b) {
  const target = bridgeBase(b) + '/v1';
  for (const [id, p] of Object.entries((cfg && cfg.providers) || {})) {
    if (p && p.baseURL && String(p.baseURL).replace(/\/+$/, '') === target) return id;
  }
  return (cfg && cfg.bridge && cfg.bridge.providerId) || 'webchat';
}

async function ensureBridgeProvider(cfg, b) {
  const id = bridgeProviderId(cfg, b);
  const baseURL = bridgeBase(b) + '/v1';
  const disk = loadJson(CONFIG_FILE, {});
  disk.providers = disk.providers || {};
  const cur = disk.providers[id] || {};
  const entry = {
    ...cur,
    label: cur.label || 'Мост веб-чатов (Qwen web)',
    free: cur.free || 'bridge',
    baseURL,
    allowedParams: cur.allowedParams || ['temperature', 'top_p', 'max_tokens', 'stop', 'seed',
      'response_format', 'parallel_tool_calls', 'stream_options'],
    priority: cur.priority !== undefined ? cur.priority : 250,
    maxImages: cur.maxImages !== undefined ? cur.maxImages : 8,
    managedBy: 'freehub',
  };
  let changed = JSON.stringify(cur) !== JSON.stringify(entry);
  disk.providers[id] = entry;
  const bridgeOnDisk = { ...(disk.bridge || {}), ...(cfg.bridge || {}), dir: b.dir, port: b.port };
  if (JSON.stringify(disk.bridge || {}) !== JSON.stringify(bridgeOnDisk)) {
    disk.bridge = bridgeOnDisk;
    changed = true;
  }
  if (changed) saveJson(CONFIG_FILE, disk);

  // ключ моста задаётся здесь же: если он разошёлся с keys.json (например, после
  // смены порта/ключа в настройках), все запросы к мосту получат 401 — синхронизируем
  const ks = loadJson(KEYS_FILE, {});
  const bridgeKey = b.apiKey || 'sk-local-change-me';
  if (ks[id] !== bridgeKey) {
    ks[id] = bridgeKey;
    saveJson(KEYS_FILE, ks);
    log(`bridge: ключ провайдера ${id} синхронизирован с настройками моста`);
  }

  // в авто-выборе мост идёт после бесплатных API, но до локальных моделей
  const disk2 = loadJson(CONFIG_FILE, {});
  if (!Array.isArray(disk2.autoPriority)) disk2.autoPriority = defaultConfig().autoPriority;
  if (!disk2.autoPriority.includes(id)) {
    const at = disk2.autoPriority.findIndex((x) => x === 'ollama' || x === 'lmstudio');
    if (at === -1) disk2.autoPriority.push(id); else disk2.autoPriority.splice(at, 0, id);
    saveJson(CONFIG_FILE, disk2);
  }

  // модель по умолчанию — из живого списка моста (первая qwen/web)
  const fresh = loadConfig();
  const p = providerCfg(fresh, id);
  const key = (loadKeys()[id] || {}).key || b.apiKey;
  let live = null;
  try { live = await fetchProviderModels(p, key); } catch {}
  if (live && live.length) {
    const excl = p.modelExclude ? new RegExp(p.modelExclude, 'i') : null;
    const usable = live.filter((m) => !(excl && excl.test(m)));
    const disk3 = loadJson(CONFIG_FILE, {});
    const curModel = disk3.providers[id] && disk3.providers[id].defaultModel;
    if (!curModel || !usable.includes(curModel)) {
      const pick = usable.find((m) => /^qwen-web\//i.test(m))
        || usable.find((m) => /^qwen-proxy\//i.test(m))
        || usable.find((m) => /qwen|web/i.test(m))
        || usable[0];
      if (pick && pick !== curModel) {
        disk3.providers[id].defaultModel = pick;
        saveJson(CONFIG_FILE, disk3);
        log(`bridge: defaultModel = ${pick}`);
      }
    }
  }
  await modelsIndex(loadConfig(), loadKeys(), true).catch(() => {});
  return { id, models: live ? live.length : 0 };
}

async function ensureBridgeRunning(cfg, opts = {}) {
  const b = bridgeCfg(cfg);
  if (!b.enabled) return { ok: false, error: 'мост выключен', providerId: null };
  if (!bridgeAvailable(b)) return { ok: false, error: 'каталог chat-bridge не найден', providerId: null };
  let health = await bridgeHealth(b);
  if (!health) {
    startBridge(cfg);
    health = await waitBridge(b, opts.waitMs || 45000);
  }
  const reg = await ensureBridgeProvider(cfg, b);
  return { ok: !!health, providerId: reg.id, models: reg.models, health,
    error: health ? undefined : 'мост не поднялся, смотри лог' };
}

function bridgeWatch(cfg) {
  const b = bridgeCfg(cfg);
  if (!b.enabled || !b.autoStart || !bridgeAvailable(b)) return;
  if (bridgeProc || Date.now() < bridgeRetryAt) return;
  bridgeHealth(b).then((h) => {
    if (h) { ensureBridgeProvider(loadConfig(), b).catch(() => {}); return; }
    return ensureBridgeRunning(loadConfig(), { waitMs: 20000 }).then((r) => {
      if (r.ok) bridgeFailures = 0;
      else throw new Error(r.error || 'не поднялся');
    }).catch((e) => {
      bridgeFailures++;
      bridgeRetryAt = Date.now() + Math.min(300000, 15000 * 2 ** Math.min(bridgeFailures, 4));
      log(`bridge: автозапуск не удался (${bridgeFailures}): ${e.message}`);
    });
  }).catch(() => {});
}

function spawnBridgeLogin(cfg) {
  const b = bridgeCfg(cfg);
  const script = path.join(b.dir || '', 'scripts', 'qwen-login.mjs');
  if (!fs.existsSync(script)) throw new Error('не найден scripts/qwen-login.mjs в ' + (b.dir || '—'));
  const node = resolveNode();
  if (!node) throw new Error('не найден node.exe');
  const env = {
    ...process.env,
    BRIDGE_DATA_DIR: path.join(b.dir, 'data'),
    QWEN_WEB_PROFILE_DIR: path.join(b.dir, 'data', 'qwen-profile'),
  };
  if (process.platform === 'win32') {
    // Раздельные аргументы: node квотит только аргументы с пробелами, и cmd.exe
    // получает чистую команду. Одна строка с вложенными кавычками ломается
    // (cmd не понимает \"), цепочка с `start` и заголовком окна — тем более.
    const child = spawn('cmd.exe', ['/k', 'cd', '/d', b.dir, '&&', node, 'scripts\\qwen-login.mjs'], {
      env, detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.unref();
    log('bridge: открыто окно входа в Qwen, профиль ' + path.join(b.dir, 'data', 'qwen-profile'));
    return { ok: true, window: true, profile: path.join(b.dir, 'data', 'qwen-profile') };
  }
  throw new Error(`интерактивный вход доступен из терминала: cd ${b.dir} && node scripts/qwen-login.mjs`);
}

async function bridgeStatus(cfg) {
  const b = bridgeCfg(cfg);
  const health = bridgeAvailable(b) ? await bridgeHealth(b, 1200) : null;
  const running = !!bridgeProc || !!health;
  const id = bridgeProviderId(cfg, b);
  const p = providerCfg(cfg, id);
  const k = loadKeys()[id];
  const profile = path.join(b.dir || '', 'data', 'qwen-profile');
  return {
    ok: true,
    enabled: b.enabled,
    autoStart: b.autoStart,
    running,
    healthy: !!health,
    managed: !!bridgeProc,
    pid: bridgeProc ? bridgeProc.pid : portPid(b.port),
    port: b.port,
    dir: b.dir,
    dirExists: !!b.dir && fs.existsSync(b.dir),
    available: bridgeAvailable(b),
    node: !!resolveNode(),
    providerId: id,
    hasKey: !!k,
    defaultModel: p.defaultModel || null,
    qwenWeb: b.qwenWeb !== false,
    qwenProfile: fs.existsSync(profile),
    entry: bridgeEntry(b),
    logFile: BRIDGE_LOG,
    models: health ? health.models : null,
    providers: health ? health.providers : [],
    startedAt: bridgeStartedAt || null,
    lastError: bridgeLastError || null,
  };
}

// Базовый URL с подстановкой {{accountId}} (Cloudflare и подобные)
function effectiveBaseURL(p) {
  if (!p.baseURL) return null;
  if (p.baseURL.includes('{{accountId}}')) {
    return p.accountId ? p.baseURL.replace('{{accountId}}', String(p.accountId)) : null;
  }
  return p.baseURL;
}

// ---------------------------------------------------------------------------
// Индекс моделей: живой список провайдера замещает каталог (каталог — фолбэк
// без ключа), кэш обновляется по таймеру и персистится между перезапусками

let modelsCache = { at: 0, data: null };
const MODELS_CACHE_FILE = path.join(DIR, 'models-cache.json');

function loadPersistedModels() {
  const d = loadJson(MODELS_CACHE_FILE, null);
  if (d && d.at && d.detail && d.index) {
    modelsCache = { at: d.at, data: { index: new Map(Object.entries(d.index)), detail: d.detail } };
  }
}
function persistModels() {
  if (!modelsCache.data) return;
  try {
    saveJson(MODELS_CACHE_FILE, {
      at: modelsCache.at,
      index: Object.fromEntries(modelsCache.data.index),
      detail: modelsCache.data.detail,
    });
  } catch {}
}

async function fetchProviderModels(p, key) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(effectiveBaseURL(p).replace(/\/$/, '') + '/models', {
      headers: { Authorization: 'Bearer ' + key },
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return (j.data || []).map((m) => m.id).filter(Boolean);
  } catch { return null; }
}

async function modelsIndex(cfg, keys, force = false) {
  if (!force && modelsCache.data && Date.now() - modelsCache.at < cfg.modelsCacheMs) {
    return modelsCache.data;
  }
  const index = new Map(); // modelId -> [providerId...]
  const detail = [];
  const detailIds = new Set();
  const add = (bare, pid) => {
    push(index, bare, pid);
    const full = pid + '/' + bare;
    if (!detailIds.has(full)) { detailIds.add(full); detail.push({ id: full, owned_by: pid, tools: true }); }
  };
  const liveProviders = [];
  await Promise.all(allProviders(cfg).map(async (p) => {
    const rec = keys[p.id];
    let live = null;
    if (rec && p.baseURL) live = await fetchProviderModels(p, rec.key);
    if (live && live.length) {
      liveProviders.push(p.id);
      const excl = p.modelExclude ? new RegExp(p.modelExclude, 'i') : null;
      for (const id of live) {
        if (excl && excl.test(id)) continue;
        if (p.id === 'openrouter' && !/:free$/.test(id)) continue; // у OR берём только :free
        add(id, p.id);
      }
    } else {
      for (const m of p.models || []) if (m.tools) add(m.id, p.id); // фолбэк: каталог
    }
  }));
  modelsCache = { at: Date.now(), data: { index, detail } };
  persistModels();
  if (force) log(`models: обновлено ${modelsCache.data.detail.length} моделей; live-списки: ${liveProviders.join(', ') || '—'}`);
  return modelsCache.data;
}
function push(map, k, v) {
  if (!map.has(k)) map.set(k, []);
  if (!map.get(k).includes(v)) map.get(k).push(v);
}

// ---------------------------------------------------------------------------
// Роутинг и прокси

function resolveCandidates(model, cfg, keys, idx) {
  // возвращает [{provider, upstreamModel}], в порядке приоритета
  const byPriority = (a, b) =>
    (cfg.autoPriority.indexOf(a.id) === -1 ? 999 : cfg.autoPriority.indexOf(a.id)) -
    (cfg.autoPriority.indexOf(b.id) === -1 ? 999 : cfg.autoPriority.indexOf(b.id));
  const providers = allProviders(cfg).filter((p) => keys[p.id] && effectiveBaseURL(p));

  if (model === 'free' || model === 'auto') {
    return providers.sort(byPriority)
      .map((p) => ({ provider: p, upstreamModel: p.defaultModel }));
  }
  const slash = model.indexOf('/');
  if (slash > 0) {
    const pid = model.slice(0, slash), rest = model.slice(slash + 1);
    const p = providers.find((x) => x.id === pid);
    if (p) return [{ provider: p, upstreamModel: rest }];
    const byBare = idx.index.get(model); // случай 'meta-llama/...:free' без префикса провайдера
    if (byBare) return byBare.map((id2) => ({
      provider: providers.find((x) => x.id === id2), upstreamModel: model,
    })).filter((x) => x.provider);
    return [];
  }
  const ids = idx.index.get(model) || [];
  return ids.map((id2) => providers.find((x) => x.id === id2))
    .filter(Boolean).sort(byPriority)
    .map((p) => ({ provider: p, upstreamModel: model }));
}

// Обрезка изображений в истории под лимит провайдера: остаются ПОСЛЕДНИЕ maxImages,
// более старые заменяются текстовой пометкой (иначе апстримы отдают
// "too many image inputs" и клиент зависает в ретраях)
function countImages(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (Array.isArray(m.content)) for (const p of m.content) if (p.type === 'image_url') n++;
  }
  return n;
}
function trimImages(messages, maxImages) {
  const total = countImages(messages);
  if (total <= maxImages) return messages;
  let seen = 0;
  const keepFrom = total - maxImages; // первые keepFrom картинок по порядку вырезаем
  const out = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const parts = m.content.map((p) => {
      if (p.type !== 'image_url') return p;
      const idx = seen++;
      return idx < keepFrom
        ? { type: 'text', text: '[изображение удалено из истории: превышен лимит картинок провайдера]' }
        : p;
    });
    return { ...m, content: parts };
  });
  return out;
}

function buildUpstreamBody(provider, body) {
  const allowed = new Set([...ALWAYS_PASSED, ...((provider.allowedParams || []).length
    ? provider.allowedParams : BASE_ALLOWED)]);
  const out = {};
  for (const k of Object.keys(body)) if (allowed.has(k)) out[k] = body[k];
  // 'stream_options' имеет смысл только вместе со стримом
  if (out.stream_options && !out.stream) delete out.stream_options;
  return out;
}

async function proxyChat(req, res, cfg, keys, idx) {
  let raw;
  try {
    raw = await readBody(req, 20 * 1024 * 1024);
  } catch (e) {
    if (e.code === 'BODY_TOO_LARGE') {
      const msg = JSON.stringify({
        error: { message: 'request body too large (limit 20 MB)', type: 'invalid_request_error' },
      });
      res.writeHead(413, {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(msg), 'connection': 'close',
      });
      res.end(msg, () => { try { req.destroy(); } catch {} });
      return;
    }
    throw e;
  }
  let body;
  try { body = JSON.parse(raw); } catch {
    return sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
  }
  if (!body.model || !Array.isArray(body.messages)) {
    return sendJson(res, 400, { error: { message: 'model and messages required', type: 'invalid_request_error' } });
  }
  const candidates = resolveCandidates(body.model, cfg, keys, idx);
  if (!candidates.length) {
    return sendJson(res, 404, {
      error: {
        message: `нет провайдера с ключом для модели "${body.model}". Доступно: ${idx.detail.slice(0, 40).map((m) => m.id).join(', ')}… Полный список: GET /v1/models. Ключи: freehub open / freehub key set`,
        type: 'invalid_request_error',
      },
    });
  }

  const t0 = Date.now();
  const errors = [];
  for (const cand of candidates) {
    const { provider, upstreamModel } = cand;
    const key = keys[provider.id].key;
      const upBody = buildUpstreamBody(provider, { ...body, model: upstreamModel });
      const clientStream = !!upBody.stream;
      // в режим synthesize апстриму stream не отправляем — нам нужен полный JSON
      if (clientStream && provider.streamMode === 'synthesize') {
        delete upBody.stream;
        delete upBody.stream_options;
      }
      // лимит картинок: обрезаем старые из истории (иначе 400 "too many image inputs")
      if (provider.maxImages !== undefined) {
        const n = countImages(upBody.messages || []);
        if (n > provider.maxImages) {
          upBody.messages = trimImages(upBody.messages, provider.maxImages);
          log(`${provider.id}: картинок в истории ${n} -> ${provider.maxImages} (обрезано)`);
        }
      }
    // ретраи одного провайдера (например, pollinations: 1 ответ / 30 сек на IP -> HTTP 402/429)
    const retryCfg = provider.retry || { attempts: 0 };
    const attemptsTotal = (retryCfg.attempts || 0) + 1;
    let served = false;
    // ОДИН close-обработчик на запрос: прерывает текущую попытку, не плодит дубликаты
    let activeAc = null;
    const onClose = () => { if (activeAc) { try { activeAc.abort(); } catch {} } };
    res.on('close', onClose);
    for (let attempt = 1; attempt <= attemptsTotal && !served; attempt++) {
      const ac = new AbortController();
      activeAc = ac;
      const timer = setTimeout(() => ac.abort(), cfg.requestTimeoutMs);
      let up;
      try {
        up = await fetch(effectiveBaseURL(provider).replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(upBody),
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        activeAc = null;
        if (res.writableEnded || res.destroyed) return; // клиент уже ушёл — не ретраим
        errors.push(`${provider.id}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
        break; // сетевая ошибка -> следующий провайдер
      }
      clearTimeout(timer);
      if (!up.ok) {
        const errText = await up.text().catch(() => '');
        const retryable = (retryCfg.statuses || []).includes(up.status);
        if (retryable && attempt < attemptsTotal) {
          log(`${provider.id}: HTTP ${up.status}, ретрай ${attempt}/${retryCfg.attempts} через ${retryCfg.delayMs}ms`);
          await new Promise((r) => setTimeout(r, retryCfg.delayMs));
          continue;
        }
        errors.push(`${provider.id}: HTTP ${up.status} ${errText.slice(0, 300)}`);
        break; // следующий провайдер
      }
      // успех
      activeAc = null;
      res.setHeader('x-freehub-provider', provider.id);
      res.setHeader('x-freehub-model', upstreamModel);
      res.setHeader('access-control-expose-headers', 'x-freehub-provider, x-freehub-model');
      // streamMode 'synthesize': у апстрима запрошен полный JSON (без stream),
      // клиенту отдаём корректно собранный SSE — лечит апстримы с кривыми tool_call-дельтами
      if (clientStream && provider.streamMode === 'synthesize') {
        const j = await up.json().catch((e) => {
          log(`chat ${provider.id}: synthesize-чтение прервано (${e.name || e.message})`);
          return null;
        });
        if (!j) return; // клиент оборвал соединение — не ошибка сервиса
        emitSyntheticSSE(res, j, provider, upstreamModel, body.model, t0);
        return;
      }
      if (clientStream && up.body) {
        res.writeHead(200, {
          'content-type': 'text/event-stream', 'cache-control': 'no-cache',
          'x-freehub-provider': provider.id, 'x-freehub-model': upstreamModel,
        });
        log(`chat model=${body.model} -> ${provider.id}/${upstreamModel} stream ok ${Date.now() - t0}ms`);
        const reader = up.body.getReader();
        const onClose = () => { try { reader.cancel(); } catch {} };
        res.on('close', onClose);
        (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!res.write(Buffer.from(value))) {
                await new Promise((r) => res.once('drain', r));
              }
            }
          } catch {} // обрыв клиента/апстрима
          res.end();
        })();
        return;
      }
      const data = Buffer.from(await up.arrayBuffer());
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-freehub-provider': provider.id, 'x-freehub-model': upstreamModel,
      });
      res.end(data);
      log(`chat model=${body.model} -> ${provider.id}/${upstreamModel} ok ${Date.now() - t0}ms`);
      return;
    }
  }
  sendJson(res, 502, {
    error: {
      message: 'все провайдеры недоступны: ' + errors.join(' | '),
      type: 'api_error',
    },
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        settled = true;
        const e = new Error('body too large');
        e.code = 'BODY_TOO_LARGE';
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

function sendJson(res, code, obj) {
  if (res.headersSent) { res.end(); return; }
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

// Полный JSON-ответ -> синтетический SSE-поток корректной формы для клиента
function emitSyntheticSSE(res, j, provider, upstreamModel, askedModel, t0) {
  res.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-cache',
    'x-freehub-provider': provider.id, 'x-freehub-model': upstreamModel,
  });
  const base = {
    id: j.id || 'freehub', object: 'chat.completion.chunk',
    created: j.created || Math.floor(Date.now() / 1000), model: j.model || upstreamModel,
  };
  const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
  const chunk = (delta, finish = null) =>
    send({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
  const msg = j.choices?.[0]?.message || {};
  chunk({ role: 'assistant', content: msg.content ?? null });
  for (const [i, tc] of (msg.tool_calls || []).entries()) {
    chunk({
      tool_calls: [{
        index: i, id: tc.id || 'call_' + i, type: 'function',
        function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' },
      }],
    });
  }
  chunk({}, j.choices?.[0]?.finish_reason ?? 'stop');
  if (j.usage) send({ ...base, choices: [], usage: j.usage });
  res.write('data: [DONE]\n\n');
  res.end();
  log(`chat model=${askedModel} -> ${provider.id}/${upstreamModel} sse(synth) ok ${Date.now() - t0}ms`);
}

// ---------------------------------------------------------------------------
// HTTP сервер

// ---------------------------------------------------------------------------
// Защита управляющего API: браузерные запросы к /api/* принимаются только с
// того же origin, а Host должен быть локальным — иначе чужая веб-страница
// могла бы менять ключи, добавлять провайдеров и останавливать мост.

function allowedHostSet(cfg) {
  const port = Number(cfg.port) || 8787;
  const hosts = new Set();
  const add = (h) => { if (h) hosts.add(String(h).toLowerCase()); };
  for (const h of ['127.0.0.1', 'localhost', '[::1]']) add(`${h}:${port}`);
  if (cfg.host && cfg.host !== '0.0.0.0' && cfg.host !== '::') add(`${cfg.host}:${port}`);
  for (const h of (Array.isArray(cfg.trustedHosts) ? cfg.trustedHosts : [])) {
    const v = String(h).trim().toLowerCase();
    if (!v) continue;
    add(v.includes(':') ? v : `${v}:${port}`);
  }
  for (const h of [...hosts]) if (h.endsWith(':80')) add(h.slice(0, -3));
  return hosts;
}
function hostAllowed(req, cfg) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return true; // HTTP/1.0 или нестандартный клиент без Host
  return allowedHostSet(cfg).has(host);
}
function originAllowed(req, cfg) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl и серверные клиенты Origin не шлют
  if (origin === 'null') return false; // file:// и sandboxed iframe
  try {
    return allowedHostSet(cfg).has(new URL(origin).host.toLowerCase());
  } catch { return false; }
}

function startServer(cfg) {
  // локальный прокси обязан переживать любые ошибки: логируем и живём дальше
  process.on('uncaughtException', (e) => log(`uncaught: ${e.stack || e}`));
  process.on('unhandledRejection', (e) => log(`unhandledRejection: ${(e && (e.stack || e.message)) || e}`));
  const server = http.createServer(async (req, res) => {
    // ключи и конфиг перечитываем на каждый запрос — изменения подхватываются без рестарта
    const keys = loadKeys();
    cfg = loadConfig();
    const url = (req.url || '/').split('?')[0];
    const query = new URLSearchParams((req.url || '').split('?')[1] || '');
    const isApi = url === '/api' || url.startsWith('/api/');
    const isOpenAi = url === '/v1' || url.startsWith('/v1/') || url === '/models' || url === '/chat/completions';

    // Управляющий API — только same-origin и только локальный Host.
    if (isApi && (!hostAllowed(req, cfg) || !originAllowed(req, cfg))) {
      return sendJson(res, 403, {
        ok: false,
        error: 'cross-origin request to /api is not allowed; open the freehub UI at ' +
          `http://${cfg.host}:${cfg.port}/ instead`,
      });
    }
    if (isOpenAi) {
      res.setHeader('access-control-allow-origin', cfg.corsOrigin || '*');
      res.setHeader('access-control-allow-headers', '*');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      if (req.method === 'GET' && (url === '/healthz')) {
        return sendJson(res, 200, { ok: true, version: VERSION, providers: Object.keys(keys).length });
      }
      if (req.method === 'GET' && url === '/') {
        return statusPage(res, cfg, keys);
      }
      if (req.method === 'GET' && url === '/api/status') {
        const every = [...new Set([...DEFAULT_PROVIDERS.map((p) => p.id), ...Object.keys(cfg.providers)])];
        return sendJson(res, 200, {
          ok: true, version: VERSION, baseUrl: `http://${cfg.host}:${cfg.port}/v1`,
          modelsUpdatedAt: modelsCache.at || 0,
          providers: every.map((id) => {
            const p = providerCfg(cfg, id);
            const k = keys[id];
            return {
              id, label: p.label || id, free: p.free || '',
              consoleUrl: p.consoleUrl || '', defaultModel: p.defaultModel,
              hasKey: !!k, keyMask: k ? mask(k.key) : null, source: k ? k.source : null,
              enabled: p.enabled !== false,
              managed: p.managedBy === 'freehub',
              custom: !DEFAULT_PROVIDERS.some((x) => x.id === id),
            };
          }),
        });
      }
      if (req.method === 'GET' && url === '/api/bridge') {
        return sendJson(res, 200, await bridgeStatus(cfg));
      }
      if (req.method === 'POST' && url === '/api/bridge/start') {
        const r = await ensureBridgeRunning(cfg, { waitMs: 45000 });
        const st = await bridgeStatus(loadConfig());
        return sendJson(res, 200, { ...st, ok: r.ok, error: r.error });
      }
      if (req.method === 'POST' && url === '/api/bridge/stop') {
        const r = stopBridge(cfg);
        const st = await bridgeStatus(loadConfig());
        if (!r.stopped && r.reason === 'foreign-process') {
          return sendJson(res, 409, {
            ...st, ok: false, stopped: false, reason: r.reason,
            error: `порт ${st.port} занят посторонним процессом (pid ${r.pid}); остановка отменена`,
          });
        }
        return sendJson(res, 200, { ...st, ok: true, stopped: r.stopped, reason: r.reason });
      }
      if (req.method === 'POST' && url === '/api/bridge/restart') {
        const stopped = stopBridge(cfg);
        if (!stopped.stopped && stopped.reason === 'foreign-process') {
          return sendJson(res, 409, {
            ok: false, error: `порт занят посторонним процессом (pid ${stopped.pid}); перезапуск отменён`,
          });
        }
        await new Promise((r) => setTimeout(r, 800));
        const r = await ensureBridgeRunning(cfg, { waitMs: 45000 });
        const st = await bridgeStatus(loadConfig());
        return sendJson(res, 200, { ...st, ok: r.ok, error: r.error });
      }
      if (req.method === 'POST' && url === '/api/bridge/login') {
        try {
          return sendJson(res, 200, { ok: true, ...spawnBridgeLogin(cfg) });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: e.message });
        }
      }
      if (req.method === 'POST' && url === '/api/bridge/refresh') {
        await modelsIndex(loadConfig(), loadKeys(), true);
        const st = await bridgeStatus(loadConfig());
        return sendJson(res, 200, { ...st, ok: true });
      }
      if (req.method === 'POST' && url === '/api/bridge/config') {
        const b = JSON.parse(await readBody(req, 100000));
        const disk = loadJson(CONFIG_FILE, {});
        const prev = { ...defaultConfig().bridge, ...(disk.bridge || {}) };
        const next = { ...prev };
        if (typeof b.dir === 'string') {
          const dir = b.dir.trim();
          if (dir && !fs.existsSync(dir)) {
            return sendJson(res, 400, { ok: false, error: 'каталог не найден: ' + dir });
          }
          next.dir = dir ? path.resolve(dir) : '';
        }
        if (b.port !== undefined) {
          const port = Number(b.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return sendJson(res, 400, { ok: false, error: 'порт: 1–65535' });
          }
          next.port = port;
        }
        if (typeof b.apiKey === 'string' && b.apiKey.trim()) next.apiKey = b.apiKey.trim();
        if (b.autoStart !== undefined) next.autoStart = !!b.autoStart;
        if (b.qwenWeb !== undefined) next.qwenWeb = !!b.qwenWeb;
        if (b.enabled !== undefined) next.enabled = !!b.enabled;
        disk.bridge = next;
        saveJson(CONFIG_FILE, disk);
        // ключ моста — в keys.json управляемого провайдера
        const fresh = loadConfig();
        const id = bridgeProviderId(fresh, bridgeCfg(fresh));
        const ks = loadJson(KEYS_FILE, {});
        if (!ks[id] || next.apiKey !== prev.apiKey) {
          ks[id] = next.apiKey;
          saveJson(KEYS_FILE, ks);
        }
        log(`bridge: настройки сохранены (dir=${next.dir || '—'}, port=${next.port}, autoStart=${next.autoStart})`);
        const st = await bridgeStatus(loadConfig());
        return sendJson(res, 200, { ...st, ok: true, note: 'чтобы применить каталог/порт, перезапусти мост' });
      }
      if (req.method === 'GET' && url === '/api/bridge/log') {
        let text = '';
        try {
          const lines = fs.readFileSync(BRIDGE_LOG, 'utf8').trimEnd().split('\n');
          text = lines.slice(-Math.min(300, Number(query.get('limit')) || 200)).join('\n');
        } catch { text = '(лог моста пуст)'; }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(text);
      }
      if (req.method === 'POST' && url === '/api/keys') {
        const b = JSON.parse(await readBody(req, 100000));
        if (!b.id || !b.key || !allProviders(cfg).some((p) => p.id === b.id)) {
          return sendJson(res, 400, { ok: false, error: 'нужны id провайдера и key' });
        }
        const store = loadJson(KEYS_FILE, {});
        store[b.id] = String(b.key).trim();
        saveJson(KEYS_FILE, store);
        log(`key set ${b.id} = ${mask(String(b.key))} (через /api/keys)`);
        return sendJson(res, 200, { ok: true, id: b.id, keyMask: mask(String(b.key)) });
      }
      if (req.method === 'POST' && url === '/api/providers') {
        const b = JSON.parse(await readBody(req, 100000));
        const id = String(b.id || '').trim().toLowerCase();
        const baseURL = String(b.baseURL || '').trim().replace(/\/+$/, '');
        const key = String(b.key || '').trim();
        if (!/^[a-z0-9][a-z0-9_-]{1,23}$/.test(id)) {
          return sendJson(res, 400, { ok: false, error: 'id: латиница/цифры/-/_, 2–24 символа' });
        }
        if (DEFAULT_PROVIDERS.some((p) => p.id === id)) {
          return sendJson(res, 400, { ok: false, error: 'id "' + id + '" занят встроенным провайдером' });
        }
        if (!/^https?:\/\//.test(baseURL)) {
          return sendJson(res, 400, { ok: false, error: 'нужен base URL http(s)://… (обычно заканчивается на /v1)' });
        }
        if (!key) {
          return sendJson(res, 400, { ok: false, error: 'нужен ключ (если сервер без авторизации — любое слово, например x)' });
        }
        const disk = loadJson(CONFIG_FILE, {});
        disk.providers = disk.providers || {};
        const entry = { label: String(b.label || id).slice(0, 60), baseURL, maxImages: 8 };
        if (String(b.defaultModel || '').trim()) entry.defaultModel = String(b.defaultModel).trim();
        disk.providers[id] = entry;
        saveJson(CONFIG_FILE, disk);
        const ks = loadJson(KEYS_FILE, {});
        ks[id] = key;
        saveJson(KEYS_FILE, ks);
        log(`provider add ${id} -> ${baseURL}`);
        // сразу подтянуть живой /models нового провайдера: модели появляются мгновенно,
        // без дефолтную модель берём первую из живого списка
        const fresh = loadConfig();
        const p = providerCfg(fresh, id);
        let discovered = 0;
        try {
          const live = await fetchProviderModels(p, loadKeys()[id].key);
          if (live && live.length) {
            discovered = live.length;
            const excl = p.modelExclude ? new RegExp(p.modelExclude, 'i') : null;
            if (modelsCache.data) {
              for (const mid of live) {
                if (excl && excl.test(mid)) continue;
                push(modelsCache.data.index, mid, id);
                const full = id + '/' + mid;
                if (!modelsCache.data.detail.some((d) => d.id === full)) {
                  modelsCache.data.detail.push({ id: full, owned_by: id, tools: true });
                }
              }
              persistModels();
            }
            const disk2 = loadJson(CONFIG_FILE, {});
            if (!disk2.providers[id].defaultModel) {
              disk2.providers[id].defaultModel = live.find((m) => !(excl && excl.test(m))) || live[0];
              saveJson(CONFIG_FILE, disk2);
              log(`provider add ${id}: defaultModel = ${disk2.providers[id].defaultModel}`);
            }
          }
        } catch (e) {
          log(`provider add ${id}: живой список не получен (${e.message}) — останется каталог`);
        }
        log(`provider add ${id}: моделей обнаружено ${discovered}`);
        modelsIndex(loadConfig(), loadKeys(), true).catch(() => {});
        return sendJson(res, 200, {
          ok: true, id, discovered,
          defaultModel: providerCfg(loadConfig(), id).defaultModel || null,
        });
      }
      if (req.method === 'POST' && url === '/api/providers/remove') {
        const b = JSON.parse(await readBody(req, 10000));
        const id = String(b.id || '');
        if (DEFAULT_PROVIDERS.some((p) => p.id === id)) {
          return sendJson(res, 400, { ok: false, error: 'встроенного провайдера нельзя удалить — только выключить' });
        }
        const disk = loadJson(CONFIG_FILE, {});
        if (disk.providers) delete disk.providers[id];
        saveJson(CONFIG_FILE, disk);
        const ks = loadJson(KEYS_FILE, {});
        delete ks[id];
        saveJson(KEYS_FILE, ks);
        if (modelsCache.data) {
          for (const [k, arr] of modelsCache.data.index) {
            const rest = arr.filter((x) => x !== id);
            if (rest.length) modelsCache.data.index.set(k, rest); else modelsCache.data.index.delete(k);
          }
          modelsCache.data.detail = modelsCache.data.detail.filter((d) => d.owned_by !== id);
          persistModels();
        }
        log(`provider remove ${id}`);
        modelsIndex(loadConfig(), loadKeys(), true).catch(() => {});
        return sendJson(res, 200, { ok: true, id });
      }
      if (req.method === 'GET' && url === '/api/test') {
        return apiTest(res, cfg, keys, query.get('id'));
      }
      if (req.method === 'GET' && url === '/api/log') {
        let text = '';
        try {
          const lines = fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n');
          text = lines.slice(-Math.min(200, Number(query.get('limit')) || 200)).join('\n');
        } catch { text = '(лог пуст)'; }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(text);
      }
      if (req.method === 'POST' && url === '/api/toggle') {
        const b = JSON.parse(await readBody(req, 10000));
        const known = [...DEFAULT_PROVIDERS.map((p) => p.id), ...Object.keys(cfg.providers)];
        if (!b.id || !known.includes(b.id)) {
          return sendJson(res, 400, { ok: false, error: 'нет провайдера ' + b.id });
        }
        const disk = loadJson(CONFIG_FILE, {});
        disk.providers = disk.providers || {};
        disk.providers[b.id] = { ...(disk.providers[b.id] || {}), enabled: !!b.enabled };
        saveJson(CONFIG_FILE, disk);
        log(`toggle ${b.id}: enabled=${!!b.enabled}`);
        return sendJson(res, 200, { ok: true, id: b.id, enabled: !!b.enabled });
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
        const idx = await modelsIndex(cfg, keys, req.headers['x-refresh-cache'] === '1');
        return sendJson(res, 200, {
          object: 'list',
          data: [{ id: 'free', object: 'model', owned_by: 'freehub' }, ...idx.detail],
        });
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
        const idx = await modelsIndex(cfg, keys);
        return await proxyChat(req, res, cfg, keys, idx);
      }
      sendJson(res, 404, { error: { message: `нет роута ${req.method} ${url}; основное: POST /v1/chat/completions, GET /v1/models`, type: 'invalid_request_error' } });
    } catch (e) {
      log(`error ${req.method} ${url}: ${e.message}`);
      sendJson(res, 500, { error: { message: String(e.message || e), type: 'internal_error' } });
    }
  });
  server.listen(cfg.port, cfg.host, () => {
    log(`freehub слушает http://${cfg.host}:${cfg.port}/v1 (провайдеров с ключами: ${Object.keys(loadKeys()).length})`);
    if (Object.keys(loadKeys()).length === 0 && cfg.autoOpenOnFirstRun) {
      console.log('\nКлючей пока нет — открываю консоли бесплатных сервисов за API-ключами.');
      console.log('Забери ключ и сохрани:  freehub key set groq gsk_...\n');
      openConsoles(cfg, ['groq', 'gemini', 'cerebras', 'mistral', 'openrouter']);
    }
    // индекс моделей: восстановить из персиста и обновлять в фоне по таймеру
    loadPersistedModels();
    modelsIndex(cfg, loadKeys(), true).catch(() => {});
    const refreshMs = cfg.modelsRefreshMs || 600000;
    setInterval(() => {
      const c = loadConfig();
      modelsIndex(c, loadKeys(), true).catch(() => {});
    }, refreshMs);
    log(`модели: автообновление каждые ${Math.round(refreshMs / 60000)} мин`);
    // мост веб-чатов: поднять при старте и следить за ним
    const bc = bridgeCfg(cfg);
    if (bc.enabled && bc.autoStart && bridgeAvailable(bc)) {
      log(`bridge: автозапуск (${bc.dir} -> ${bridgeBase(bc)})`);
      ensureBridgeRunning(cfg, { waitMs: 30000 })
        .then((r) => log(r.ok ? `bridge: работает, провайдер ${r.providerId}, моделей ${r.models}` : `bridge: ${r.error}`))
        .catch((e) => log(`bridge: автозапуск не удался: ${e.message}`));
      setInterval(() => bridgeWatch(loadConfig()), 30000);
    } else if (bc.enabled) {
      log('bridge: не найден chat-bridge (bridge.dir), мост не запущен');
    }
  });
  server.on('error', (e) => {
    console.error(`Не удалось слушать ${cfg.host}:${cfg.port}: ${e.message}`);
    process.exit(1);
  });
}

// Быстрый tool-calling пинг конкретного провайдера (для кнопки на дашборде)
async function apiTest(res, cfg, keys, id) {
  const p = allProviders(cfg).find((x) => x.id === id);
  const k = keys[id];
  if (!p || !k) return sendJson(res, 400, { ok: false, error: 'нет провайдера или ключа: ' + id });
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 150000);
    const up = await fetch(effectiveBaseURL(p).replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + k.key },
      body: JSON.stringify({
        model: p.defaultModel,
        messages: [{ role: 'user', content: 'What is the weather in Moscow? Call the get_weather tool.' }],
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
      }),
      signal: ac.signal,
    });
    clearTimeout(t);
    const j = await up.json().catch(() => ({}));
    const tc = j.choices?.[0]?.message?.tool_calls || [];
    log(`api-test ${id}: HTTP ${up.status} tools=${tc.length} ${Date.now() - t0}ms`);
    return sendJson(res, 200, {
      ok: up.ok && tc.length > 0, status: up.status, provider: id, model: p.defaultModel,
      toolCalled: tc.length > 0, tool: tc[0]?.function?.name || null,
      error: up.ok ? undefined : String(j.error?.message || '').slice(0, 200), ms: Date.now() - t0,
    });
  } catch (e) {
    return sendJson(res, 200, { ok: false, provider: id, error: e.message, ms: Date.now() - t0 });
  }
}

function statusPage(res, cfg) {
  const base = `http://${cfg.host}:${cfg.port}/v1`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>freehub</title>
<style>
:root{--bg:#0d1117;--pan:#161b22;--brd:#30363d;--fg:#e6edf3;--mut:#8b949e;--acc:#58a6ff;--ok:#3fb950;--err:#f85149;--warn:#d29922;--pri:#1f6feb}
*{box-sizing:border-box}body{font-family:system-ui,'Segoe UI',sans-serif;margin:0;background:var(--bg);color:var(--fg)}
header{padding:1rem 1.5rem .75rem;border-bottom:1px solid var(--brd);display:flex;flex-wrap:wrap;gap:.75rem;align-items:baseline}
header h1{font-size:1.15rem;margin:0}header .sub{color:var(--mut);font-size:.85rem}
nav{display:flex;gap:.25rem;padding:.6rem 1.5rem 0;flex-wrap:wrap}
nav button{background:none;border:1px solid transparent;border-bottom:2px solid transparent;color:var(--mut);padding:.45rem .9rem;font-size:.9rem;cursor:pointer;border-radius:8px 8px 0 0}
nav button.active{color:var(--fg);border-bottom-color:var(--acc);background:var(--pan)}
main{padding:1rem 1.5rem;max-width:1200px}
section{display:none}section.on{display:block}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:.75rem}
.card{border:1px solid var(--brd);border-radius:10px;padding:.85rem 1rem;background:var(--pan)}
.card h3{margin:0;font-size:.95rem;display:flex;justify-content:space-between;gap:.5rem;align-items:center}
.tag{font-size:.7rem;padding:.12rem .5rem;border-radius:99px;border:1px solid var(--brd);color:var(--mut)}
.tag.free{color:var(--ok);border-color:#238636}.tag.trial{color:var(--warn);border-color:#9e6a03}.tag.off{color:var(--err)}.tag.bridge{color:#bc8cff;border-color:#8957e5}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:.4rem;background:#484f58}
.dot.on{background:var(--ok);box-shadow:0 0 6px var(--ok)}
.meta{color:var(--mut);font-size:.8rem;margin:.35rem 0 .6rem;word-break:break-all}
.row{display:flex;gap:.45rem;flex-wrap:wrap;align-items:center}
button.b,a.b{display:inline-block;font-size:.8rem;padding:.35rem .7rem;border-radius:7px;border:1px solid var(--brd);color:var(--acc);background:var(--bg);cursor:pointer;text-decoration:none}
button.b.pri{background:var(--pri);border-color:var(--pri);color:#fff}
button.b:disabled{opacity:.45;cursor:default}
input.t,select.t{font-size:.85rem;padding:.35rem .55rem;border-radius:7px;border:1px solid var(--brd);background:var(--bg);color:var(--fg)}
.result{font-size:.78rem;margin-top:.45rem;color:var(--mut)}.result.ok{color:var(--ok)}.result.err{color:var(--err)}
/* чат */
#chat-wrap{display:flex;flex-direction:column;height:calc(100vh - 220px);min-height:420px;border:1px solid var(--brd);border-radius:10px;background:var(--pan);overflow:hidden}
#chat-log{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.6rem}
.msg{max-width:85%;padding:.55rem .8rem;border-radius:12px;font-size:.9rem;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:var(--pri);color:#fff;border-bottom-right-radius:4px}
.msg.assistant{align-self:flex-start;background:#21262d;border-bottom-left-radius:4px}
.msg .tc{margin-top:.4rem;padding:.35rem .5rem;background:#0d1117;border:1px solid var(--brd);border-radius:7px;font-size:.78rem;color:var(--warn)}
#chat-bar{display:flex;gap:.5rem;padding:.6rem;border-top:1px solid var(--brd);flex-wrap:wrap}
#chat-in{flex:1;min-width:200px}
pre{background:#0d1117;border:1px solid var(--brd);border-radius:8px;padding:.75rem;overflow:auto;font-size:.8rem}
code{background:#21262d;border-radius:4px;padding:.08rem .35rem;font-size:.82rem}
h2{font-size:1rem} .muted{color:var(--mut);font-size:.85rem}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--brd);padding:.45rem .6rem;text-align:left;font-size:.85rem}
th{color:var(--mut);font-weight:500}
</style></head><body>
<header><h1>freehub</h1><span class="sub">${base} · model <code>free</code> — авто-выбор · <span id="hdr-status"></span></span></header>
<nav>
<button data-tab="providers" class="active">Провайдеры и ключи</button>
<button data-tab="bridge">Мост веб-чатов</button>
<button data-tab="chat">Чат (playground)</button>
<button data-tab="models">Модели</button>
<button data-tab="connect">Подключение</button>
<button data-tab="log">Лог</button>
</nav>
<main>
<section id="tab-providers" class="on">
<div class="row" style="margin-bottom:.6rem"><button class="b pri" id="prov-add">＋ Добавить своего провайдера</button><span class="muted" id="prov-add-result"></span></div>
<div id="prov-form" style="display:none;border:1px solid var(--brd);border-radius:10px;padding:.85rem 1rem;background:var(--pan);margin-bottom:.75rem">
<div class="row"><input class="t" id="np-id" placeholder="id: myprovider" style="width:170px">
<input class="t" id="np-label" placeholder="название" style="width:210px">
<input class="t" id="np-url" placeholder="base URL: https://api.example.com/v1" style="flex:1;min-width:240px"></div>
<div class="row" style="margin-top:.45rem"><input class="t" id="np-key" type="password" placeholder="API-ключ (если сервер без ключа — любое слово, напр. x)" style="flex:1;min-width:240px">
<input class="t" id="np-model" placeholder="модель по умолчанию (можно пусто)" style="width:250px">
<button class="b pri" id="np-save">Добавить</button></div>
<div class="muted" style="margin-top:.45rem">Подойдёт любой OpenAI-совместимый сервер (chat/completions + models). После добавления freehub сам подтянет все модели живым списком; если модель по умолчанию не указана — возьмёт первую обнаруженную.</div>
</div>
<div class="grid" id="prov-grid"></div>
<p class="muted" style="margin-top:.9rem">Войди в консоль сервиса (кнопка «Войти»), затем нажми «Подтянуть» — агент вытащит ключ из залогиненной вкладки через webkey. Или вставь ключ вручную. Ключи подхватываются без рестарта.</p></section>
<section id="tab-bridge">
<div class="row" style="margin-bottom:.6rem">
<span class="dot" id="br-dot"></span><b id="br-state">проверяю…</b>
<span class="muted" id="br-meta"></span>
<button class="b pri" id="br-start">Запустить</button>
<button class="b" id="br-stop">Остановить</button>
<button class="b" id="br-restart">Перезапустить</button>
<a class="b" id="br-ui" target="_blank" rel="noopener">Открыть UI моста</a>
<button class="b" id="br-login">Войти в Qwen</button>
<button class="b" id="br-refresh">Обновить модели</button>
</div>
<div class="card" style="margin-bottom:.75rem">
<h3>Настройки моста</h3>
<div class="row" style="margin-top:.5rem">
<input class="t" id="br-dir" placeholder="каталог chat-bridge" style="flex:1;min-width:280px">
<input class="t" id="br-port" placeholder="8789" style="width:90px">
<input class="t" id="br-key" type="password" placeholder="API-ключ моста" style="width:220px">
</div>
<div class="row" style="margin-top:.45rem">
<label class="muted"><input type="checkbox" id="br-auto"> автозапуск вместе с freehub</label>
<label class="muted"><input type="checkbox" id="br-qwen"> Qwen web (Playwright)</label>
<button class="b pri" id="br-save">Сохранить</button>
<span class="muted" id="br-save-result"></span>
</div>
<div class="muted" style="margin-top:.45rem">Мост — отдельный процесс chat-bridge с Chromium: freehub сам поднимает его, регистрирует как провайдера, тянет модели и ставит в авто-выбор перед локальными. Для бесплатного веб-чата Qwen нужен вход в профиль (кнопка «Войти в Qwen»), после входа перезапусти мост.</div>
</div>
<pre id="br-log">…</pre>
</section>
<section id="tab-chat">
<div class="row" style="margin-bottom:.6rem">
<select id="chat-model" class="t"><option value="free">free (авто-выбор)</option></select>
<label class="muted"><input type="checkbox" id="chat-tools" checked> проверка tool calling (get_weather)</label>
<button class="b" id="chat-clear">очистить</button>
<span class="muted" id="chat-prov"></span>
</div>
<div id="chat-wrap"><div id="chat-log"></div>
<div id="chat-bar"><input id="chat-in" class="t" placeholder="Сообщение… (Enter — отправить)"><button class="b pri" id="chat-send">Отправить</button></div></div>
</section>
<section id="tab-models"><div class="row" style="margin-bottom:.6rem"><button class="b" id="models-refresh">обновить список</button><span class="muted" id="models-updated"></span></div><div id="models-list"></div></section>
<section id="tab-connect">
<h2>Харнессы и клиенты</h2>
<p class="muted">Любой OpenAI-совместимый клиент подключается так:</p>
<pre id="cfg-opencode"></pre>
<button class="b" onclick="copyCfg('cfg-opencode')">копировать</button>
<pre id="cfg-curl"></pre>
<button class="b" onclick="copyCfg('cfg-curl')">копировать</button>
<p class="muted">В web-клиентах: base URL <code>${base}</code>, API-ключ любой (например <code>freehub</code>).</p>
</section>
<section id="tab-log"><div class="row" style="margin-bottom:.6rem"><button class="b" id="log-refresh">обновить</button><span class="muted">последние 200 строк ~/.freehub/freehub.log (автообновление 5с)</span></div><pre id="log-pre">…</pre></section>
</main>
<script>
const BASE=${JSON.stringify(base)};
const $=(s)=>document.querySelector(s);
const esc=(s)=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
/* табы */
for(const b of document.querySelectorAll('nav button')) b.onclick=()=>{
  document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('main section').forEach(x=>x.classList.remove('on'));
  b.classList.add('active');$('#tab-'+b.dataset.tab).classList.add('on');
  if(b.dataset.tab==='log')loadLog(); if(b.dataset.tab==='models')loadModels();
  if(b.dataset.tab==='bridge'){loadBridge();loadBridgeLog();}
};
/* провайдеры */
async function loadProv(){
  try{
    const j=await(await fetch('/api/status')).json();
    $('#hdr-status').textContent='провайдеров с ключами: '+j.providers.filter(p=>p.hasKey).length+' / '+j.providers.length;
    const g=$('#prov-grid');g.innerHTML='';
    for(const p of j.providers){
      const c=document.createElement('div');c.className='card';if(!p.enabled)c.style.opacity='.55';
      c.innerHTML='<h3><span><span class="dot'+(p.hasKey&&p.enabled?' on':'')+'"></span>'+esc(p.label)+'</span>'+
        '<span class="tag '+(p.free||'')+'">'+esc(p.free||'')+(p.enabled?'':' · выкл')+'</span></h3>'+
        '<div class="meta">'+(p.hasKey?('ключ <b>'+esc(p.keyMask)+'</b> · '+esc(p.source)+' · '+esc(p.defaultModel)):('ключа нет · по умолчанию '+esc(p.defaultModel)))+'</div>'+
        '<div class="row">'+
        (p.consoleUrl?'<a class="b" target="_blank" href="'+esc(p.consoleUrl)+'">Войти</a>':'')+
        (p.managed?'<button class="b" data-bridge="'+p.id+'" title="мост управляется freehub: запуск, ключ и модели — во вкладке «Мост веб-чатов»">Настроить мост</button>':'<button class="b" data-add="'+p.id+'">Вставить ключ</button>')+
        (p.hasKey&&p.enabled?'<button class="b" data-test="'+p.id+'">Тест</button>':'')+
        (p.enabled?'<button class="b" data-off="'+p.id+'">Выкл</button>':'<button class="b pri" data-on="'+p.id+'">Вкл</button>')+
        (p.managed?'<span class="tag bridge">мост</span>':(p.custom?'<button class="b" data-del="'+p.id+'" title="удалить провайдера">✖</button>':''))+
        '</div><div class="result" id="r-'+p.id+'"></div>';
      g.appendChild(c);
    }
    for(const b of document.querySelectorAll('[data-off],[data-on]'))b.onclick=async()=>{
      const id=b.dataset.off||b.dataset.on, en=!!b.dataset.on;
      await fetch('/api/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,enabled:en})});
      loadProv();};
    for(const b of document.querySelectorAll('[data-test]'))b.onclick=async()=>{
      const id=b.dataset.test,r=$('#r-'+id);r.className='result';r.textContent='проверяю…';b.disabled=true;
      try{const t=await(await fetch('/api/test?id='+id)).json();
        r.className='result '+(t.ok?'ok':'err');
        r.textContent=t.ok?('✔ '+t.tool+' за '+t.ms+'ms'):'✖ '+(t.error||('HTTP '+t.status));}
      catch(e){r.className='result err';r.textContent='✖ '+e.message}b.disabled=false;};
    for(const b of document.querySelectorAll('[data-add]'))b.onclick=()=>{
      const id=b.dataset.add,r=$('#r-'+id);
      r.className='result';r.innerHTML='<div class="row"><input class="t" type="password" id="k-'+id+'" placeholder="вставь ключ…"><button class="b pri" data-save="'+id+'">Сохранить</button></div>';
      const inp=$('#k-'+id);inp.focus();
      const save=async()=>{
        const k=inp.value.trim();if(!k)return;
        const s=await(await fetch('/api/keys',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,key:k})})).json();
        r.className='result '+(s.ok?'ok':'err');r.textContent=s.ok?('✔ сохранён '+s.keyMask):('✖ '+s.error);
        setTimeout(loadProv,600);};
      r.querySelector('[data-save]').onclick=save;
      inp.addEventListener('keydown',e=>{if(e.key==='Enter')save()});
    };
    for(const b of document.querySelectorAll('[data-del]'))b.onclick=async()=>{
      if(!confirm('Удалить провайдера '+b.dataset.del+' и его ключ?'))return;
      await fetch('/api/providers/remove',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:b.dataset.del})});
      loadProv();loadModels();};
    for(const b of document.querySelectorAll('[data-bridge]'))b.onclick=()=>{
      const t=document.querySelector('nav button[data-tab="bridge"]');if(t)t.click();};
  }catch(e){$('#hdr-status').textContent='freehub не отвечает: '+e.message}
}
/* мост веб-чатов */
async function loadBridge(){
  try{
    const j=await(await fetch('/api/bridge')).json();
    $('#br-dot').className='dot'+(j.healthy?' on':'');
    $('#br-state').textContent=!j.available?'мост не найден':(j.healthy?'мост работает':(j.running?'мост запускается…':'мост остановлен'));
    $('#br-meta').textContent='порт '+j.port+' · провайдер '+j.providerId+(j.models!=null?(' · моделей '+j.models):'')+(j.qwenProfile?' · Qwen ✔':' · Qwen ✖');
    if(document.activeElement!==$('#br-dir'))$('#br-dir').value=j.dir||'';
    if(document.activeElement!==$('#br-port'))$('#br-port').value=j.port||'';
    $('#br-key').placeholder=j.hasKey?'ключ сохранён (пусто — не менять)':'API-ключ моста';
    $('#br-auto').checked=!!j.autoStart;$('#br-qwen').checked=j.qwenWeb;
    $('#br-ui').href='http://127.0.0.1:'+j.port+'/';
    $('#br-start').disabled=!!j.running;$('#br-stop').disabled=!j.running;$('#br-login').disabled=!j.available;
  }catch(e){$('#br-state').textContent='ошибка: '+e.message}
}
async function loadBridgeLog(){
  try{$('#br-log').textContent=await(await fetch('/api/bridge/log?limit=200')).then(r=>r.text());}
  catch(e){$('#br-log').textContent=e.message}
}
async function brAction(path,body){
  $('#br-state').textContent='выполняю…';
  try{
    const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
    const j=await r.json().catch(()=>({}));
    if(!j.ok&&j.error)alert('✖ '+j.error);
    await loadBridge();loadProv();loadModels();loadBridgeLog();
    return j;
  }catch(e){alert('✖ '+e.message);loadBridge();return {ok:false,error:e.message};}
}
$('#br-start').onclick=()=>brAction('/api/bridge/start');
$('#br-stop').onclick=()=>brAction('/api/bridge/stop');
$('#br-restart').onclick=()=>brAction('/api/bridge/restart');
$('#br-login').onclick=()=>brAction('/api/bridge/login');
$('#br-refresh').onclick=()=>brAction('/api/bridge/refresh');
$('#br-save').onclick=async()=>{
  const r=$('#br-save-result');r.className='result';r.textContent='сохраняю…';
  const j=await brAction('/api/bridge/config',{dir:$('#br-dir').value.trim(),port:$('#br-port').value.trim(),apiKey:$('#br-key').value.trim(),autoStart:$('#br-auto').checked,qwenWeb:$('#br-qwen').checked});
  $('#br-key').value='';
  r.className='result '+(j.ok?'ok':'err');r.textContent=j.ok?'✔ сохранено':'✖ '+(j.error||'ошибка');
};
loadBridge();loadBridgeLog();setInterval(()=>{if($('#tab-bridge').classList.contains('on')){loadBridge();loadBridgeLog();}},5000);
/* чат */
let msgs=[];
const WEATHER_TOOL={type:'function',function:{name:'get_weather',description:'текущая погода',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}};
function bubble(role,text){
  const d=document.createElement('div');d.className='msg '+role;d.textContent=text||'';
  $('#chat-log').appendChild(d);$('#chat-log').scrollTop=1e9;return d;
}
async function sendMsg(){
  const inp=$('#chat-in');const text=inp.value.trim();if(!text)return;
  inp.value='';msgs.push({role:'user',content:text});bubble('user',text);
  const body={model:$('#chat-model').value,messages:msgs.slice()};
  if($('#chat-tools').checked){body.tools=[WEATHER_TOOL];body.messages=[...msgs.slice(0,-1),{role:'user',content:text+' Если уместно — вызови get_weather.'}];}
  await streamChat(body);
}
async function streamChat(body){
  const b=bubble('assistant','…');let acc='',tcs={};
  const btn=$('#chat-send');btn.disabled=true;
  try{
    const r=await fetch(BASE+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    $('#chat-prov').textContent=(r.headers.get('x-freehub-provider')?('через '+r.headers.get('x-freehub-provider')+'/'+r.headers.get('x-freehub-model')):'');
    if(!r.ok){const e=await r.json().catch(()=>({}));b.textContent='✖ '+(e.error?.message||r.status);return;}
    const rd=r.body.getReader(),dec=new TextDecoder();let buf='';
    for(;;){const {done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});
      let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);
        if(!line.startsWith('data:'))continue;const d=line.slice(5).trim();
        if(d==='[DONE]')continue;
        try{const j=JSON.parse(d);const ch=j.choices&&j.choices[0];if(!ch)continue;
          if(ch.delta&&ch.delta.content)acc+=ch.delta.content;
          for(const tc of (ch.delta&&ch.delta.tool_calls)||[]){
            tcs[tc.index]=tcs[tc.index]||{id:'',name:'',args:''};
            if(tc.id)tcs[tc.index].id=tc.id;
            if(tc.function&&tc.function.name)tcs[tc.index].name=tc.function.name;
            if(tc.function&&tc.function.arguments)tcs[tc.index].args+=tc.function.arguments;}
          b.textContent=acc||'…';
        }catch(e){}}
    }
    const tlist=Object.values(tcs);
    b.textContent=acc||'(пусто)';
    if(tlist.length){
      msgs.push({role:'assistant',content:acc||null,tool_calls:tlist.map(t=>({id:t.id||'call_1',type:'function',function:{name:t.name,arguments:t.args||'{}'}}))});
      const div=document.createElement('div');
      div.innerHTML=tlist.map(t=>'<div class="tc">🔧 '+esc(t.name||t.id)+'('+esc(t.args)+')</div>').join('');
      b.appendChild(div);
      const cont=document.createElement('button');cont.className='b';cont.style.marginTop='.4rem';
      cont.textContent='Отправить результат инструмента и продолжить';
      cont.onclick=async()=>{
        cont.remove();
        for(const t of tlist)msgs.push({role:'tool',tool_call_id:t.id||'call_1',content:JSON.stringify({temp:12,cond:'ясно',city:'Москва'})});
        await streamChat({model:$('#chat-model').value,messages:msgs.slice()});
      };
      b.appendChild(cont);
    } else msgs.push({role:'assistant',content:acc});
  }catch(e){b.textContent='✖ '+e.message}
  btn.disabled=false;$('#chat-log').scrollTop=1e9;
}
$('#chat-send').onclick=sendMsg;
$('#chat-in').addEventListener('keydown',e=>{if(e.key==='Enter')sendMsg()});
$('#chat-clear').onclick=()=>{msgs=[];$('#chat-log').innerHTML='';$('#chat-prov').textContent='';};
async function loadModels(){
  try{
    const st=await(await fetch('/api/status')).json();
    $('#models-updated').textContent=st.modelsUpdatedAt?('обновлено: '+new Date(st.modelsUpdatedAt).toLocaleTimeString()):'';
    const j=await(await fetch(BASE+'/models')).json();const ids=j.data.map(m=>m.id);
    const sel=$('#chat-model');sel.innerHTML='<option value="free">free (авто-выбор)</option>'+ids.map(i=>'<option>'+esc(i)+'</option>').join('');
    const groups={};for(const i of ids){const g=i.includes('/')?i.split('/')[0]:'прочее';(groups[g]=groups[g]||[]).push(i);}
    $('#models-list').innerHTML='<table><tr><th>провайдер</th><th>модели</th></tr>'+Object.entries(groups).map(([g,l])=>'<tr><td>'+esc(g)+'</td><td>'+l.map(esc).join('<br>')+'</td></tr>').join('')+'</table>';
  }catch(e){$('#models-list').textContent='ошибка: '+e.message}
}
/* лог */
async function loadLog(){try{$('#log-pre').textContent=await(await fetch('/api/log?limit=200')).then(r=>r.text());}catch(e){$('#log-pre').textContent=e.message}}
$('#log-refresh').onclick=loadLog;setInterval(()=>{if($('#tab-log').classList.contains('on'))loadLog();},5000);
/* подключение */
$('#cfg-opencode').textContent='~/.config/opencode/opencode.json — уже настроено. Модель: freehub/free';
$('#cfg-curl').textContent='curl '+BASE+'/chat/completions -H "content-type: application/json" -d \\'{"model":"free","messages":[{"role":"user","content":"привет"}]}\\'';
function copyCfg(id){navigator.clipboard.writeText($('#'+id).textContent).then(()=>{const b=event.target;b.textContent='скопировано';setTimeout(()=>b.textContent='копировать',1200);})}
$('#models-refresh').onclick=async()=>{
  $('#models-updated').textContent='обновляю…';
  await fetch(BASE+'/models',{headers:{'x-refresh-cache':'1'}}).catch(()=>{});
  loadModels();
};
/* дропдаун моделей чата: добавлять новые модели без перезагрузки, не трогая выбор */
async function syncModelOptions(){
  try{
    const j=await(await fetch(BASE+'/models')).json();
    const sel=$('#chat-model');if(!sel)return;
    const have=new Set([...sel.options].map(o=>o.value));
    for(const id of j.data.map(m=>m.id)) if(!have.has(id)) sel.add(new Option(id,id));
  }catch{}
}
/* свой провайдер: форма добавления */
$('#prov-add').onclick=()=>{const f=$('#prov-form');f.style.display=f.style.display==='none'?'block':'none';};
$('#np-save').onclick=async()=>{
  const val=id=>$('#'+id).value.trim();
  const r=$('#prov-add-result');
  if(!val('np-id')||!val('np-url')||!val('np-key')){r.className='result err';r.textContent='✖ заполните id, base URL и ключ';return;}
  r.className='result';r.textContent='добавляю, подтягиваю модели…';
  try{
    const s=await(await fetch('/api/providers',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({id:val('np-id'),label:val('np-label'),baseURL:val('np-url'),key:val('np-key'),defaultModel:val('np-model')})})).json();
    if(!s.ok){r.className='result err';r.textContent='✖ '+(s.error||'ошибка');return;}
    r.className='result ok';
    r.textContent='✔ '+s.id+': моделей живым списком '+s.discovered+(s.defaultModel?(' · модель по умолчанию '+s.defaultModel):'');
    ['np-id','np-label','np-url','np-key','np-model'].forEach(i=>$('#'+i).value='');
    $('#prov-form').style.display='none';
    loadProv();loadModels();
  }catch(e){r.className='result err';r.textContent='✖ '+e.message}
};
loadProv();loadModels();setInterval(loadProv,5000);setInterval(syncModelOptions,15000);
</script></body></html>`);
}

// ---------------------------------------------------------------------------
// CLI

function openConsoles(cfg, ids) {
  const targets = ids.length
    ? allProviders(cfg).filter((p) => ids.includes(p.id))
    : allProviders(cfg);
  for (const p of targets) {
    if (!p.consoleUrl) continue;
    console.log(`открываю ${p.id}: ${p.consoleUrl}`);
    try {
      if (process.platform === 'win32') execFileSync('cmd.exe', ['/c', 'start', '', p.consoleUrl], { stdio: 'ignore' });
      else if (process.platform === 'darwin') execFileSync('open', [p.consoleUrl]);
      else execFileSync('xdg-open', [p.consoleUrl]);
    } catch (e) { console.error(`  не получилось: ${e.message}`); }
  }
}

function cmdStatus(cfg) {
  const keys = loadKeys();
  console.log(`${'ID'.padEnd(12)}${'СЕРВИС'.padEnd(34)}${'ТАРИФ'.padEnd(7)}${'КЛЮЧ'.padEnd(24)}МОДЕЛЕЙ`);
  for (const p of allProviders(cfg)) {
    const k = keys[p.id];
    console.log(
      p.id.padEnd(12) +
      (p.label || '').slice(0, 32).padEnd(34) +
      (p.free || '').padEnd(7) +
      (k ? '✔ ' + mask(k.key) + ' (' + k.source + ')' : '—').padEnd(46) +
      String((p.models || []).length),
    );
  }
  console.log(`\nСервер:  freehub serve  ->  http://${cfg.host}:${cfg.port}/v1  (model=free — авто-выбор)`);
  console.log('Ключи:   freehub key set <id> <ключ>   |   freehub open  (открыть консоли)');
}

function cmdKey(cfg, verb, id, key) {
  if (verb === 'list') return cmdStatus(cfg);
  if (verb !== 'set' || !id || !key) {
    console.log('использование: freehub key set <id> <ключ>  |  freehub key list');
    process.exit(1);
  }
  if (!DEFAULT_PROVIDERS.some((p) => p.id === id) && !cfg.providers[id]) {
    console.log(`Неизвестный провайдер "${id}". Известные: ${allProviders(cfg).map((p) => p.id).join(', ')}`);
    process.exit(1);
  }
  const keys = loadJson(KEYS_FILE, {});
  keys[id] = key;
  saveJson(KEYS_FILE, keys);
  console.log(`freehub: ключ ${id} = ${mask(key)} сохранён в ${KEYS_FILE}`);
}

async function cmdTest(cfg, model) {
  const port = cfg.port;
  const body = {
    model: model || 'free',
    messages: [{ role: 'user', content: 'Какая погода в Москве? Вызови инструмент.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'погода в городе',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }],
    tool_choice: 'auto',
  };
  const res = await fetch(`http://${cfg.host}:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  const msg = j.choices?.[0]?.message;
  console.log(`HTTP ${res.status} · провайдер: ${res.headers.get('x-freehub-provider')} · модель: ${res.headers.get('x-freehub-model')}`);
  if (msg?.tool_calls?.length) {
    console.log(`✔ tool calling работает: ${msg.tool_calls.map((t) => t.function.name + '(' + t.function.arguments + ')').join(', ')}`);
  } else {
    console.log(`✖ tool_calls не вернулись. finish_reason=${j.choices?.[0]?.finish_reason}, content=${String(msg?.content).slice(0, 200)}`);
    if (j.error) console.log('ошибка:', j.error.message);
  }
}

async function cmdBridge(cfg, verb = 'status') {
  const api = `http://${cfg.host}:${cfg.port}/api/bridge`;
  try {
    if (verb === 'status') {
      const j = await (await fetch(api)).json();
      console.log(`мост: ${j.healthy ? 'работает' : j.running ? 'запускается' : 'остановлен'}`);
      console.log(`  каталог:   ${j.dir || '—'}`);
      console.log(`  порт:      ${j.port}`);
      console.log(`  провайдер: ${j.providerId} (ключ ${j.hasKey ? '✔' : '—'}, моделей ${j.models ?? '—'})`);
      console.log(`  Qwen web:  ${j.qwenWeb ? 'вкл' : 'выкл'}, профиль ${j.qwenProfile ? '✔' : '✖'}`);
      console.log(`  лог:       ${j.logFile}`);
      if (j.lastError) console.log(`  ошибка:    ${j.lastError}`);
      return;
    }
    const route = verb === 'models' ? 'refresh' : verb;
    const res = await fetch(`${api}/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) { console.error('✖ ' + (j.error || `HTTP ${res.status}`)); process.exitCode = 1; return; }
    if (verb === 'login') {
      console.log('✔ окно входа в Qwen открыто; после входа перезапусти мост: freehub bridge restart');
    } else {
      console.log(`✔ мост ${j.healthy ? 'работает' : 'остановлен'} (порт ${j.port}), моделей ${j.models ?? '—'}`);
    }
  } catch (e) {
    console.error('Сервер freehub не запущен? ' + e.message);
    process.exitCode = 1;
  }
}

function usage() {
  console.log(`freehub — локальный OpenAI-совместимый хаб к бесплатным нейронкам (tool calling из коробки)

  freehub                 запустить сервер (http://127.0.0.1:8787/v1)
  freehub serve [--port N]
  freehub open [id...]    открыть консоли сервисов за API-ключами
  freehub key set <id> <ключ>   сохранить ключ (или env: GROQ_API_KEY и т.д.)
  freehub key list        статус ключей
  freehub status          то же + подсказки
  freehub test [model]    проверка tool calling через запущенный сервер
  freehub models          список моделей (нужен запущенный сервер)
  freehub bridge [status|start|stop|restart|login|models]
                          мост веб-чатов (chat-bridge + Qwen web)

Подключение харнесса: base_url=http://127.0.0.1:8787/v1, api_key=freehub,
model=free (авто-выбор) или groq/llama-3.3-70b-versatile, gemini/gemini-2.5-flash, ...
Конфиг: ~/.freehub/config.json (там же свои провайдеры). Лог: ~/.freehub/freehub.log`);
}

// ---------------------------------------------------------------------------

async function main() {
  const arg = process.argv[2] || 'serve';
  const cfg = loadConfig();
  if (arg === 'serve') {
    const portIdx = process.argv.indexOf('--port');
    if (portIdx > 0) cfg.port = Number(process.argv[portIdx + 1]) || cfg.port;
    if (!fs.existsSync(CONFIG_FILE)) saveJson(CONFIG_FILE, defaultConfig());
    startServer(cfg);
  } else if (arg === 'open') {
    openConsoles(cfg, process.argv.slice(3));
  } else if (arg === 'key') {
    cmdKey(cfg, process.argv[3], process.argv[4], process.argv[5]);
  } else if (arg === 'status' || arg === 'list') {
    cmdStatus(cfg);
  } else if (arg === 'test') {
    cmdTest(cfg, process.argv[3]).catch((e) => { console.error(e.message); process.exit(1); });
  } else if (arg === 'models') {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/v1/models`).catch(() => null);
    if (!res) { console.error('Сервер не запущен (freehub serve)'); process.exit(1); }
    const j = await res.json();
    console.log(j.data.map((m) => m.id).join('\n'));
  } else if (arg === 'bridge') {
    await cmdBridge(cfg, process.argv[3] || 'status');
  } else {
    usage();
  }
}

main();
