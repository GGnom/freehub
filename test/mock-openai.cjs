// Мок OpenAI-совместимого провайдера для офлайн-тестов freehub.
//   node mock-openai.cjs 9998 ok     — всегда отвечает, возвращает tool_call
//   node mock-openai.cjs 9998 sse    — стримит SSE с tool_call
//   node mock-openai.cjs 9997 fail   — всегда 429 (для проверки fallback)
'use strict';
const http = require('node:http');

const port = Number(process.argv[2] || 9998);
const mode = process.argv[3] || 'ok';

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-chat' }, { id: 'mock-pro' }] }));
  }
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer mock-key-123') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'bad key' } }));
      }
      if (mode === 'fail') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'rate limited (mock)' } }));
      }
      if (mode === 'sse' && JSON.parse(body).stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunks = [
          { choices: [{ delta: { role: 'assistant', content: '' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Москва"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ];
        let i = 0;
        const t = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(t);
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock-chat', ...chunks[i++] })}\n\n`);
        }, 30);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock-' + Date.now(), object: 'chat.completion', model: JSON.parse(body).model,
        choices: [{
          index: 0, finish_reason: 'tool_calls',
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Москва"}' } }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
    return;
  }
  res.writeHead(404); res.end('{}');
});
server.listen(port, '127.0.0.1', () => console.log(`mock ${mode} на :${port}`));
