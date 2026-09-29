import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from './engine.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.BATCHRUNNER_DATA_DIR || path.join(root, '.data', 'runs');
const publicOrigin = process.env.BATCHRUNNER_PUBLIC_ORIGIN || '';
const configuredSecret = process.env.BATCHRUNNER_SESSION_SECRET;
const accessCode = process.env.BATCHRUNNER_DEMO_ACCESS_CODE || '';
const isProduction = process.env.NODE_ENV === 'production';

if (configuredSecret && configuredSecret.length < 32) throw new Error('BATCHRUNNER_SESSION_SECRET must have at least 32 characters.');
if (publicOrigin && (!/^https?:\/\/[^/]+$/.test(publicOrigin) || (isProduction && !publicOrigin.startsWith('https://')))) {
  throw new Error('BATCHRUNNER_PUBLIC_ORIGIN must be a single origin (HTTPS in production).');
}

function secret() {
  if (configuredSecret) return configuredSecret;
  mkdirSync(dataDirectory, { recursive: true });
  const file = path.join(dataDirectory, '.session-secret');
  if (!existsSync(file)) {
    try { writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return readFileSync(file, 'utf8').trim();
}
const signingKey = secret();
const limitBuckets = new Map();
const unlocked = new Set();
const sign = id => createHmac('sha256', signingKey).update(id).digest('hex');

function equal(a, b) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sessionFor(req, res) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=').slice(0, 2)));
  const [id, signature] = (cookies.br_session || '').split('.');
  if (id && /^[a-f0-9-]{36}$/.test(id) && signature && equal(signature, sign(id))) return id;
  const newId = randomUUID();
  const secure = publicOrigin.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `br_session=${newId}.${sign(newId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`);
  return newId;
}

export function checkOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (origin && origin !== (publicOrigin || `http://${req.headers.host}`)) {
    throw new DomainError('Request origin is not allowed.', 403, 'ORIGIN_FORBIDDEN');
  }
  if (isProduction && !publicOrigin) throw new DomainError('Server origin is not configured.', 503, 'ORIGIN_NOT_CONFIGURED');
}

export function requireJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new DomainError('Expected application/json.', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

export function limit(key, max, intervalMs) {
  const now = Date.now();
  const bucket = limitBuckets.get(key) || [];
  const recent = bucket.filter(time => now - time < intervalMs);
  if (recent.length >= max) throw new DomainError('Too many requests. Please try again later.', 429, 'RATE_LIMITED');
  recent.push(now); limitBuckets.set(key, recent);
  if (limitBuckets.size > 5000) for (const [name, times] of limitBuckets) {
    if (times.every(time => now - time > 3600000)) limitBuckets.delete(name);
  }
}

export function voiceAccessState(sessionId) {
  return {
    voiceConfigured: Boolean(process.env.ASSEMBLYAI_API_KEY),
    accessRequired: Boolean(accessCode),
    voiceUnlocked: !accessCode || unlocked.has(sessionId),
    deploymentReady: !isProduction || Boolean(publicOrigin && configuredSecret && accessCode)
  };
}

export function unlockVoice(sessionId, submitted, ip) {
  if (!accessCode) return;
  limit(`access:${ip}`, 8, 15 * 60_000);
  if (typeof submitted !== 'string' || !equal(submitted, accessCode)) {
    throw new DomainError('Incorrect demo access code.', 403, 'INVALID_ACCESS_CODE');
  }
  unlocked.add(sessionId);
}

export function requireVoiceAccess(sessionId) {
  if (isProduction && !(publicOrigin && configuredSecret && accessCode)) {
    throw new DomainError('Configure public origin, session secret and demo access code before enabling production voice.', 503, 'VOICE_DEPLOYMENT_NOT_READY');
  }
  if (accessCode && !unlocked.has(sessionId)) throw new DomainError('Enter the demo access code to use voice.', 403, 'VOICE_ACCESS_REQUIRED');
  limit(`voice:${sessionId}`, 6, 60 * 60_000);
}
