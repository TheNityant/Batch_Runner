import { randomUUID } from 'node:crypto';

export class DomainError extends Error {
  constructor(message, status = 400, code = 'INVALID_ACTION') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const text = (value, max = 100) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function validateTemplate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DomainError('Expected a JSON object.');
  const title = text(raw.title);
  const industry = text(raw.industry, 60);
  if (!title || !industry || !Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 12) {
    throw new DomainError('A title, industry and 1–12 steps are required.');
  }
  const stepIds = new Set();
  const steps = raw.steps.map((step, i) => {
    const id = text(step?.id, 40);
    const name = text(step?.name);
    if (!id || !/^[a-z][a-z0-9_-]*$/i.test(id) || stepIds.has(id) || !name) throw new DomainError(`Step ${i + 1} needs a unique id and name.`);
    stepIds.add(id);
    if (!Array.isArray(step.parameters) || step.parameters.length < 1 || step.parameters.length > 12) throw new DomainError(`Step ${name} needs 1–12 parameters.`);
    const parameterIds = new Set();
    const parameters = step.parameters.map((parameter, p) => {
      const key = text(parameter?.key, 40);
      const label = text(parameter?.label, 80);
      const unit = text(parameter?.unit, 20);
      const min = parameter?.min ?? null;
      const max = parameter?.max ?? null;
      if (!key || !/^[a-z][a-z0-9_-]*$/i.test(key) || parameterIds.has(key) || !label || (min === null && max === null) ||
          (min !== null && !finite(min)) || (max !== null && !finite(max)) || (min !== null && max !== null && min > max)) {
        throw new DomainError(`Parameter ${p + 1} in ${name} needs a unique key, label and valid numeric limits.`);
      }
      parameterIds.add(key);
      return { key, label, unit, min, max, required: parameter.required !== false };
    });
    return { id, name, description: text(step.description, 300), parameters };
  });
  return { schemaVersion: 1, title, industry, description: text(raw.description, 300), steps };
}

export const limitText = p => p.min !== null && p.max !== null ? `${p.min}–${p.max} ${p.unit}`.trim() :
  p.min !== null ? `≥ ${p.min} ${p.unit}`.trim() : `≤ ${p.max} ${p.unit}`.trim();

export function createRun(template, operator = 'Demo operator') {
  const run = {
    id: randomUUID(), batchCode: `DEMO-${Math.floor(1000 + Math.random() * 9000)}`,
    operator: text(operator, 80) || 'Demo operator', template: validateTemplate(template),
    status: 'ready', stepIndex: 0, readings: {}, events: [], createdAt: new Date().toISOString()
  };
  event(run, 'RUN_CREATED', `Loaded ${run.template.title}`);
  return run;
}

function event(run, type, message, details = {}) {
  run.events.push({ id: randomUUID(), time: new Date().toISOString(), type, message, ...details });
}

function active(run) {
  if (run.status !== 'active') throw new DomainError('Start the batch before recording.', 409);
  return run.template.steps[run.stepIndex];
}

function parameterFor(run, key) {
  const step = active(run);
  const parameter = step.parameters.find(p => p.key === key || p.label.toLowerCase() === String(key).toLowerCase());
  if (!parameter) throw new DomainError(`Unknown parameter for ${step.name}.`, 400, 'UNKNOWN_PARAMETER');
  return { step, parameter };
}

function state(run, stepId) { return run.readings[stepId] ||= {}; }
const within = (p, value) => (p.min === null || value >= p.min) && (p.max === null || value <= p.max);
function number(value) {
  if (!finite(value)) throw new DomainError('A finite numeric reading is required.');
  return value;
}

export function act(run, action, args = {}) {
  if (action === 'start') {
    if (run.status !== 'ready') throw new DomainError('This run has already started.', 409);
    run.status = 'active';
    event(run, 'RUN_STARTED', 'Batch execution started');
    return { message: 'Batch started. Record the current step readings.' };
  }
  if (action === 'get_status') {
    const step = run.template.steps[run.stepIndex];
    return { message: `Current step: ${step.name}.`, status: run.status, step: step.name,
      readings: run.readings[step.id] || {}, missing: missing(run).map(p => p.label),
      parameters: step.parameters.map(p => ({ key: p.key, label: p.label, unit: p.unit, required: p.required, limit: limitText(p) })) };
  }
  if (action === 'record') {
    const { step, parameter } = parameterFor(run, args.parameter);
    const value = number(args.value);
    const readings = state(run, step.id);
    const previous = readings[parameter.key];
    if (previous) {
      return { code: 'CORRECTION_REQUIRED', message: `${parameter.label} already has a ${previous.value} ${parameter.unit} reading. Use a correction to change it.`, previous };
    }
    const ok = within(parameter, value);
    readings[parameter.key] = { value, status: ok ? 'valid' : 'pending', time: new Date().toISOString() };
    event(run, ok ? 'READING_RECORDED' : 'DEVIATION_PENDING', `${parameter.label}: ${value} ${parameter.unit}${ok ? ' — within limits' : ' — outside limits, confirmation required'}`, { stepId: step.id, parameter: parameter.key, value });
    return { code: ok ? 'RECORDED' : 'OUT_OF_RANGE', message: ok ? `${parameter.label} ${value} ${parameter.unit} recorded. ${missing(run).length ? `Still needed: ${missing(run).map(p => p.label).join(', ')}.` : 'All required readings are present.'}` : `${parameter.label} ${value} ${parameter.unit} is outside ${limitText(parameter)}. Confirm the reading or correct it.`, limit: limitText(parameter) };
  }
  if (action === 'confirm_deviation') {
    const { step, parameter } = parameterFor(run, args.parameter);
    const entry = state(run, step.id)[parameter.key];
    if (!entry || entry.status !== 'pending') throw new DomainError('There is no pending deviation for this parameter.', 409);
    entry.status = 'deviation';
    event(run, 'DEVIATION_CONFIRMED', `${parameter.label}: ${entry.value} ${parameter.unit} confirmed outside ${limitText(parameter)}. Step remains blocked.`, { stepId: step.id, parameter: parameter.key, value: entry.value });
    return { code: 'DEVIATION_CONFIRMED', message: `Deviation confirmed. ${parameter.label} remains outside limits. Correct the reading before this step can complete.` };
  }
  if (action === 'correct') {
    const { step, parameter } = parameterFor(run, args.parameter);
    const value = number(args.value);
    const readings = state(run, step.id);
    const previous = readings[parameter.key];
    if (!previous) throw new DomainError('Record an initial reading before correcting it.', 409);
    if (value === previous.value) throw new DomainError('The corrected value must differ.', 409);
    const reason = text(args.reason, 160) || 'Operator correction';
    const ok = within(parameter, value);
    readings[parameter.key] = { value, status: ok ? 'valid' : 'pending', time: new Date().toISOString() };
    event(run, 'READING_CORRECTED', `${parameter.label}: ${previous.value} → ${value} ${parameter.unit}. ${reason}.${ok ? '' : ' Outside limits; confirmation required.'}`, { stepId: step.id, parameter: parameter.key, previousValue: previous.value, value, reason });
    return { code: ok ? 'CORRECTED' : 'OUT_OF_RANGE', message: ok ? `Correction saved: ${parameter.label} ${previous.value} to ${value} ${parameter.unit}. The previous value remains in the audit trail.` : `Correction saved, but ${value} ${parameter.unit} is outside ${limitText(parameter)}. Confirm or correct it again.` };
  }
  if (action === 'complete_step') {
    const step = active(run);
    const needed = missing(run).map(p => p.label);
    const blocked = Object.entries(state(run, step.id)).filter(([, v]) => v.status !== 'valid').map(([key]) => step.parameters.find(p => p.key === key)?.label || key);
    if (needed.length || blocked.length) return { code: 'STEP_BLOCKED', message: `Cannot complete ${step.name}. ${needed.length ? `Missing: ${needed.join(', ')}. ` : ''}${blocked.length ? `Resolve: ${blocked.join(', ')}.` : ''}` };
    event(run, 'STEP_COMPLETED', `${step.name} completed`, { stepId: step.id });
    if (run.stepIndex + 1 === run.template.steps.length) {
      run.status = 'complete';
      event(run, 'RUN_COMPLETED', 'All batch steps completed');
      return { code: 'RUN_COMPLETED', message: 'Batch complete. Audit record is ready.' };
    }
    run.stepIndex++;
    const next = run.template.steps[run.stepIndex];
    event(run, 'STEP_STARTED', `${next.name} started`, { stepId: next.id });
    return { code: 'STEP_ADVANCED', message: `${step.name} complete. Next step: ${next.name}.`, stepChanged: true };
  }
  throw new DomainError('Unknown action.', 404);
}

export function missing(run) {
  const step = run.template.steps[run.stepIndex];
  return step.parameters.filter(p => p.required && !run.readings[step.id]?.[p.key]);
}
