const TOOL_DEFINITIONS = [
  { type: 'function', name: 'get_batch_status', description: 'Fetch the active batch step, recorded readings and remaining requirements.', parameters: { type: 'object', properties: {} } },
  { type: 'function', name: 'record_reading', description: 'Record a spoken numeric measurement for the active step. Never claim a value was saved before the tool returns.', parameters: { type: 'object', properties: { parameter: { type: 'string', description: 'Exact parameter key for the active step.' }, value: { type: 'number', description: 'Numeric measurement, including decimal places exactly as spoken.' } }, required: ['parameter', 'value'] } },
  { type: 'function', name: 'correct_reading', description: 'Amend a previously recorded or pending reading after the operator explicitly says it was wrong. Keep old value in audit history.', parameters: { type: 'object', properties: { parameter: { type: 'string' }, value: { type: 'number' }, reason: { type: 'string', description: 'Short reason, e.g. operator correction.' } }, required: ['parameter', 'value'] } },
  { type: 'function', name: 'confirm_deviation', description: 'Confirm an out-of-range measurement only if the operator explicitly confirms the exact value. The step stays blocked.', parameters: { type: 'object', properties: { parameter: { type: 'string' } }, required: ['parameter'] } },
  { type: 'function', name: 'complete_step', description: 'Attempt to complete the current process step only when asked. Backend may block missing or deviating readings.', parameters: { type: 'object', properties: {} } }
];

export function sessionContext(run) {
  const step = run.template.steps[run.stepIndex];
  const parameters = step.parameters.map(p => `${p.key} (${p.label}, ${p.unit || 'unitless'})`).join('; ');
  const keys = step.parameters.map(p => p.key);
  const tools = structuredClone(TOOL_DEFINITIONS);
  if (run.status === 'complete') {
    return {
      system_prompt: `Batch ${run.batchCode} for ${run.template.title} is complete. Tell the operator that the run is finished, and direct them to export the audit record on screen. Only use get_batch_status for final status questions. Do not record or correct further readings or claim authorization for manufacturing use.`,
      input: { keyterms: [run.batchCode, run.template.title], turn_detection: { interrupt_response: true } },
      tools: tools.filter(tool => tool.name === 'get_batch_status')
    };
  }
  for (const tool of tools) {
    if (tool.parameters.properties.parameter) tool.parameters.properties.parameter.enum = keys;
  }
  return {
    system_prompt: `You are the BatchRunner voice assistant for batch ${run.batchCode}. Current product: ${run.template.title}. Current step: ${step.name}. Expected parameter keys: ${parameters}. Speak briefly and clearly. Use record_reading for new measurements and correct_reading for an explicit correction. For multiple numbers call a tool for each, one at a time. Use get_batch_status for questions about progress. Do not guess missing numeric values or silently reinterpret decimal points or units. If speech is ambiguous, read the value back and ask for clarification before calling a tool. Never decide whether a measurement is safe or valid yourself; the BatchRunner backend owns all limits and state. Report the tool result faithfully. For an out-of-range reading say the reported value and backend limit, then ask to confirm or correct. Never say a step has advanced until complete_step succeeds. A confirmed deviation still blocks advancement. If the operator interrupts, listen to the corrected value and call correct_reading when appropriate. This is a demonstration, not manufacturing authorization.`,
    input: { keyterms: [run.batchCode, step.name, ...step.parameters.flatMap(p => [p.label, p.unit].filter(Boolean))].slice(0, 100), turn_detection: { interrupt_response: true } },
    tools
  };
}

export class VoiceSession {
  constructor({ onTool, onTranscript, onStatus, afterTool }) {
    this.onTool = onTool; this.onTranscript = onTranscript; this.onStatus = onStatus; this.afterTool = afterTool;
    this.connected = false; this.pending = []; this.scheduled = []; this.nextPlayback = 0;
    this.lastTurnEvent = null; this.processingTools = false; this.completedCalls = new Set();
  }

  async connect(run) {
    if (this.connected || this.ws) return;
    this.lastConnectionError = null;
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('Microphone and AudioWorklet require a supported browser and HTTPS or localhost.');
    let stream, context;
    try {
      const response = await fetch('/api/voice-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: run.id }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not create a voice token.');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      context = new AudioContext(); await context.resume(); await context.audioWorklet.addModule('/pcm-worklet.js');
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, 'capture-processor');
      source.connect(worklet).connect(context.destination);
      this.stream = stream; this.context = context; this.worklet = worklet; this.nextPlayback = context.currentTime;
      const url = new URL('wss://agents.assemblyai.com/v1/ws'); url.searchParams.set('token', payload.token);
      const ws = new WebSocket(url); this.ws = ws;
       this.readyTimer = setTimeout(() => { if (!this.connected && this.ws === ws) { this.lastConnectionError = 'Voice setup timed out. Check your API key and network, then try again.'; ws.close(); } }, 15000);
      worklet.port.onmessage = event => {
        if (!this.connected || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 750_000) return;
        const bytes = new Uint8Array(event.data); let raw = '';
        for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
        ws.send(JSON.stringify({ type: 'input.audio', audio: btoa(raw) }));
      };
      ws.onopen = () => {
        const context = sessionContext(run);
        ws.send(JSON.stringify({ type: 'session.update', session: {
          ...context, greeting: `Batch ${run.batchCode} is ready. We are at ${run.template.steps[run.stepIndex].name}. Please tell me the first reading.`,
          output: { voice: 'alba', format: { encoding: 'audio/pcm' } },
          input: { ...context.input, format: { encoding: 'audio/pcm' } }
        } }));
      };
      ws.onmessage = event => { try { Promise.resolve(this.handle(JSON.parse(event.data))).catch(e => this.onStatus(e.message)); } catch (e) { this.onStatus(e.message); } };
      ws.onerror = () => { this.lastConnectionError = 'Voice connection error. Check your key and network, then try again.'; };
      ws.onclose = () => { const message = this.lastConnectionError || 'Voice session ended.'; this.cleanup(); this.onStatus(message); };
      this.onStatus('Connecting to AssemblyAI…');
    } catch (error) {
      stream?.getTracks().forEach(t => t.stop()); await context?.close();
      this.ws = null; throw error;
    }
  }

  updateContext(run) {
    if (this.ws?.readyState === WebSocket.OPEN && this.connected) this.ws.send(JSON.stringify({ type: 'session.update', session: sessionContext(run) }));
  }

  handle(event) {
    switch (event.type) {
      case 'session.ready': clearTimeout(this.readyTimer); this.connected = true; this.onStatus('Listening · AssemblyAI connected'); break;
      case 'session.ended': this.ws?.close(); break;
      case 'session.error': this.lastConnectionError = `Voice error: ${event.message || event.code}`; this.onStatus(this.lastConnectionError); if (!this.connected) this.ws?.close(); break;
      case 'transcript.user': this.onTranscript('Operator', event.text); break;
      case 'transcript.agent': this.onTranscript('BatchRunner', event.text); break;
      case 'reply.audio': this.play(event.data); break;
      case 'reply.started': this.lastTurnEvent = event.type; break;
      case 'input.speech.started': this.lastTurnEvent = event.type; this.stopPlayback(); break;
      case 'tool.call':
        if (!this.completedCalls.has(event.call_id) && !this.pending.some(item => item.call.call_id === event.call_id)) {
          this.pending.push({ call: event });
        }
        this.flushTools(); break;
      case 'reply.done':
        this.lastTurnEvent = event.status === 'interrupted' ? 'interrupted' : 'reply.done';
        if (event.status === 'interrupted') { this.stopPlayback(); this.pending = []; }
        else this.flushTools();
        break;
    }
  }

  async flushTools() {
    if (this.processingTools || this.lastTurnEvent !== 'reply.done') return;
    this.processingTools = true;
    try {
      while (this.pending.length && this.lastTurnEvent === 'reply.done' && this.ws?.readyState === WebSocket.OPEN) {
        const item = this.pending[0];
        const { call } = item;
        if (!item.response) {
          try {
            const result = await this.onTool(call.name, call.arguments || {}, call.call_id);
            item.response = { type: 'tool.result', call_id: call.call_id, result: JSON.stringify(result) };
            item.result = result;
          } catch (error) {
            item.response = { type: 'tool.result', call_id: call.call_id, result: JSON.stringify({ error: error.message }), is_error: true };
          }
        }
        if (this.lastTurnEvent !== 'reply.done' || this.pending[0] !== item || this.ws?.readyState !== WebSocket.OPEN) break;
        this.ws.send(JSON.stringify(item.response));
        this.completedCalls.add(call.call_id);
        this.pending.shift();
        if (item.result) this.afterTool?.(item.result);
      }
    } finally {
      this.processingTools = false;
    }
  }

  play(base64) {
    if (!this.context || !base64) return;
    const raw = atob(base64); const count = Math.floor(raw.length / 2);
    const buffer = this.context.createBuffer(1, count, 24000);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < count; i++) { const word = raw.charCodeAt(i * 2) | raw.charCodeAt(i * 2 + 1) << 8; out[i] = (word > 32767 ? word - 65536 : word) / 32768; }
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    const now = this.context.currentTime; if (this.nextPlayback < now) this.nextPlayback = now;
    source.start(this.nextPlayback); this.nextPlayback += buffer.duration; this.scheduled.push(source);
    source.onended = () => { this.scheduled = this.scheduled.filter(s => s !== source); };
  }

  stopPlayback() {
    for (const source of this.scheduled) { try { source.stop(); } catch {} }
    this.scheduled = []; if (this.context) this.nextPlayback = this.context.currentTime;
  }

  async disconnect() {
    const ws = this.ws;
    if (!ws) return;
    this.stream?.getTracks().forEach(track => track.stop());
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'session.end' }));
      await new Promise(resolve => {
        const timer = setTimeout(() => { ws.close(); resolve(); }, 3000);
        ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    } else ws.close();
    this.cleanup(); this.onStatus('Voice session ended.');
  }

  cleanup() {
    clearTimeout(this.readyTimer); this.connected = false; this.pending = []; this.lastTurnEvent = null; this.processingTools = false; this.completedCalls.clear(); this.stopPlayback();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.context && this.context.state !== 'closed') this.context.close();
    this.context = null; this.worklet = null; this.ws = null; this.lastConnectionError = null;
  }
}
