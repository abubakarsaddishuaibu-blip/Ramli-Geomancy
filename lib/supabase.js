import { config } from './config.js';

async function call(path, { method = 'GET', body, token, service = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (service) {
    // Server-only calls: service-role key, RLS is bypassed on purpose.
    headers.apikey = config.supabaseServiceKey;
    headers.Authorization = `Bearer ${config.supabaseServiceKey}`;
  } else {
    // User-scoped calls: the anon key is the API key and the user's own access
    // token is the bearer. PostgREST then evaluates Row Level Security with
    // auth.uid() = the signed-in user, so each user only ever sees their rows.
    headers.apikey = config.supabaseAnonKey;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    } else if (config.supabaseAnonKey) {
      headers.Authorization = `Bearer ${config.supabaseAnonKey}`;
    }
  }
  const res = await fetch(`${config.supabaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
  }
  if (!res.ok) {
    const err = new Error((json && (json.msg || json.message || json.error_description)) || `Supabase ${res.status}`);
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

/** Create an already-confirmed Supabase Auth user (service role only). */
export async function adminCreateUser({ email, password, fullName }) {
  return call('/auth/v1/admin/users', {
    method: 'POST',
    service: true,
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName }
    }
  });
}

/** Sign in with email + password, returns Supabase session tokens. */
export async function signInWithPassword({ email, password }) {
  return call('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password }
  });
}

/** Refresh an expired Supabase access token. */
export async function refreshSession(refreshToken) {
  return call('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: refreshToken }
  });
}

/** Read the authenticated user profile from Supabase Auth. */
export async function getAuthUser(accessToken) {
  return call('/auth/v1/user', { token: accessToken });
}

/* ------------------------------------------------------------------ */
/* PostgREST helpers                                                  */
/* ------------------------------------------------------------------ */

export async function restSelect(table, query, token, { service = false } = {}) {
  const qs = new URLSearchParams(query).toString();
  const path = `/rest/v1/${table}${qs ? `?${qs}` : ''}`;
  return call(path, { token, service });
}

export async function restInsert(table, rows, token, { service = false } = {}) {
  const body = Array.isArray(rows) ? rows : [rows];
  return call(`/rest/v1/${table}`, {
    method: 'POST',
    token,
    service,
    body
  });
}

export async function restUpdate(table, query, body, token, { service = false, returning = 'representation' } = {}) {
  const qs = new URLSearchParams({ ...query, returning }).toString();
  return call(`/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    token,
    service,
    body
  });
}

export async function restDelete(table, query, token) {
  const qs = new URLSearchParams(query).toString();
  return call(`/rest/v1/${table}?${qs}`, { method: 'DELETE', token });
}
