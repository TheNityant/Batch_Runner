import { VoiceSession } from './voice.js';
import { createBuilder } from './builder.js';

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const view = { samples: [], run: null, voiceConfigured: false, voiceUnlocked: false, accessRequired: false, deploymentReady: true, voice: null, builder: null, tour: -1 };
let toastTimer;

async function api(path, method = 'GET', data) {
  const response = await fetch(path, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (payload.code === 'STALE_RUN' && payload.run) { view.run = payload.run; render(); }
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}
function toast(message, error = false) {
  const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 5200);
}
const step = () => view.run?.template.steps[view.run.stepIndex];
const reading = key => view.run?.readings[step()?.id]?.[key];
const limit = p => p.min != null && p.max != null ? `${p.min}–${p.max} ${p.unit}` : p.min != null ? `≥ ${p.min} ${p.unit}` : `≤ ${p.max} ${p.unit}`;
function downloadJson(template, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' }));
  link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function loadTemplate(template) {
  if (view.voice?.ws) await view.voice.disconnect();
  const { run } = await api('/api/runs', 'POST', { template });
  view.run = run; localStorage.setItem('batchrunner_run_id', run.id); render(); $('#run-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(`${run.template.title} loaded. Start the batch to record readings.`);
}
async function action(name, args = {}, quiet = false, fromVoice = false, requestId = crypto.randomUUID()) {
  if (!view.run) throw new Error('Load a template first.');
  const { run, result } = await api(`/api/runs/${view.run.id}/actions`, 'POST', { action: name, args, requestId, expectedVersion: view.run.version || 0 });
  view.run = run; render();
  if (name === 'record' && ['RECORDED', 'OUT_OF_RANGE'].includes(result.code)) {
    const next = step().parameters.find(p => p.required && !run.readings[step().id]?.[p.key]);
    if (next) { $('#parameter-select').value = next.key; renderPending(); }
  }
  if (view.voice?.connected && (result.stepChanged || run.status === 'complete') && !fromVoice) view.voice.updateContext(run);
  if (!quiet) toast(result.message, ['OUT_OF_RANGE', 'STEP_BLOCKED', 'CORRECTION_REQUIRED'].includes(result.code));
  return result;
}
const safeAction = async (name, args) => { try { return await action(name, args); } catch (e) { toast(e.message, true); } };

function renderSamples() {
  const icons = ['✳', '◌', '⌘'];
  $('#template-grid').innerHTML = view.samples.map((entry, i) => `<div class="template-card"><div class="template-top"><span class="template-icon">${icons[i % 3]}</span><span class="template-industry">${escapeHtml(entry.template.industry)}</span></div><h3>${escapeHtml(entry.template.title)}</h3><p>${escapeHtml(entry.template.description)}</p><div class="template-meta"><span>${entry.template.steps.length} PROCESS STEPS</span><span><button data-download="${i}">↓ JSON</button><button data-customize="${i}">Customize</button><button data-sample="${i}">Load →</button></span></div></div>`).join('');
  document.querySelectorAll('[data-sample]').forEach(button => button.onclick = () => loadTemplate(view.samples[Number(button.dataset.sample)].template).catch(e => toast(e.message, true)));
  document.querySelectorAll('[data-customize]').forEach(button => button.onclick = () => view.builder.open(view.samples[Number(button.dataset.customize)].template));
  document.querySelectorAll('[data-download]').forEach(button => button.onclick = () => { const sample = view.samples[Number(button.dataset.download)]; downloadJson(sample.template, sample.filename); });
}

function render() {
  const run = view.run;
  $('#run-area').classList.toggle('hidden', !run);
  if (!run) return;
  const current = step();
  $('#run-title').textContent = run.template.title;
  $('#run-subtitle').textContent = `${run.batchCode} · ${run.template.industry} · ${run.operator}`;
  $('#run-chip').textContent = run.status === 'ready' ? 'Ready to start' : run.status === 'active' ? 'In progress' : 'Completed';
  $('#run-chip').classList.toggle('complete', run.status === 'complete');
  $('#progress-caption').textContent = `${Math.min(run.stepIndex + 1, run.template.steps.length)} OF ${run.template.steps.length} STEPS`;
  $('#step-progress').innerHTML = run.template.steps.map((s, i) => `<div class="progress-item ${i < run.stepIndex || run.status === 'complete' ? 'done' : i === run.stepIndex ? 'active' : ''}"><span class="progress-track"></span><span>${String(i + 1).padStart(2, '0')} ${escapeHtml(s.name)}</span></div>`).join('');
  $('#step-counter').textContent = `STEP ${String(run.stepIndex + 1).padStart(2, '0')} / ${String(run.template.steps.length).padStart(2, '0')}`;
  $('#step-name').textContent = current.name;
  $('#step-description').textContent = current.description;
  $('#parameter-rows').innerHTML = current.parameters.map(p => {
    const r = reading(p.key); const status = r?.status || 'waiting';
    return `<div class="parameter-row"><strong>${escapeHtml(p.label)}${p.required ? '' : ' <small class="muted">optional</small>'}</strong><span class="muted">${escapeHtml(limit(p))}</span><span class="value">${r ? `${escapeHtml(r.value)} ${escapeHtml(p.unit)}` : '—'}</span><span><span class="tag ${status}">${status === 'waiting' ? 'Awaiting' : status === 'valid' ? 'Within limits' : status === 'pending' ? 'Confirm value' : 'Deviation'}</span></span></div>`;
  }).join('');
  $('#complete-step').textContent = run.status === 'ready' ? 'Start batch →' : run.status === 'complete' ? 'Batch complete ✓' : run.stepIndex === run.template.steps.length - 1 ? 'Finish batch →' : 'Complete step →';
  $('#complete-step').disabled = run.status === 'complete';
  $('#step-note').textContent = run.status === 'complete' ? 'All steps completed. Export the audit record.' : 'Required readings must be valid before moving ahead.';
  $('#audit-count').textContent = `${run.events.length} event${run.events.length === 1 ? '' : 's'}`;
  $('#audit-list').innerHTML = [...run.events].reverse().map(e => `<div class="audit-event ${/DEVIATION/.test(e.type) ? 'warning' : ''}"><span class="audit-bullet"></span><div><strong>${escapeHtml(e.message)}</strong><small>${new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${escapeHtml(e.type.replaceAll('_', ' '))}</small></div></div>`).join('');
  const previousParameter = $('#parameter-select').value;
  $('#parameter-select').innerHTML = current.parameters.map(p => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.label)} (${escapeHtml(p.unit)})</option>`).join('');
  if (current.parameters.some(p => p.key === previousParameter)) $('#parameter-select').value = previousParameter;
  renderPending(); renderScenarios(); renderVoice();
}

function renderPending() {
  const key = $('#parameter-select').value;
  const r = reading(key);
  const el = $('#pending-actions'); el.replaceChildren();
  if (!r) return;
  const box = document.createElement('div'); box.className = 'pending-box';
  box.textContent = `Current reading: ${r.value}. Changes create a new audit entry. `;
  const correction = document.createElement('button'); correction.textContent = 'Correct using value above →';
  correction.onclick = () => { const value = Number($('#reading-value').value); if ($('#reading-value').value === '' || !Number.isFinite(value)) return toast('Enter a corrected value first.', true); safeAction('correct', { parameter: key, value, reason: 'Operator correction' }); };
  box.append(correction);
  if (r.status === 'pending') {
    const confirm = document.createElement('button'); confirm.textContent = 'Confirm out-of-range reading →';
    confirm.onclick = () => safeAction('confirm_deviation', { parameter: key }); box.append(confirm);
  }
  el.append(box);
}

function renderScenarios() {
  const el = $('#scenario-list'); const run = view.run;
  if (run.status === 'complete') { el.innerHTML = '<div class="scenario">Batch complete. Explore the audit timeline or load a new process.</div>'; return; }
  const p = step().parameters[0]; const dev = step().parameters.find(x => x.max !== null) || p;
  const good = p.min !== null && p.max !== null ? Number(((p.min + p.max) / 2).toFixed(2)) : p.min ?? p.max;
  const bad = dev.max !== null ? Number((dev.max + Math.max(1, (dev.max - (dev.min ?? dev.max - 5)) * .15)).toFixed(2)) : dev.min - 1;
  el.innerHTML = `<div class="scenario"><small>01 · WITHIN LIMITS</small><p>“${escapeHtml(p.label)} ${good}.”</p><button data-scenario="good">Run example →</button></div><div class="scenario warning"><small>02 · TRIGGER A DEVIATION</small><p>“${escapeHtml(dev.label)} ${bad}.” <span class="muted">Allowed: ${escapeHtml(limit(dev))}</span></p><button data-scenario="bad">Run example →</button></div><div class="scenario"><small>03 · CORRECT THE RECORD</small><p>“Sorry, change ${escapeHtml(dev.label)} to ${dev.max !== null ? dev.max : dev.min}.”</p><button data-scenario="correct">Run example →</button></div>`;
  el.querySelector('[data-scenario="good"]').onclick = () => safeAction(reading(p.key) && reading(p.key).value !== good ? 'correct' : 'record', { parameter: p.key, value: good, reason: 'Demo correction' });
  el.querySelector('[data-scenario="bad"]').onclick = () => safeAction(reading(dev.key) && reading(dev.key).value !== bad ? 'correct' : 'record', { parameter: dev.key, value: bad, reason: 'Demo deviation' });
  el.querySelector('[data-scenario="correct"]').onclick = () => safeAction('correct', { parameter: dev.key, value: dev.max ?? dev.min, reason: 'Spoken operator correction' });
}

function renderVoice() {
  const connected = Boolean(view.voice?.connected);
  $('#voice-card').classList.toggle('active', connected);
  $('#voice-heading').textContent = connected ? (view.run.status === 'complete' ? 'Batch complete · final recap' : 'Listening to your batch') : 'Ready when you are';
  $('#voice-description').textContent = connected ? (view.run.status === 'complete' ? 'Ask for final status, then export the audit record. Recording is closed.' : 'Speak a reading, request the current step, or correct a value. You can interrupt the agent.') : view.run.status === 'ready' ? 'Start the batch, then connect your microphone to capture readings by voice.' : view.run.status === 'complete' ? 'This batch is complete. Export the audit record.' : 'Connect your microphone to record readings hands-free.';
  $('#voice-button').textContent = connected ? 'End voice session' : 'Start voice session ↗';
  const locked = view.accessRequired && !view.voiceUnlocked;
  $('#voice-access-form').classList.toggle('hidden', !view.voiceConfigured || !view.deploymentReady || !locked);
  $('#voice-button').disabled = !connected && (view.run.status !== 'active' || !view.voiceConfigured || !view.deploymentReady || locked);
  $('#voice-note').textContent = !view.voiceConfigured ? 'Live voice needs ASSEMBLYAI_API_KEY on the server. On-screen demo is available.' : !view.deploymentReady ? 'Production voice needs origin, session secret and demo access code configuration.' : locked ? 'Enter the demo access code to enable AssemblyAI voice.' : 'Live AssemblyAI voice · microphone permission required';
}

const tourSteps = [
  { title: 'Choose a sample process', body: 'Load the tablet batch. The same engine also accepts the yogurt, paint and your own JSON recipe.', target: '#template-grid', label: 'Load tablet demo', run: async () => loadTemplate(view.samples.find(x => x.filename.includes('tablet'))?.template || view.samples[0].template) },
  { title: 'A recipe becomes a workflow', body: 'Each step defines required parameters and numeric limits. Start the batch to unlock recording.', target: '#step-card', label: 'Start batch', run: () => action('start') },
  { title: 'Record a valid reading', body: 'Try saying “Temperature 47.3” with the live voice agent. This button sends that value through the same validation endpoint.', target: '#parameter-rows', label: 'Record 47.3 °C', run: () => action('record', { parameter: 'temperature', value: 47.3 }) },
  { title: 'Catch a contradictory value', body: 'If the operator later says “Temperature 48.3” as a new reading, BatchRunner refuses to replace 47.3 silently. The conflict appears in the audit timeline.', target: '#audit-card', label: 'Try conflicting value', run: () => action('record', { parameter: 'temperature', value: 48.3 }) },
  { title: 'Missing values block progress', body: 'Try completing the step now. Mixer speed and moisture are still required, so the rule engine refuses to advance.', target: '#complete-step', label: 'Try completing step', run: () => action('complete_step') },
  { title: 'Trigger a deviation', body: 'Say “Mixer speed 435 RPM.” The configured maximum is 420. BatchRunner flags the value and requests confirmation.', target: '#parameter-rows', label: 'Record 435 RPM', run: () => action('record', { parameter: 'mixer_rpm', value: 435 }) },
  { title: 'Correct it without erasing history', body: 'Say “Sorry, change mixer speed to 415.” The new value passes; the original 435 remains in the audit record.', target: '#audit-card', label: 'Correct to 415 RPM', run: () => action('correct', { parameter: 'mixer_rpm', value: 415, reason: 'Operator correction' }) },
  { title: 'Finish the step', body: 'Add moisture 2.1%, then move to compression. The voice agent changes its expected vocabulary as the step changes.', target: '#step-progress', label: 'Add moisture & advance', run: async () => { await action('record', { parameter: 'moisture', value: 2.1 }, true); await action('complete_step'); } },
  { title: 'Inspect the complete trace', body: 'The timeline retains each action, value, correction and step transition. Download the full JSON audit record at any time.', target: '#audit-card', label: 'Finish guide', run: async () => {} }
];
function positionTour(target) {
  const pop = $('#tour-popover'); pop.classList.remove('anchored'); pop.style.left = ''; pop.style.top = '';
  if (!target || window.innerWidth < 560) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => {
    if (view.tour < 0) return;
    const rect = target.getBoundingClientRect();
    let left = rect.right + 18;
    if (left + 370 > window.innerWidth) left = rect.left - 388;
    if (left < 15) left = Math.max(15, (window.innerWidth - 370) / 2);
    pop.classList.add('anchored'); pop.style.left = `${left}px`; pop.style.top = `${Math.max(15, Math.min(rect.top, window.innerHeight - pop.offsetHeight - 15))}px`;
  }, 260);
}
function showTour(index) {
  document.querySelectorAll('.tour-target').forEach(x => x.classList.remove('tour-target'));
  if (index < 0 || index >= tourSteps.length) { view.tour = -1; $('#tour-backdrop').classList.add('hidden'); $('#tour-popover').classList.add('hidden'); return; }
  view.tour = index; const item = tourSteps[index]; const target = $(item.target);
  $('#tour-backdrop').classList.remove('hidden'); $('#tour-popover').classList.remove('hidden');
  $('#tour-step-label').textContent = `GUIDED DEMO · ${index + 1} OF ${tourSteps.length}`;
  $('#tour-title').textContent = item.title; $('#tour-body').textContent = item.body; $('#tour-next').textContent = item.label + ' →';
  target?.classList.add('tour-target'); positionTour(target);
}
async function tourNext() {
  const current = view.tour; if (current < 0) return;
  $('#tour-next').disabled = true;
  try { await tourSteps[current].run(); showTour(current + 1); } catch (e) { toast(e.message, true); }
  finally { $('#tour-next').disabled = false; }
}

function bind() {
  $('#hero-demo').onclick = $('#open-guide').onclick = $('#help-button').onclick = () => showTour(0);
  $('#tour-close').onclick = $('#tour-skip').onclick = () => showTour(-1);
  $('#tour-next').onclick = tourNext;
  $('#hero-template').onclick = () => $('#workspace-head').scrollIntoView({ behavior: 'smooth' });
  document.querySelectorAll('.nav-item').forEach(button => button.onclick = () => { document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('selected')); button.classList.add('selected'); if (button.dataset.view === 'builder') view.builder.open(); else { const target = button.dataset.view === 'audit' ? '#audit-card' : button.dataset.view === 'templates' ? '#workspace-head' : '#hero'; $(target)?.scrollIntoView({ behavior: 'smooth' }); } $('#breadcrumb').textContent = button.textContent.trim(); });
  $('#open-builder').onclick = () => view.builder.open();
  $('#complete-step').onclick = () => safeAction(view.run.status === 'ready' ? 'start' : 'complete_step');
  $('#reading-form').onsubmit = async event => {
    event.preventDefault();
    if (view.run?.status !== 'active') return toast('Start the batch first.', true);
    const raw = $('#reading-value').value;
    if (raw === '' || !Number.isFinite(Number(raw))) return toast('Enter a numeric value.', true);
    const result = await safeAction('record', { parameter: $('#parameter-select').value, value: Number(raw) });
    if (result) $('#reading-value').value = '';
  };
  $('#parameter-select').onchange = renderPending;
  $('#voice-button').onclick = async () => { try { if (view.voice?.connected) await view.voice.disconnect(); else await view.voice.connect(view.run); renderVoice(); } catch (e) { toast(e.message, true); renderVoice(); } };
  $('#voice-access-form').onsubmit = async event => { event.preventDefault(); try { const state = await api('/api/voice-access', 'POST', { code: $('#voice-access-code').value }); view.voiceUnlocked = state.voiceUnlocked; $('#voice-access-code').value = ''; renderVoice(); toast('Voice access unlocked for this browser session.'); } catch (e) { toast(e.message, true); } };
  $('#export-button').onclick = () => { if (view.run) location.href = `/api/runs/${view.run.id}/export`; };
  $('#download-template').onclick = () => { const template = view.samples[0]?.template; if (template) downloadJson(template, 'batchrunner-example.json'); };
  $('#browse-button').onclick = () => $('#file-input').click();
  $('#file-input').onchange = event => upload(event.target.files?.[0]);
  const zone = $('#upload-zone'); zone.ondragover = event => { event.preventDefault(); zone.classList.add('dragging'); };
  zone.ondragleave = () => zone.classList.remove('dragging'); zone.ondrop = event => { event.preventDefault(); zone.classList.remove('dragging'); upload(event.dataTransfer.files?.[0]); };
}
async function upload(file) {
  if (!file) return;
  if (file.size > 128_000 || !file.name.toLowerCase().endsWith('.json')) return toast('Choose a .json file under 128 KB.', true);
  try { await loadTemplate(JSON.parse(await file.text())); } catch (e) { toast(`Template could not be loaded: ${e.message}`, true); }
  $('#file-input').value = '';
}

async function init() {
  bind(); $('#clock').textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date());
  view.builder = createBuilder({ onLoad: loadTemplate, onError: message => toast(message, true) });
  try {
    const [samples, health] = await Promise.all([api('/api/samples'), api('/api/health')]);
    view.samples = samples; Object.assign(view, { voiceConfigured: health.voiceConfigured, voiceUnlocked: health.voiceUnlocked, accessRequired: health.accessRequired, deploymentReady: health.deploymentReady });
    view.voice = new VoiceSession({ onTool: async (name, args, callId) => {
      const operations = { record_reading: 'record', correct_reading: 'correct', confirm_deviation: 'confirm_deviation', complete_step: 'complete_step', get_batch_status: 'get_status' };
      if (!operations[name]) throw new Error('Unknown voice operation.');
      const result = await action(operations[name], args, true, true, callId);
      return { ...result, batchStatus: view.run.status, currentStep: step().name };
    }, onTranscript: (speaker, content) => {
      $('#transcript').textContent = `${speaker}: ${content}`;
    }, onStatus: message => { renderVoice(); $('#voice-note').textContent = message; }, afterTool: result => { if (result.stepChanged || view.run.status === 'complete') view.voice.updateContext(view.run); } });
    renderSamples();
    const savedId = localStorage.getItem('batchrunner_run_id');
    if (savedId) {
      try { view.run = (await api(`/api/runs/${savedId}`)).run; }
      catch { localStorage.removeItem('batchrunner_run_id'); }
    }
    render();
  } catch (e) {
    $('#workspace-head p').textContent = 'Backend not connected. Deploy the BatchRunner API and route /api requests to it to use recipes, readings and voice.';
    toast(`Could not load workspace: ${e.message}`, true);
  }
}
init();
