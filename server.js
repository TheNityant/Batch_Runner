import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, act, DomainError } from './engine.js';
import { loadRuns, saveRun } from './storage.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const runs = loadRuns();
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 128_000) throw new DomainError('JSON file is too large (128 KB maximum).', 413);
  }
  try { return JSON.parse(data); } catch { throw new DomainError('Invalid JSON.'); }
}
function getRun(id) {
  const run = runs.get(id);
  if (!run) throw new DomainError('Run not found. Load a sample or upload a template.', 404);
  return run;
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, voiceConfigured: Boolean(process.env.ASSEMBLYAI_API_KEY) });
    if (url.pathname === '/api/samples' && req.method === 'GET') {
      const files = (await readdir(path.join(root, 'samples'))).filter(x => x.endsWith('.json'));
      return json(res, 200, await Promise.all(files.map(async name => ({ filename: name, template: JSON.parse(await readFile(path.join(root, 'samples', name), 'utf8')) }))));
    }
    if (url.pathname === '/api/voice-token' && req.method === 'POST') {
      if (!process.env.ASSEMBLYAI_API_KEY) throw new DomainError('Set ASSEMBLYAI_API_KEY on the server to enable live voice.', 503, 'VOICE_NOT_CONFIGURED');
      const endpoint = new URL('https://agents.assemblyai.com/v1/token');
      endpoint.searchParams.set('expires_in_seconds', '120');
      endpoint.searchParams.set('max_session_duration_seconds', '1800');
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${process.env.ASSEMBLYAI_API_KEY}` } });
      if (!response.ok) throw new DomainError('AssemblyAI token request failed. Check server credentials and account access.', 502, 'TOKEN_FAILED');
      const { token } = await response.json();
      return json(res, 200, { token });
    }
    if (url.pathname === '/api/runs' && req.method === 'POST') {
      const input = await body(req);
      const run = createRun(input.template, input.operator);
      saveRun(run);
      runs.set(run.id, run);
      return json(res, 201, { run });
    }
    const match = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)(?:\/(actions|export))?$/);
    if (match) {
      const run = getRun(match[1]);
      if (req.method === 'GET' && !match[2]) return json(res, 200, { run });
      if (req.method === 'GET' && match[2] === 'export') {
        res.setHeader('Content-Disposition', `attachment; filename="${run.batchCode}-audit.json"`);
        return json(res, 200, { exportedAt: new Date().toISOString(), run });
      }
      if (req.method === 'POST' && match[2] === 'actions') {
        const input = await body(req);
        const result = act(run, input.action, input.args);
        saveRun(run);
        return json(res, 200, { result, run });
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new DomainError('Endpoint not found.', 404);
    const asset = url.pathname === '/' ? '/index.html' : url.pathname;
    const normalized = path.normalize(asset).replace(/^[/\\]+/, '');
    const file = path.resolve(root, 'public', normalized);
    if (!file.startsWith(path.join(root, 'public') + path.sep)) throw new DomainError('Not found.', 404);
    const content = await readFile(file).catch(() => { throw new DomainError('Not found.', 404); });
    res.writeHead(200, { 'Content-Type': `${mime[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    json(res, error.status || 500, { error: error.status ? error.message : 'Unexpected server error.', code: error.code || 'SERVER_ERROR' });
    if (!error.status) console.error(error);
  }
}

http.createServer(handler).listen(port, () => console.log(`BatchRunner ready at http://localhost:${port}`));
