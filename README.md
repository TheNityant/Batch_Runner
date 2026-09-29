# BatchRunner

**Turn a batch recipe into a voice-executable process.** BatchRunner is a hackathon prototype for guided batch execution across industries. A manager loads a JSON process definition; an operator records readings by voice or on screen; a deterministic server validates each value, blocks missing or deviating steps, and keeps an audit timeline.

## Try it locally

Requires Node.js 20 or later. No npm dependencies or build step.

```bash
npm start
```

Open `http://localhost:3000`, select **Take the guided demo**, then follow the steps. Use **Recipe designer** to edit a sample or make a new batch definition with normal form controls; the JSON import and export work too. The on-screen controls work without API credentials. To enable live voice, set `ASSEMBLYAI_API_KEY` in the server environment and restart:

```bash
ASSEMBLYAI_API_KEY=your_key npm start
```

Use HTTPS (or localhost) for microphone access. Do not expose the key to the browser. The server issues single-use temporary tokens. This implementation uses inline session configuration so each batch step can change the system prompt and transcription keyterms while the session is open.

## Guided judge walkthrough

1. Load **Tablet manufacturing** (or download its JSON and re-upload it). You can also customize it through **Recipe designer**.
2. Start the run and say **“Temperature 47.3.”** This value is within 45–50 °C.
3. Try a new **“Temperature 48.3.”** The conflicting value is logged without overwriting 47.3.
4. Try to complete the step early. It is blocked because readings are missing.
5. Say **“Mixer speed 435 RPM.”** This exceeds the example 420 RPM maximum; the value is pending confirmation.
6. Say **“Sorry, change mixer speed to 415 RPM.”** The audit trail keeps both 435 and 415.
7. Say **“Moisture 2.1 percent.”** Complete the step and see the agent switch context to compression.

The walkthrough buttons call the same server actions as the voice tool calls, so the full demo is accessible without a microphone. Other included templates cover yogurt production and paint blending. All example limits are **fictional or illustrative** and must never be used as manufacturing specifications.

## Template format

See [`samples/tablet-manufacturing.json`](samples/tablet-manufacturing.json). Each template has a `title`, `industry`, and ordered `steps`. Each step has an `id`, `name`, and `parameters`; each parameter has a unique `key`, display `label`, `unit`, numeric `min` and/or `max`, and `required` flag. Bounds are inclusive. Uploads have a 128 KB limit, at most 12 steps and 12 parameters per step.

## Architecture

```text
Browser microphone → AssemblyAI Voice Agent API → tool.call
                                             ↓
Browser tool adapter → BatchRunner HTTP API → deterministic run engine
                                             ↓
                            state + append-only event timeline
                                             ↓
                            tool.result → spoken response
```

The server owns limits, run state and audit events. A repeated reading needs an explicit correction. An out-of-range reading is retained as pending, then either confirmed as a deviation or corrected. Confirming a deviation does not allow the step to advance. The engine only advances when required values exist and every recorded value for that step is valid. The browser updates the AssemblyAI voice context on step transitions.

Run the engine, voice-event and HTTP checks with `npm test`. The `/api/health` endpoint reports whether voice is configured.

## Prototype boundaries

Run state is written to `.data/runs` and can be resumed in the same browser after a refresh or server restart. This local JSON store is for the prototype, not a production database. There is no user authentication, approval hierarchy, validated electronic signature, concurrency control, equipment connection, or regulatory compliance claim. Do not use this prototype for live production or safety decisions. Before a public multi-user deployment, add authentication, a transactional database, rate limiting, provenance for imported templates, and versioned approvals.

## Implementation references

- [AssemblyAI browser integration and temporary tokens](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration)
- [AssemblyAI inline session configuration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration)
- [AssemblyAI client tool events](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference)
- [AssemblyAI tool guidance](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview)
- [ISA-88 batch-control standards](https://www.isa.org/standards-and-publications/isa-standards/isa-88-standards)
