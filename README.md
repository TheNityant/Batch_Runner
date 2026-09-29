# BatchRunner

**Turn a batch recipe into a voice-executable process.** BatchRunner is a deployable hackathon demo for guided batch execution across industries. A manager loads a JSON process definition; an operator records readings by voice or on screen; a deterministic server validates each value, blocks missing or deviating steps, and keeps an audit timeline.

## Run locally

Install Node.js 24.10 or later. There are no npm packages to install or frontend build steps.

1. Copy `.env.example` to `.env` in the repository root (on Windows, use `copy .env.example .env`; on macOS/Linux, use `cp .env.example .env`).
2. Paste your API key into `ASSEMBLYAI_API_KEY=` in `.env`. Leave it blank if you want to test the full on-screen demo first. Keep `.env` private.
3. In the repository root, run `npm start` and open [http://localhost:3000](http://localhost:3000).
4. Choose **Take the guided demo**. Start the batch before connecting voice. Allow microphone access when prompted.

`npm start` loads `.env` automatically. On localhost, the production-only origin, secret and access-code settings should stay commented out. The on-screen workflow, validations and audit export run without an API key. Live voice needs a working AssemblyAI Voice Agent API key and an internet connection. Restart the server after changing `.env`.

**Docker alternative:** after creating `.env`, run `docker compose up --build`, then open [http://localhost:3000](http://localhost:3000). This local Compose configuration binds to 127.0.0.1 and keeps run data in a named volume; use `docker compose down` to stop it.

## Deploy a reviewable demo

Run a **single server instance** with a persistent writable directory. The included `Dockerfile` runs as a non-root user; mount a persistent volume at `/app/.data` and expose port 3000 through an HTTPS reverse proxy. Set these environment variables in the hosting platform (or provide them to your container runtime):

| Variable | Purpose |
| --- | --- |
| `NODE_ENV=production` | Enables production configuration checks. |
| `BATCHRUNNER_PUBLIC_ORIGIN` | Exact HTTPS origin, such as `https://demo.example.com`. |
| `BATCHRUNNER_SESSION_SECRET` | Stable random secret of at least 32 characters, kept outside the repo. |
| `BATCHRUNNER_DEMO_ACCESS_CODE` | Private code shared with judges to unlock live voice. |
| `ASSEMBLYAI_API_KEY` | Server-side AssemblyAI credential. Add when available. |
| `BATCHRUNNER_DATA_DIR` | Writable persistent run directory; Docker defaults to `/app/.data/runs`. |

For a public deployment, set `NODE_ENV=production`, use an HTTPS reverse proxy, and configure the production settings in the table; the local Compose file is intended for localhost review. The on-screen demo works without AssemblyAI credentials. In production mode the voice button stays disabled until the origin, stable session secret and demo access code are configured. The API key never reaches the browser; the browser receives a single-use token only for an active run it owns. Each browser has a signed, HttpOnly session cookie, run access is scoped to that session, requests are version checked and retries carry an ID. Basic rate limits protect run creation, actions, access-code attempts and token minting. A server restart does not invalidate the session when its secret and data volume persist.

Before sharing the URL, run `npm test`, check `/api/health`, complete the on-screen walkthrough, restart the server and verify the run resumes. Once the AssemblyAI key is set, run a real microphone session and test a valid value, a deviation, a correction, a step transition and a spoken interruption. GitHub Actions runs the automated checks on changes.

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

Run state is written to `.data/runs` and can be resumed in the same browser after a refresh or server restart. This local JSON store supports **one server instance** and is not a transactional multi-instance database. The signed session cookie is browser isolation for a public demo, not named user authentication. The audit timeline is not tamper-evident. There is no approval hierarchy, validated electronic signature, equipment connection, or regulatory compliance claim. Do not use this prototype for live production or safety decisions. A real manufacturing deployment needs authenticated roles, a transactional database, managed backups, template provenance and approvals, operations monitoring, and domain-specific validation.

## Implementation references

- [AssemblyAI browser integration and temporary tokens](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration)
- [AssemblyAI inline session configuration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration)
- [AssemblyAI client tool events](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference)
- [AssemblyAI tool guidance](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview)
- [ISA-88 batch-control standards](https://www.isa.org/standards-and-publications/isa-standards/isa-88-standards)
