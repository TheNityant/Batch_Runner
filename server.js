import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, act, DomainError } from './engine.js';
import { loadRuns, saveRun } from './storage.js';
import { checkOrigin, limit, requireJson, requireVoiceAccess, sessionFor, unlockVoice, voiceAccessState } from './security.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const host = process.env.BATCHRUNNER_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const runs = loadRuns();
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  requireJson(req);
  let data = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 128_000) throw new DomainError('JSON file is too large (128 KB maximum).', 413);
    data += chunk;
  }
  let parsed;
  try { parsed = JSON.parse(data); } catch { throw new DomainError('Invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DomainError('Expected a JSON object.');
  return parsed;
}
function getRun(id, sessionId) {
  const run = runs.get(id);
  if (!run || run.ownerId !== sessionId) throw new DomainError('Run not found. Load a sample or upload a template.', 404);
  return run;
}

async function handler(req, res) {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'microphone=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss://agents.assemblyai.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const sessionId = sessionFor(req, res);
    checkOrigin(req);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, ...voiceAccessState(sessionId) });
    if (url.pathname === '/api/samples' && req.method === 'GET') {
      const files = (await readdir(path.join(root, 'samples'))).filter(x => x.endsWith('.json'));
      return json(res, 200, await Promise.all(files.map(async name => ({ filename: name, template: JSON.parse(await readFile(path.join(root, 'samples', name), 'utf8')) }))));
    }
    if (url.pathname === '/api/voice-access' && req.method === 'POST') {
      const input = await body(req);
      unlockVoice(sessionId, input.code, req.socket.remoteAddress || 'unknown');
      return json(res, 200, voiceAccessState(sessionId));
    }
    if (url.pathname === '/api/voice-token' && req.method === 'POST') {
      if (!process.env.ASSEMBLYAI_API_KEY) throw new DomainError('Set ASSEMBLYAI_API_KEY on the server to enable live voice.', 503, 'VOICE_NOT_CONFIGURED');
      const input = await body(req);
      if (typeof input.runId !== 'string' || getRun(input.runId, sessionId).status !== 'active') throw new DomainError('Start a batch before connecting voice.', 409);
      limit(`voice-ip:${req.socket.remoteAddress || 'unknown'}`, 30, 60 * 60_000);
      requireVoiceAccess(sessionId);
      const endpoint = new URL('https://agents.assemblyai.com/v1/token');
      endpoint.searchParams.set('expires_in_seconds', '120');
      endpoint.searchParams.set('max_session_duration_seconds', '600');
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${process.env.ASSEMBLYAI_API_KEY}` }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new DomainError('AssemblyAI token request failed. Check server credentials and account access.', 502, 'TOKEN_FAILED');
      const { token } = await response.json();
      return json(res, 200, { token });
    }
    if (url.pathname === '/api/runs' && req.method === 'POST') {
      limit('runs:global', 300, 24 * 60 * 60_000);
      limit(`runs:${sessionId}`, 20, 60 * 60_000);
      const input = await body(req);
      const run = createRun(input.template, input.operator);
      run.ownerId = sessionId; run.version = 0; run.processedRequests = [];
      saveRun(run);
      runs.set(run.id, run);
      return json(res, 201, { run });
    }
    const match = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)(?:\/(actions|export))?$/);
    if (match) {
      const run = getRun(match[1], sessionId);
      if (req.method === 'GET' && !match[2]) return json(res, 200, { run });
      if (req.method === 'GET' && match[2] === 'export') {
        res.setHeader('Content-Disposition', `attachment; filename="${run.batchCode}-audit.json"`);
        return json(res, 200, { exportedAt: new Date().toISOString(), run });
      }
      if (req.method === 'POST' && match[2] === 'actions') {
        limit(`actions:${sessionId}`, 180, 60_000);
        const input = await body(req);
        if (typeof input.action !== 'string') throw new DomainError('Action name is required.');
        if (input.action !== 'get_status' && (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId))) {
          throw new DomainError('A valid request ID is required.', 428, 'REQUEST_ID_REQUIRED');
        }
        const prior = run.processedRequests?.find(item => item.id === input.requestId);
        if (prior && input.requestId) return json(res, 200, { result: prior.result, run });
        if (input.action !== 'get_status' && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)) {
          throw new DomainError('Expected batch version is required.', 428, 'VERSION_REQUIRED');
        }
        if (input.expectedVersion !== undefined && input.expectedVersion !== (run.version || 0)) {
          return json(res, 409, { error: 'Batch changed in another tab or action. Refresh and retry.', code: 'STALE_RUN', run });
        }
        const draft = structuredClone(run);
        const result = act(draft, input.action, input.args);
        if (input.action === 'get_status') return json(res, 200, { result, run });
        draft.version = (run.version || 0) + 1;
        if (input.requestId) draft.processedRequests = [...(draft.processedRequests || []), { id: input.requestId, result }].slice(-100);
        saveRun(draft);
        runs.set(draft.id, draft);
        return json(res, 200, { result, run: draft });
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new DomainError('Endpoint not found.', 404);
    const asset = url.pathname === '/' ? '/index.html' : url.pathname;
    const normalized = path.normalize(asset).replace(/^[/\\]+/, '');
    const file = path.resolve(root, 'public', normalized);
    if (!file.startsWith(path.join(root, 'public') + path.sep)) throw new DomainError('Not found.', 404);
    const content = await readFile(file).catch(() => { throw new DomainError('Not found.', 404); });
    res.writeHead(200, { 'Content-Type': `${mime[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    json(res, error.status || 500, { error: error.status ? error.message : 'Unexpected server error.', code: error.code || 'SERVER_ERROR' });
    if (!error.status) console.error(error);
  }
}

const server = http.createServer(handler);
server.listen(port, host, () => console.log(`BatchRunner ready at http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
