# freehub

[![CI](https://github.com/GGnom/freehub/actions/workflows/ci.yml/badge.svg)](https://github.com/GGnom/freehub/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)](package.json)

Локальный **OpenAI-совместимый шлюз** к бесплатным и дешёвым LLM: один процесс, ноль
зависимостей, встроенный веб-UI. Роутит запросы по провайдерам, делает fallback при ошибках,
поддерживает **tool calling** в обычном и стриминговом режиме, подтягивает живые списки моделей
и умеет держать рядом мост к веб-чатам (chat-bridge + Qwen) как ещё одного провайдера.

```
OpenAI-клиент ──► http://127.0.0.1:8787/v1 ──► freehub ──► Groq / Gemini / Cerebras / OpenRouter / …
                                                   │
                                                   └──► chat-bridge (Qwen web и др.)
```

## Возможности

- **OpenAI-совместимый API**: `GET /v1/models`, `POST /v1/chat/completions`, JSON и SSE.
- **Tool calling** без потерь: аргументы и `tool_calls` проходят как есть; для апстримов с
  кривыми SSE-дельтами есть режим `streamMode: "synthesize"`.
- **Fallback**: `model: "free"` перебирает провайдеров с ключами по `autoPriority`; явный
  `provider/model` идёт без fallback.
- **Живой каталог моделей**: `/models` каждого провайдера замещает статический каталог,
  кэш 5 минут, персист в `~/.freehub/models-cache.json`, автообновление раз в 10 минут.
- **Свои API** в один клик: любой OpenAI-совместимый сервер (vLLM, LM Studio, Ollama, шлюз
  на работе) через UI, HTTP API или конфиг.
- **Веб-UI**: провайдеры и ключи, чат-playground с tool calling, модели, подключение, лог.
- **Мост веб-чатов**: chat-bridge поднимается отдельным процессом, регистрируется как
  провайдер, попадает в `/v1/models` и авто-выбор.
- **Аккуратная работа с историей**: лимит изображений на запрос, нормализация параметров
  (`allowedParams`), ретраи на лимитах вида «1 ответ / 30 секунд».
- **Локальность**: по умолчанию слушает только `127.0.0.1`; управляющий API закрыт от
  сторонних origin'ов.

## Быстрый старт

Нужен Node.js **18.17+**. Зависимостей нет.

```sh
git clone https://github.com/GGnom/freehub.git
cd freehub
node freehub.cjs serve
```

Открой <http://127.0.0.1:8787/> — это UI. При первом запуске без ключей freehub предложит
открыть консоли бесплатных сервисов. Ключ можно вставить в UI или сохранить из терминала:

```sh
node freehub.cjs key set groq gsk_...
node freehub.cjs test            # проверка tool calling через запущенный сервер
```

Готовый `freehub.exe` (Windows, Node SEA) собирается локально — см. [Сборка](#сборка-exe);
бинарники в репозиторий не коммитятся.

## Подключение

Любой OpenAI-совместимый клиент:

```
base_url = http://127.0.0.1:8787/v1
api_key  = любой (не проверяется)
model    = free                                  # авто-выбор первого живого провайдера
         | groq/llama-3.3-70b-versatile
         | gemini/gemini-2.5-flash
         | dashscope/qwen-plus
         | moonshot/kimi-k2-0905-preview
         | myapi/my-model                        # свой провайдер
```

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"free","messages":[{"role":"user","content":"привет"}]}'
```

Ответ помечается заголовками `x-freehub-provider` и `x-freehub-model` — удобно смотреть,
кто реально ответил.

## Провайдеры по умолчанию

| id | сервис | тариф | где ключ |
|---|---|---|---|
| groq | Groq (Llama, GPT-OSS) | free | console.groq.com/keys |
| gemini | Google AI Studio | free | aistudio.google.com/apikey |
| cerebras | Cerebras | free | cloud.cerebras.ai |
| github | GitHub Models | free | github.com/settings/tokens |
| mistral | Mistral La Plateforme | free | console.mistral.ai/api-keys |
| openrouter | OpenRouter `:free` | free | openrouter.ai/keys |
| nvidia | NVIDIA NIM | free | build.nvidia.com/settings/api-keys |
| huggingface | HuggingFace Router | free | huggingface.co/settings/tokens |
| together | Together AI | trial | api.together.ai/settings/api-keys |
| cloudflare | Cloudflare Workers AI | free | dash.cloudflare.com/profile/api-tokens |
| dashscope | Qwen / Aliyun | trial | bailian.console.aliyun.com |
| moonshot | Kimi / Moonshot | trial | platform.moonshot.cn |
| zai | Z.ai / GLM | cheap | z.ai |
| deepseek | DeepSeek | cheap | platform.deepseek.com |
| ollama | Ollama (локально) | local | ollama.com |
| lmstudio | LM Studio (локально) | local | lmstudio.ai |

Ключи ищутся по порядку: переменные окружения (`GROQ_API_KEY`, …) → `~/.freehub/keys.json` →
`~/.zcode/webkey/keys.json` (если вы пользуетесь webkey).

## Свои API

Любой OpenAI-совместимый сервер (chat/completions + models) добавляется тремя способами.

**UI:** вкладка «Провайдеры и ключи» → «＋ Добавить своего провайдера».

**HTTP API:**

```sh
curl -X POST http://127.0.0.1:8787/api/providers \
  -H 'content-type: application/json' \
  -d '{"id":"myapi","label":"My API","baseURL":"http://127.0.0.1:8000/v1","key":"x","defaultModel":"qwen3-32b"}'
```

После добавления freehub сразу забирает живой `/models` нового провайдера, выбирает
`defaultModel` (если не указан) и кладёт модели в общий индекс — они сразу видны в
`/v1/models` и в чате.

**Конфиг** `~/.freehub/config.json`:

```json
"providers": {
  "myapi": {
    "label": "Local vLLM",
    "baseURL": "http://127.0.0.1:8000/v1",
    "apiKey": "x",
    "defaultModel": "qwen3-32b",
    "models": [{ "id": "qwen3-32b", "tools": true }],
    "allowedParams": ["temperature", "max_tokens"],
    "maxImages": 0,
    "retry": { "statuses": [429], "delayMs": 5000, "attempts": 2 },
    "streamMode": "synthesize"
  }
}
```

Порядок авто-выбора задаётся массивом `autoPriority` (id провайдеров). Поле `priority` у
провайдеров не используется для сортировки.

## HTTP API

| Метод | Маршрут | Назначение |
|---|---|---|
| GET | `/healthz` | статус и версия |
| GET | `/` | веб-UI |
| GET | `/v1/models` | модели (live + каталог), `x-refresh-cache: 1` — принудительно обновить |
| POST | `/v1/chat/completions` | чат, JSON или SSE |
| GET | `/api/status` | провайдеры, маски ключей, время обновления моделей |
| POST | `/api/keys` | `{id, key}` — сохранить ключ |
| POST | `/api/toggle` | `{id, enabled}` — включить/выключить провайдера |
| POST | `/api/providers` | `{id, label, baseURL, key, defaultModel}` — добавить свой API |
| POST | `/api/providers/remove` | `{id}` — удалить свой API |
| GET | `/api/test?id=` | tool-calling пинг провайдера |
| GET | `/api/log?limit=` | хвост `~/.freehub/freehub.log` |
| GET | `/api/bridge` | состояние моста |
| POST | `/api/bridge/{start,stop,restart,login,refresh,config}` | управление мостом |
| GET | `/api/bridge/log?limit=` | лог моста |

`/api/*` принимает только same-origin запросы с локальным `Host` (см. [Безопасность](#безопасность)).
`/v1/*` открыт для CORS, чтобы им могли пользоваться браузерные клиенты.

## Мост веб-чатов

`freehub` умеет держать рядом **chat-bridge** — отдельный OpenAI-совместимый шлюз к
веб-чатам (по умолчанию Qwen) с tool calling. Мост живёт отдельным процессом, потому что внутри
Playwright и Chromium: их нельзя упаковать в SEA-exe.

- freehub находит каталог `~/chat-bridge` (или `FREEHUB_BRIDGE_DIR`) и поднимает `dist/index.js`
  на `127.0.0.1:8789`.
- Мост регистрируется провайдером: id берётся из провайдера с тем же `baseURL`, иначе из
  `bridge.providerId` (по умолчанию `webchat`).
- Для Qwen нужен один раз войти в профиль: вкладка «Мост веб-чатов» → «Войти в Qwen», затем
  «Перезапустить».

Команды:

```sh
node freehub.cjs bridge status
node freehub.cjs bridge start | stop | restart
node freehub.cjs bridge login
node freehub.cjs bridge models
```

Требования: Node.js на машине и собранный `chat-bridge` (`npm run build`). Для Qwen —
`npm install playwright && npx playwright install chromium`. Лог: `~/.freehub/bridge.log`.

## Конфиг

Файл `~/.freehub/config.json` (создаётся при первом запуске). Каталог можно переопределить
переменной `FREEHUB_HOME`.

| Поле | По умолчанию | Смысл |
|---|---|---|
| `port` | `8787` | порт |
| `host` | `127.0.0.1` | адрес прослушивания; наружу выставлять не рекомендуется |
| `trustedHosts` | `[]` | дополнительные имена хостов для `/api/*` |
| `autoOpenOnFirstRun` | `true` | открыть консоли сервисов, если ключей нет |
| `requestTimeoutMs` | `180000` | таймаут одной попытки к провайдеру |
| `modelsCacheMs` | `300000` | время жизни кэша моделей |
| `modelsRefreshMs` | `600000` | период фонового обновления моделей |
| `corsOrigin` | `*` | `Access-Control-Allow-Origin` для `/v1/*` |
| `autoPriority` | порядок провайдеров | порядок авто-выбора |
| `bridge` | см. ниже | настройки моста |
| `providers` | `{}` | переопределения встроенных и свои провайдеры |

## Безопасность

- freehub — **локальный инструмент для одного пользователя**, не сервис. По умолчанию он
  слушает `127.0.0.1`.
- Управляющий API `/api/*` принимает только same-origin запросы и локальный `Host`; это
  защищает от атак со сторонних сайтов в браузере. Токена аутентификации нет — любой процесс
  под вашим пользователем может вызвать API.
- Ключи хранятся в открытом виде в `~/.freehub/keys.json`; ограничьте права на файл.
- `baseURL` своих провайдеров не ограничивается — добавляйте только доверенные адреса.
- Запросы уходят третьим лицам (провайдерам); free-тарифы могут логировать данные. Не
  отправляйте секреты.
- Мост веб-чатов управляет реальным браузером; это может нарушать условия использования
  сервисов. Ответственность — на пользователе.

Если нужен удалённый доступ — не меняйте `host` на `0.0.0.0`, а поставьте reverse proxy с
TLS и аутентификацией. Подробнее: [SECURITY.md](SECURITY.md).

## Тесты

```sh
npm test
```

Офлайн-набор поднимает мок-провайдеров на динамических портах и временный `FREEHUB_HOME`,
проверяет старт, каталог моделей, fallback после 429, tool calling, SSE, добавление своего API,
защиту `/api/*`, лимит тела запроса и то, что остановка моста не убивает чужой процесс.
Ваш `~/.freehub` не затрагивается.

## Сборка exe

```sh
cd build
npm install                       # postject для инъекции SEA-блоба
node --experimental-sea-config sea-config.json
copy "C:\Program Files\nodejs\node.exe" freehub.exe
npx postject freehub.exe NODE_SEA_BLOB freehub.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

`build/freehub.blob` собирается из `../freehub.cjs` (см. `build/sea-config.json`). Готовый exe
удобно выкладывать в GitHub Releases, а не в git.

## Ограничения

- Живой список моделей не сообщает, поддерживает ли модель tool calling; freehub помечает все
  live-модели как `tools: true`. Проверяйте конкретную модель, если инструменты важны.
- Fallback срабатывает на любую ошибку провайдера (включая 4xx) — это осознанный компромисс
  ради живучести, но иногда маскирует ошибку клиента.
- Таймаут задаётся на одну попытку; общего дедлайна на всю цепочку нет.
- При истёкшем кэше моделей первый запрос может подождать обновления `/models`.
- Веб-UI не имеет аутентификации и рассчитан на локальный запуск.

## Лицензия

[MIT](LICENSE). Участие — [CONTRIBUTING.md](CONTRIBUTING.md), уязвимости — [SECURITY.md](SECURITY.md).
