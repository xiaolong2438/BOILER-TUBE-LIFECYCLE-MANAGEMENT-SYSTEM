import { getSession, jsonResponse } from './_shared.mjs';

export async function onRequestGet({ env, request }) {
  const session = await getSession(env, request);
  if(!session) return jsonResponse({ authenticated: false }, { status: 401 });
  return jsonResponse({
    authenticated: true,
    username: session.username,
    role: session.role || 'user',
    expiresAt: session.expires_at
  });
}
