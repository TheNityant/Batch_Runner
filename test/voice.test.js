import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession, sessionContext } from '../public/voice.js';

function harness() {
  const sent = [];
  const session = new VoiceSession({ onTool: async (name, args) => ({ name, args }), onTranscript: () => {}, onStatus: () => {} });
  session.ws = { readyState: WebSocket.OPEN, send: message => sent.push(JSON.parse(message)) };
  return { session, sent };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('hold tool returns exactly one result after validation, without a reply.done gate', async () => {
  const { session, sent } = harness();
  let finish;
  let calls = 0;
  session.onTool = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  session.handle({ type: 'reply.done', reply_id: 'previous-turn', status: 'completed' });
  const call = { type: 'tool.call', call_id: 'reading-1', name: 'record_reading', arguments: { parameter: 'rpm', value: 850 } };
  session.handle(call);
  session.handle(call);
  await tick();
  assert.equal(calls, 1);
  assert.equal(sent.length, 0, 'a previous reply.done does not speak over validation');
  finish({ code: 'OUT_OF_RANGE', message: '850 RPM is outside 600–800 RPM. Confirm or correct it.' });
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].call_id, 'reading-1');
  assert.match(JSON.parse(sent[0].result).message, /outside 600–800 RPM/);
  session.handle(call); await tick();
  assert.equal(sent.length, 1, 'repeated call ID does not run twice');
});

test('multiple hold calls produce one spoken reply at a time', async () => {
  const { session, sent } = harness();
  session.handle({ type: 'tool.call', call_id: 'first', name: 'record_reading', arguments: { parameter: 'rpm', value: 850 } });
  session.handle({ type: 'tool.call', call_id: 'second', name: 'record_reading', arguments: { parameter: 'temp', value: 47 } });
  await tick();
  assert.deepEqual(sent.map(message => message.call_id), ['first']);
  session.handle({ type: 'reply.done', reply_id: 'old-turn', status: 'completed' });
  await tick();
  assert.equal(sent.length, 1, 'a previous completion cannot release the next result');
  session.handle({ type: 'reply.started', reply_id: 'answer-to-first' });
  session.handle({ type: 'reply.done', reply_id: 'answer-to-first', status: 'completed' });
  await tick();
  assert.deepEqual(sent.map(message => message.call_id), ['first', 'second']);
});

test('step context updates before the tool result starts the next spoken reply', async () => {
  const { session, sent } = harness();
  session.onTool = async () => ({ code: 'STEP_ADVANCED', stepChanged: true });
  session.afterTool = () => session.ws.send(JSON.stringify({ type: 'session.update', session: { system_prompt: 'New step' } }));
  session.handle({ type: 'tool.call', call_id: 'advance', name: 'complete_step', arguments: {} });
  await tick();
  assert.deepEqual(sent.map(message => message.type), ['session.update', 'tool.result']);
});

test('interruption clears playback but preserves an in-flight hold result', async () => {
  const { session, sent } = harness();
  let finish;
  session.onTool = () => new Promise(resolve => { finish = resolve; });
  let stopped = 0;
  session.stopPlayback = () => { stopped++; };
  session.handle({ type: 'tool.call', call_id: 'held', name: 'record_reading', arguments: { parameter: 'rpm', value: 850 } });
  session.handle({ type: 'reply.done', reply_id: 'older-reply', status: 'interrupted' });
  session.handle({ type: 'input.speech.started' });
  finish({ code: 'OUT_OF_RANGE' });
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(stopped, 2);
});

test('a new reply stops buffered audio before it starts speaking', () => {
  const { session } = harness();
  let stopped = 0;
  session.scheduled = [{ stop: () => { stopped++; } }];
  session.handle({ type: 'reply.started', reply_id: 'next-reply' });
  assert.equal(stopped, 1);
  assert.deepEqual(session.scheduled, []);
});

test('a disconnected session cannot send a late validation result into the next session', async () => {
  const { session, sent } = harness();
  let finish;
  session.onTool = () => new Promise(resolve => { finish = resolve; });
  session.handle({ type: 'tool.call', call_id: 'old', name: 'record_reading', arguments: {} });
  session.cleanup();
  session.ws = { readyState: WebSocket.OPEN, send: message => sent.push(JSON.parse(message)) };
  finish({ code: 'OUT_OF_RANGE' });
  await tick();
  assert.equal(sent.length, 0);
});

test('active step changes tool parameter enum and keyterms', () => {
  const run = { batchCode: 'B-204', template: { title: 'Demo', steps: [
    { id: 'one', name: 'Granulation', parameters: [{ key: 'mixer_rpm', label: 'Mixer speed', unit: 'RPM' }] },
    { id: 'two', name: 'Compression', parameters: [{ key: 'hardness', label: 'Hardness', unit: 'kp' }] }
  ] }, stepIndex: 0 };
  const first = sessionContext(run);
  assert.equal(first.tools.filter(t => t.name === 'get_batch_status').length, 1);
  assert.ok(first.tools.every(tool => tool.execution_mode === 'hold'));
  run.stepIndex = 1;
  const second = sessionContext(run);
  assert.deepEqual(first.tools.find(t => t.name === 'record_reading').parameters.properties.parameter.enum, ['mixer_rpm']);
  assert.deepEqual(second.tools.find(t => t.name === 'record_reading').parameters.properties.parameter.enum, ['hardness']);
  assert.ok(second.input.keyterms.includes('Compression'));
  run.status = 'complete';
  const completed = sessionContext(run);
  assert.deepEqual(completed.tools.map(tool => tool.name), ['get_batch_status']);
  assert.equal(completed.tools[0].execution_mode, 'hold');
  assert.match(completed.system_prompt, /is complete/);
});

test('a session error before ready closes the pending connection', () => {
  const { session } = harness();
  let closed = false;
  session.ws.close = () => { closed = true; };
  session.handle({ type: 'session.error', code: 'unauthorized', message: 'Invalid token' });
  assert.equal(closed, true);
  assert.match(session.lastConnectionError, /Invalid token/);
});
