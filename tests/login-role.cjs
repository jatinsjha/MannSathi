/* Execute the real login script against controlled DOM/Auth/HTTP fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('js/login.js', 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(expected, actual, options = {}) {
  const elements = {};
  for (const id of ['login-form', 'email', 'password', 'form-message', 'forgot-password', 'toggle-password', 'role-login-message-link', 'login-button']) {
    elements[id] = {
      value: '', textContent: '', innerHTML: 'Sign in', hidden: true, disabled: false,
      type: id === 'password' ? 'password' : 'text', dataset: {}, style: {}, handlers: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      setAttribute() {}, focus() {}, querySelector() { return elements['login-button']; }
    };
  }
  const token = 'test-' + actual;
  let signOuts = 0, capturedRequest = null, resetTarget = null;
  const client = { auth: {
    getSession: async () => ({ data: { session: options.existing ? { access_token: token } : null }, error: null }),
    signInWithPassword: async () => ({ data: { session: { access_token: token } }, error: null }),
    signOut: async () => { signOuts++; return { error: null }; },
    resetPasswordForEmail: async (_email, settings) => { resetTarget = settings.redirectTo; return { error: null }; }
  } };
  const location = { href: '', origin: 'https://example.test' };
  const context = {
    window: { supabaseReady: Promise.resolve(client), location },
    document: { body: { dataset: { loginRole: expected } }, getElementById: id => elements[id] },
    console: { error() {} }, AbortController, setTimeout, clearTimeout,
    fetch: async (url, request) => {
      capturedRequest = { url, request };
      return { ok: !options.unavailable, json: async () => options.unavailable ? { error: 'Access verification unavailable.' } : { role: actual } };
    }
  };
  vm.runInNewContext(source, context);
  await tick();
  return { elements, location, request: () => capturedRequest, signOuts: () => signOuts, resetTarget: () => resetTarget };
}

async function submit(fixture) {
  fixture.elements.email.value = 'account@example.test';
  fixture.elements.password.value = 'test-password';
  await fixture.elements['login-form'].handlers.submit({ preventDefault() {} });
}

(async () => {
  for (const role of ['student', 'teacher']) {
    const fixture = await setup(role, role);
    await submit(fixture);
    assert.equal(fixture.location.href, 'app.html');
    assert.equal(fixture.request().url, '/api/tasks?action=context');
    assert.equal(fixture.request().request.headers.Authorization, 'Bearer test-' + role);
    assert.equal(fixture.request().request.cache, 'no-store');
    assert.equal(fixture.signOuts(), 0);
    assert.equal(fixture.elements['login-button'].disabled, false);
    await fixture.elements['forgot-password'].handlers.click({ preventDefault() {} });
    assert.equal(fixture.resetTarget(), 'https://example.test/' + (role === 'teacher' ? 'teacher-login.html' : 'index.html'));
  }
  for (const [expected, actual] of [['teacher', 'student'], ['student', 'teacher']]) {
    const fixture = await setup(expected, actual);
    await submit(fixture);
    assert.equal(fixture.location.href, '');
    assert.equal(fixture.signOuts(), 1);
    assert.equal(fixture.elements['role-login-message-link'].hidden, false);
    assert.match(fixture.elements['form-message'].textContent, /teacher/);
  }
  const unavailable = await setup('teacher', 'teacher', { unavailable: true });
  await submit(unavailable);
  assert.equal(unavailable.location.href, '');
  assert.match(unavailable.elements['form-message'].textContent, /unavailable/);
  const invalid = await setup('teacher', 'admin');
  await submit(invalid);
  assert.equal(invalid.location.href, '');
  assert.match(invalid.elements['form-message'].textContent, /Could not verify/);
  const wrongExisting = await setup('teacher', 'student', { existing: true });
  assert.equal(wrongExisting.location.href, '');
  assert.equal(wrongExisting.signOuts(), 1);
  const correctExisting = await setup('teacher', 'teacher', { existing: true });
  assert.equal(correctExisting.location.href, 'app.html');
  console.log('PASS separate role sign-ins, trusted token context, wrong-role logout, fail-closed lookup, existing sessions, and reset routing');
})().catch(error => { console.error(error); process.exitCode = 1; });
