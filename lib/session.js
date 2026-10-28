import crypto from 'node:crypto';
import { config } from './config.js';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payloadB64).digest('base64url');
}

/** Create a signed, tamper-proof session token (stateless, HMAC-SHA256). */
export function createSessionToken(payload) {
  const body = {
    uid: payload.uid,
    email: payload.email,
    name: payload.name,
    sat: payload.sat,      // Supabase access token (used for RLS-scoped queries)
    srt: payload.srt,      // Supabase refresh token
    exp: Math.floor(Date.now() / 1000) + config.sessionTtlSeconds
  };
  const bodyB64 = b64url(JSON.stringify(body));
  return `${bodyB64}.${sign(bodyB64)}`;
}

/** Verify and decode a session token. Returns null when invalid or expired. */
export function readSessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [bodyB64, signature] = parts;
  const expected = sign(bodyB64);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || !payload.uid) return null;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function bearerFrom(req) {
  const header = req.headers['authorization'] || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return null;
}
