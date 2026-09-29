import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.env.BATCHRUNNER_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '.data', 'runs');

export function loadRuns() {
  if (!existsSync(directory)) return new Map();
  const runs = new Map();
  for (const name of readdirSync(directory).filter(name => /^[a-f0-9-]+\.json$/.test(name))) {
    try {
      const run = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
      if (run.id === name.slice(0, -5) && run.template && Array.isArray(run.events)) runs.set(run.id, run);
    } catch (error) {
      console.error(`Could not load run ${name}: ${error.message}`);
    }
  }
  return runs;
}

export function saveRun(run) {
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${run.id}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(run, null, 2));
  renameSync(temporary, target);
}
