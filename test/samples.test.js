import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRun, act, validateTemplate } from '../engine.js';

test('every included recipe completes using values within its own configured limits', async () => {
  const files = (await readdir('samples')).filter(file => file.endsWith('.json'));
  assert.equal(files.length, 3);
  for (const file of files) {
    const template = validateTemplate(JSON.parse(await readFile(`samples/${file}`, 'utf8')));
    const run = createRun(template);
    act(run, 'start');
    for (const step of template.steps) {
      for (const parameter of step.parameters) {
        const value = parameter.min != null && parameter.max != null ? (parameter.min + parameter.max) / 2 : parameter.min ?? parameter.max;
        assert.equal(act(run, 'record', { parameter: parameter.key, value }).code, 'RECORDED', `${file}: ${parameter.key}`);
      }
      act(run, 'complete_step');
    }
    assert.equal(run.status, 'complete', file);
    assert.equal(run.events.filter(e => e.type === 'STEP_COMPLETED').length, template.steps.length);
  }
});
