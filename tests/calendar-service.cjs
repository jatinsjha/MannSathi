const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('js/services/calendar-service.js', 'utf8');
let token = 'test-access-token', query = '', request, response, guest = false, failure = false;
const client = { auth: { getSession: async () => ({ data: { session: token ? { access_token: token } : null } }) } };
const context = {
  window: { supabaseReady: Promise.resolve(client) },
  location: { get search() { return guest ? '?guest=true' : ''; } },
  URLSearchParams, AbortController, setTimeout, clearTimeout,
  fetch: async (url, options) => {
    if (failure) throw new TypeError('network');
    query = url; request = options;
    return response;
  }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('js/services/authenticated-api.js', 'utf8'), context);
vm.runInContext(source, context);
const service = context.window.MannSathiCalendarService;
(async () => {
  response = { ok: true, json: async () => ({ events: [] }) };
  await service.list('2026-11-24', '2026-11-25', 'Asia/Kolkata');
  assert.match(query, /time_zone=Asia%2FKolkata/);
  assert.equal(request.headers.Authorization, 'Bearer test-access-token');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.body, undefined);
  response = { ok: true, json: async () => ({ event: { id: 'e1' } }) };
  assert.equal((await service.create({ title: 'Lecture' })).id, 'e1');
  assert.deepEqual(JSON.parse(request.body), { title: 'Lecture' });
  await service.update('e1', { title: 'Renamed' });
  assert.equal(request.method, 'PATCH');
  assert.match(query, /id=e1/);
  await service.remove('e1');
  assert.equal(request.method, 'DELETE');
  response = { ok: false, status: 401, json: async () => ({ error: 'Session expired.' }) };
  await assert.rejects(service.list('2026-11-24', '2026-11-25', 'UTC'), error => error.status === 401 && error.message === 'Session expired.');
  token = '';
  await assert.rejects(service.create({}), error => error.status === 401);
  token = 'another-test-token'; guest = true;
  await assert.rejects(service.create({}), error => error.status === 401);
  guest = false; failure = true;
  await assert.rejects(service.remove('e1'), /Check your connection/);
  failure = false;
  response = { ok: true, status: 200, json: async () => { throw new Error('not JSON'); } };
  await assert.rejects(service.remove('e1'), /unreadable response/);
  console.log('PASS calendar service token forwarding, CRUD contract, guest/expired-session denial, offline and malformed responses');
})().catch(error => { console.error(error); process.exitCode = 1; });
