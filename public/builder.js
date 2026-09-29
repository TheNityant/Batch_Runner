const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slug = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
const newParameter = () => ({ key: '', label: '', unit: '', min: '', max: '', required: true });
const newStep = () => ({ id: '', name: '', description: '', parameters: [newParameter()] });

export function createBuilder({ onLoad, onError }) {
  let draft = { title: '', industry: '', description: '', steps: [newStep()] };
  const container = $('#builder-steps');

  function open(template) {
    draft = template ? structuredClone(template) : { title: '', industry: '', description: '', steps: [newStep()] };
    for (const step of draft.steps) for (const p of step.parameters) {
      p.min = p.min == null ? '' : String(p.min);
      p.max = p.max == null ? '' : String(p.max);
    }
    $('#builder-title').value = draft.title;
    $('#builder-industry').value = draft.industry;
    $('#builder-description').value = draft.description || '';
    render();
    $('#builder-area').classList.remove('hidden');
    $('#builder-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function render() {
    container.innerHTML = draft.steps.map((step, i) => `<div class="builder-step" data-step="${i}"><div class="builder-step-head"><h3>Step ${String(i + 1).padStart(2, '0')}</h3><button type="button" data-remove-step="${i}" ${draft.steps.length === 1 ? 'disabled' : ''}>Remove step</button></div><div class="builder-step-fields"><label>Step ID<input data-step-field="id" value="${escapeHtml(step.id)}" placeholder="e.g. granulation"></label><label>Step name<input data-step-field="name" value="${escapeHtml(step.name)}" placeholder="e.g. Granulation"></label><label>Operator instructions<input data-step-field="description" value="${escapeHtml(step.description)}" placeholder="What happens at this stage?"></label></div><div class="builder-param-head"><strong>MEASUREMENTS</strong><span>${step.parameters.length} / 12</span></div>${step.parameters.map((p, j) => `<div class="builder-param" data-param="${j}"><label>Key<input data-param-field="key" value="${escapeHtml(p.key)}" placeholder="mixer_rpm"></label><label>Display label<input data-param-field="label" value="${escapeHtml(p.label)}" placeholder="Mixer speed"></label><label>Unit<input data-param-field="unit" value="${escapeHtml(p.unit)}" placeholder="RPM"></label><label>Min<input data-param-field="min" type="number" step="any" value="${escapeHtml(p.min)}" placeholder="—"></label><label>Max<input data-param-field="max" type="number" step="any" value="${escapeHtml(p.max)}" placeholder="—"></label><label class="check"><input data-param-field="required" type="checkbox" ${p.required ? 'checked' : ''}> Required</label><button type="button" data-remove-param="${j}" aria-label="Remove parameter" ${step.parameters.length === 1 ? 'disabled' : ''}>×</button></div>`).join('')}<button type="button" class="builder-add-param" data-add-param="${i}" ${step.parameters.length >= 12 ? 'disabled' : ''}>+ Add measurement</button></div>`).join('');
  }

  function collect() {
    return { schemaVersion: 1, title: draft.title.trim(), industry: draft.industry.trim(), description: draft.description.trim(), steps: draft.steps.map(step => ({
      id: step.id.trim(), name: step.name.trim(), description: step.description.trim(),
      parameters: step.parameters.map(p => ({ key: p.key.trim(), label: p.label.trim(), unit: p.unit.trim(),
        min: p.min === '' ? null : Number(p.min), max: p.max === '' ? null : Number(p.max), required: p.required }))
    })) };
  }

  $('#builder-title').oninput = e => { draft.title = e.target.value; };
  $('#builder-industry').oninput = e => { draft.industry = e.target.value; };
  $('#builder-description').oninput = e => { draft.description = e.target.value; };
  container.oninput = e => {
    const stepElement = e.target.closest('[data-step]');
    if (!stepElement) return;
    const step = draft.steps[Number(stepElement.dataset.step)];
    const parameterElement = e.target.closest('[data-param]');
    if (parameterElement) {
      const field = e.target.dataset.paramField;
      step.parameters[Number(parameterElement.dataset.param)][field] = field === 'required' ? e.target.checked : e.target.value;
    } else if (e.target.dataset.stepField) step[e.target.dataset.stepField] = e.target.value;
  };
  container.onchange = e => { if (e.target.dataset.paramField === 'required') container.oninput(e); };
  container.onclick = e => {
    const { addParam, removeParam, removeStep } = e.target.dataset;
    if (addParam !== undefined) { if (draft.steps[Number(addParam)].parameters.length < 12) draft.steps[Number(addParam)].parameters.push(newParameter()); }
    else if (removeParam !== undefined) { const i = Number(e.target.closest('[data-step]').dataset.step); if (draft.steps[i].parameters.length > 1) draft.steps[i].parameters.splice(Number(removeParam), 1); }
    else if (removeStep !== undefined && draft.steps.length > 1) draft.steps.splice(Number(removeStep), 1);
    else return;
    render();
  };
  $('#builder-add-step').onclick = () => { if (draft.steps.length >= 12) return onError('A recipe can have up to 12 steps.'); draft.steps.push(newStep()); render(); };
  $('#builder-run').onclick = async () => { try { await onLoad(collect()); $('#builder-area').classList.add('hidden'); } catch (e) { onError(e.message); } };
  $('#builder-download').onclick = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(collect(), null, 2)], { type: 'application/json' }));
    link.download = `${slug(draft.title) || 'batchrunner-recipe'}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  $('#close-builder').onclick = () => $('#builder-area').classList.add('hidden');
  return { open };
}
