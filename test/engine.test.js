import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, act, validateTemplate } from '../engine.js';

const template = { title: 'Test batch', industry: 'Test', steps: [
  { id: 'mix', name: 'Mix', parameters: [
    { key: 'temp', label: 'Temperature', unit: '°C', min: 45, max: 50, required: true },
    { key: 'rpm', label: 'Mixer speed', unit: 'RPM', min: 380, max: 420, required: true }
  ] },
  { id: 'pack', name: 'Pack', parameters: [{ key: 'mass', label: 'Mass', unit: 'g', min: 99, max: 101, required: true }] }
] };

test('invalid templates cannot redefine a parameter key or accept inverted limits', () => {
  const duplicate = structuredClone(template);
  duplicate.steps[0].parameters[1].key = 'temp';
  assert.throws(() => validateTemplate(duplicate), /unique key/);
  const inverted = structuredClone(template);
  inverted.steps[0].parameters[0].min = 51;
  assert.throws(() => validateTemplate(inverted), /valid numeric limits/);
});

test('step stays blocked for missing and out-of-range readings; correction preserves audit', () => {
  const run = createRun(template);
  assert.throws(() => act(run, 'record', { parameter: 'temp', value: 47 }), /Start the batch/);
  act(run, 'start');
  assert.equal(act(run, 'record', { parameter: 'temp', value: 47.3 }).code, 'RECORDED');
  assert.deepEqual(act(run, 'get_status').missing, ['Mixer speed']);
  assert.equal(act(run, 'complete_step').code, 'STEP_BLOCKED');
  assert.equal(act(run, 'record', { parameter: 'rpm', value: 435 }).code, 'OUT_OF_RANGE');
  assert.equal(act(run, 'complete_step').code, 'STEP_BLOCKED');
  assert.equal(act(run, 'confirm_deviation', { parameter: 'rpm' }).code, 'DEVIATION_CONFIRMED');
  assert.equal(act(run, 'complete_step').code, 'STEP_BLOCKED');
  assert.equal(act(run, 'correct', { parameter: 'rpm', value: 415, reason: 'Misread dial' }).code, 'CORRECTED');
  assert.equal(run.events.some(e => e.value === 435 && e.type === 'DEVIATION_PENDING'), true);
  assert.equal(run.events.some(e => e.previousValue === 435 && e.value === 415 && e.reason === 'Misread dial'), true);
  assert.equal(act(run, 'complete_step').code, 'STEP_ADVANCED');
  assert.equal(run.stepIndex, 1);
  assert.equal(act(run, 'record', { parameter: 'mass', value: 100 }).code, 'RECORDED');
  assert.equal(act(run, 'complete_step').code, 'RUN_COMPLETED');
  assert.equal(run.status, 'complete');
});

test('duplicate reading cannot silently overwrite and ambiguous values are rejected', () => {
  const run = createRun(template); act(run, 'start');
  act(run, 'record', { parameter: 'temp', value: 47 });
  assert.equal(act(run, 'record', { parameter: 'temp', value: 49 }).code, 'CORRECTION_REQUIRED');
  assert.equal(run.readings.mix.temp.value, 47);
  assert.throws(() => act(run, 'record', { parameter: 'rpm', value: '415' }), /finite numeric/);
  assert.throws(() => act(run, 'record', { parameter: 'unknown', value: 1 }), /Unknown parameter/);
});
