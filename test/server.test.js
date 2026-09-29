import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const template = { title: 'HTTP test', industry: 'Demo', steps: [{ id: 'mix', name: 'Mix', parameters: [{ key: 'temp', label: 'Temperature', unit: '°C', min: 45, max: 50 }] }] };

async function start(port, directory) {
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, PORT: String(port), BATCHRUNNER_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  try {
    child = await start(port, directory);
    const voice = await fetch(base + '/api/voice-token', { method: 'POST' });
    assert.equal(voice.status, 503);
    assert.equal((await voice.json()).code, 'VOICE_NOT_CONFIGURED');
    const created = await fetch(base + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template }) });
    assert.equal(created.status, 201);
    const { run } = await created.json();
    const action = async (name, args = {}) => fetch(`${base}/api/runs/${run.id}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, args }) }).then(r => r.json());
    await action('start');
    assert.equal((await action('record', { parameter: 'temp', value: 52 })).result.code, 'OUT_OF_RANGE');
    const blocked = await action('complete_step');
    assert.equal(blocked.result.code, 'STEP_BLOCKED');
    child.kill(); await new Promise(resolve => child.once('exit', resolve));
    child = await start(port, directory);
    const restored = await fetch(`${base}/api/runs/${run.id}`).then(r => r.json());
    assert.equal(restored.run.readings.mix.temp.value, 52);
    assert.equal(restored.run.events.some(e => e.type === 'DEVIATION_PENDING'), true);
    const exported = await fetch(`${base}/api/runs/${run.id}/export`);
    assert.match(exported.headers.get('content-disposition'), /audit\.json/);
    assert.equal((await exported.json()).run.id, run.id);
  } finally {
    child?.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
