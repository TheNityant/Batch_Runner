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

test('tool result is sent after reply.done for either event ordering', async () => {
  for (const order of ['call-first', 'done-first']) {
    const { session, sent } = harness();
    const call = { type: 'tool.call', call_id: order, name: 'record_reading', arguments: { parameter: 'rpm', value: 415 } };
    if (order === 'call-first') { session.handle(call); assert.equal(sent.length, 0); session.handle({ type: 'reply.done', status: 'completed' }); }
    else { session.handle({ type: 'reply.done', status: 'completed' }); session.handle(call); }
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].call_id, order);
    assert.equal(JSON.parse(sent[0].result).args.value, 415);
    session.handle(call); await tick();
    assert.equal(sent.length, 1, 'a repeated call ID does not run twice');
  }
});

test('interrupted turn discards unexecuted tools and speech starts stop playback', async () => {
  const { session, sent } = harness();
  let stopped = 0;
  session.stopPlayback = () => { stopped++; };
  session.handle({ type: 'tool.call', call_id: 'stale', name: 'complete_step', arguments: {} });
  session.handle({ type: 'reply.done', status: 'interrupted' });
  session.handle({ type: 'input.speech.started' });
  await tick();
  assert.equal(sent.length, 0);
  assert.equal(stopped, 2);
});

test('active step changes tool parameter enum and keyterms', () => {
  const run = { batchCode: 'B-204', template: { title: 'Demo', steps: [
    { id: 'one', name: 'Granulation', parameters: [{ key: 'mixer_rpm', label: 'Mixer speed', unit: 'RPM' }] },
    { id: 'two', name: 'Compression', parameters: [{ key: 'hardness', label: 'Hardness', unit: 'kp' }] }
  ] }, stepIndex: 0 };
  const first = sessionContext(run);
  assert.equal(first.tools.filter(t => t.name === 'get_batch_status').length, 1);
  run.stepIndex = 1;
  const second = sessionContext(run);
  assert.deepEqual(first.tools.find(t => t.name === 'record_reading').parameters.properties.parameter.enum, ['mixer_rpm']);
  assert.deepEqual(second.tools.find(t => t.name === 'record_reading').parameters.properties.parameter.enum, ['hardness']);
  assert.ok(second.input.keyterms.includes('Compression'));
  run.status = 'complete';
  const completed = sessionContext(run);
  assert.deepEqual(completed.tools.map(tool => tool.name), ['get_batch_status']);
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
