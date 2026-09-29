import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const template = { title: 'HTTP test', industry: 'Demo', steps: [{ id: 'mix', name: 'Mix', parameters: [{ key: 'temp', label: 'Temperature', unit: '°C', min: 45, max: 50 }] }] };

async function start(port, directory, overrides = {}) {
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, ASSEMBLYAI_API_KEY: '', PORT: String(port), BATCHRUNNER_DATA_DIR: directory, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start.')), 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited ${code}`)));
  });
  return child;
}

test('HTTP actions validate and a run survives a restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'batchrunner-test-'));
  const port = 35000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  let child;
  let cookie;
  const request = async (route, options = {}) => {
    const response = await fetch(base + route, { ...options, headers: { ...(options.headers || {}), ...(cookie ? { cookie } : {}) } });
    if (!cookie && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  try {
    child = await start(port, directory);
    const voice = await request('/api/voice-token', { method: 'POST' });
    assert.equal(voice.status, 503);
    assert.equal((await voice.json()).code, 'VOICE_NOT_CONFIGURED');
    const created = await request('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template }) });
    assert.equal(created.status, 201);
    const { run } = await created.json();
    let version = 0;
    const action = async (name, args = {}, extra = {}) => {
      const response = await request(`/api/runs/${run.id}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, args, requestId: randomUUID(), expectedVersion: version, ...extra }) });
      if (response.ok) version = (await response.clone().json()).run.version;
      return response;
    };
    const startResult = await (await action('start', {}, { requestId: 'start-1', expectedVersion: 0 })).json();
    assert.equal(startResult.run.version, 1);
    const retry = await (await action('start', {}, { requestId: 'start-1', expectedVersion: 0 })).json();
    assert.equal(retry.run.events.length, startResult.run.events.length);
    const stale = await action('record', { parameter: 'temp', value: 46 }, { requestId: 'stale-1', expectedVersion: 0 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'STALE_RUN');
    const otherSession = await fetch(`${base}/api/runs/${run.id}`);
    assert.equal(otherSession.status, 404);
    const unsupported = await request(`/api/runs/${run.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'get_status' }) });
    assert.equal(unsupported.status, 415);
    for (const malformed of ['null', '[]', '"text"']) {
      const invalid = await request('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: malformed });
      assert.equal(invalid.status, 400);
      assert.match((await invalid.json()).error, /Expected a JSON object/);
    }
    assert.equal((await (await action('record', { parameter: 'temp', value: 52 })).json()).result.code, 'OUT_OF_RANGE');
    const blocked = await (await action('complete_step')).json();
    assert.equal(blocked.result.code, 'STEP_BLOCKED');
    child.kill(); await new Promise(resolve => child.once('exit', resolve));
    child = await start(port, directory);
    const restored = await request(`/api/runs/${run.id}`).then(r => r.json());
    assert.equal(restored.run.readings.mix.temp.value, 52);
    assert.equal(restored.run.events.some(e => e.type === 'DEVIATION_PENDING'), true);
    const exported = await request(`/api/runs/${run.id}/export`);
    assert.match(exported.headers.get('content-disposition'), /audit\.json/);
    assert.equal((await exported.json()).run.id, run.id);
  } finally {
    child?.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test('production voice access needs the correct code and rejects a foreign origin', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'batchrunner-access-'));
  const port = 35000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const child = await start(port, directory, {
    NODE_ENV: 'production', BATCHRUNNER_PUBLIC_ORIGIN: 'https://batchrunner.example',
    BATCHRUNNER_SESSION_SECRET: 'a-long-unique-session-secret-for-tests-12345',
    BATCHRUNNER_DEMO_ACCESS_CODE: 'judge-demo-code', ASSEMBLYAI_API_KEY: 'test-key'
  });
  try {
    const health = await fetch(`${base}/api/health`);
    const cookie = health.headers.get('set-cookie').split(';')[0];
    const state = await health.json();
    assert.equal(state.voiceConfigured, true);
    assert.equal(state.voiceUnlocked, false);
    assert.equal(state.deploymentReady, true);
    assert.match(health.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    assert.match(health.headers.get('set-cookie'), /Secure/);
    const post = (route, data, origin = 'https://batchrunner.example') => fetch(base + route, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await post('/api/voice-access', { code: 'judge-demo-code' }, 'https://evil.example')).status, 403);
    assert.equal((await post('/api/voice-access', { code: 'wrong' })).status, 403);
    assert.equal((await post('/api/voice-access', { code: 'judge-demo-code' })).status, 200);
    assert.equal((await (await fetch(`${base}/api/health`, { headers: { cookie } })).json()).voiceUnlocked, true);
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
