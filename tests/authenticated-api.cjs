/* A pending save must not switch to a different account's token. */
const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');
let callback, resolveSession, calls = [];
let signalSession;
const sessionStarted = new Promise(resolve => { signalSession = resolve; });
const client = { auth: {
  onAuthStateChange(fn) { callback = fn; },
  getSession() { return new Promise(resolve => { resolveSession = resolve; signalSession(); }); }
} };
const context = { window: { supabaseReady: Promise.resolve(client) }, location: { search: '' }, URLSearchParams, AbortController, setTimeout, clearTimeout,
  fetch: async (url, options) => { calls.push(options); return { ok: true, json: async () => ({ saved: true }) }; }
};
vm.runInNewContext(fs.readFileSync('js/services/authenticated-api.js', 'utf8'), context);
(async () => {
  await Promise.resolve();
  callback('INITIAL_SESSION', { user: { id: 'student-A' } });
  const pending = context.window.MannSathiAPI.request('/api/tasks', { method: 'POST', body: { title: 'Private A task' } });
  await sessionStarted;
  callback('SIGNED_IN', { user: { id: 'student-B' } });
  resolveSession({ data: { session: { access_token: 'token-B', user: { id: 'student-B' } } } });
  await assert.rejects(pending, error => error.status === 401 && /account changed/.test(error.message));
  assert.equal(calls.length, 0, 'Old account data must never be sent under a new account token');
  client.auth.getSession = async () => ({ data: { session: { access_token: 'token-B', user: { id: 'student-B' } } } });
  callback('TOKEN_REFRESHED', { user: { id: 'student-B' } });
  await context.window.MannSathiAPI.request('/api/tasks');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, 'Bearer token-B');
  await assert.rejects(context.window.MannSathiAPI.request('/api/chat', {
    method:'POST', expectedUserId:'student-A', body:{messages:[{role:'user',text:'A private history'}]}
  }), error => error.status === 401 && /account changed/.test(error.message));
  assert.equal(calls.length, 1, 'A pending chat history must match the actual user returned by getSession');
  console.log('PASS account-change save isolation and same-account token refresh');
})().catch(error => { console.error(error); process.exitCode = 1; });
