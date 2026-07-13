import http from 'node:http';

const port = Number(process.env.PORT || 8010);

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v2/check') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found"}');
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const text = new URLSearchParams(body).get('text') || '';
  const needle = 'teh';
  const offset = text.indexOf(needle);
  const matches = offset < 0 ? [] : [{
    offset,
    length: needle.length,
    message: 'Possible spelling mistake found by the formal fixture.',
    rule: { issueType: 'misspelling', category: { id: 'TYPOS' } },
    replacements: [{ value: 'the' }, { value: 'ten' }],
  }];
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ software: { name: 'chronicle-formal-fixture' }, matches }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Deterministic LanguageTool fixture listening on ${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
