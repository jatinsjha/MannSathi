/* Browser contract tests. Auth and persistence fixtures exist only in this test server. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.preview', 'calendar-screenshots');
fs.mkdirSync(output, { recursive: true });
const records = new Map();
const requests = [];
let sequence = 0, expired = false, offline = false, base, browser, ws, session, nextId = 0;
const pending = new Map(), pageErrors = [];
const stubSdk = `(() => {
  const callbacks = [];
  const user = () => { const value = localStorage.getItem('calendar-test-user'); return value === 'none' ? null : value || 'A'; };
  const current = () => user() ? { access_token: 'test-' + user(), user: { id: user(), email: user().toLowerCase() + '@example.test', user_metadata: { full_name: 'Student ' + user() } } } : null;
  window.__testSetUser = value => { localStorage.setItem('calendar-test-user', value || 'none'); callbacks.forEach(callback => callback(value ? 'SIGNED_IN' : 'SIGNED_OUT', current())); };
  window.supabase = { createClient: () => ({ auth: {
    getSession: async () => ({ data: { session: current() }, error: null }),
    getUser: async () => ({ data: { user: current()?.user || null }, error: null }),
    onAuthStateChange: callback => { callbacks.push(callback); setTimeout(() => callback('INITIAL_SESSION', current()), 0); return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => { window.__testSetUser(null); return { error: null }; },
    signInWithPassword: async ({ email }) => { window.__testSetUser(email.startsWith('b') ? 'B' : 'A'); return { data: { session: current(), user: current().user }, error: null }; }
  } }) };
})();`;
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/test-supabase.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(stubSdk); return; }
  if (url.pathname === '/api/config') { json(res, 200, { supabaseUrl: 'https://example.test', supabaseKey: 'test-publishable-fixture' }); return; }
  if (url.pathname === '/api/tasks') {
    const action = url.searchParams.get('action');
    const user = req.headers.authorization === 'Bearer test-B' ? 'B' : 'A';
    json(res, 200, action === 'context' ? { role: 'student', user_id: user, batches: [], students: [] } : action === 'notifications' ? { notifications: [], unread_count: 0 } : { tasks: [], role: 'student' });
    return;
  }
  if (url.pathname === '/api/chat') { for await (const chunk of req) { /* Consume the fixture chat request. */ } json(res, 200, { reply: 'Chat still works.' }); return; }
  if (url.pathname === '/api/calendar') {
    if (offline) { req.socket.destroy(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const owner = { 'Bearer test-A': 'A', 'Bearer test-B': 'B' }[req.headers.authorization];
    requests.push({ method: req.method, owner, query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : null });
    if (!owner || expired) { json(res, 401, { error: 'Your session has expired. Sign in again.' }); return; }
    if (req.method === 'GET') { json(res, 200, { events: url.searchParams.get('action') === 'exams' ? [] : [...records.values()].filter(event => event.user_id === owner) }); return; }
    const id = url.searchParams.get('id'), existing = records.get(id);
    if (req.method === 'POST') {
      const event = { ...JSON.parse(raw), id: 'event-' + ++sequence, user_id: owner, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      records.set(event.id, event); json(res, 201, { event }); return;
    }
    if (!existing || existing.user_id !== owner) { json(res, 404, { error: 'Event not found.' }); return; }
    if (req.method === 'PATCH') { const event = { ...existing, ...JSON.parse(raw), updated_at: new Date().toISOString() }; records.set(id, event); json(res, 200, { event }); return; }
    if (req.method === 'DELETE') { records.delete(id); json(res, 200, { deleted: true }); return; }
    json(res, 405, { error: 'Method not allowed.' }); return;
  }
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    let data = fs.readFileSync(file);
    if (path.extname(file) === '.html') data = Buffer.from(data.toString('utf8').replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', '/test-supabase.js'));
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(method, params = {}, sid = session) {
  const id = ++nextId;
  if (process.env.CALENDAR_DEBUG) console.log('CDP send', id, method, sid || 'browser');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + JSON.stringify(result.exceptionDetails.exception));
  return result.result.value;
}
async function waitFor(expression) {
  const start = Date.now();
  while (Date.now() - start < 10000) { if (await evaluate(expression)) return; await delay(50); }
  throw new Error('Condition not reached: ' + expression);
}
async function navigate(file = 'app.html') {
  await command('Page.navigate', { url: base + '/' + file });
  await waitFor('document.readyState === "complete" && !!window.supabaseReady');
  await evaluate('document.fonts.ready'); await delay(100);
}
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function fill(values) {
  await evaluate(`for (const [id,value] of Object.entries(${JSON.stringify(values)})) {const el=document.getElementById(id); if (typeof value==='boolean') el.checked=value; else el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); if (el.type==='checkbox') el.dispatchEvent(new Event('change',{bubbles:true}));}`);
}
async function calendarReady() { await waitFor('document.getElementById("calendar-content").getAttribute("aria-busy") === "false" && !document.getElementById("calendar-create").disabled'); }
async function openCalendar() { await click('#open-calendar'); await calendarReady(); }
async function saveEvent() { await evaluate('document.getElementById("calendar-event-form").requestSubmit()'); await waitFor('!document.getElementById("calendar-event-dialog").open'); await calendarReady(); }
async function openEvent(id) { await click(`[data-event-id="${id}"]`); await waitFor('document.getElementById("calendar-event-dialog").open'); }
async function viewport(width, height) { await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 761 }); }
async function screenshot(name) { const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data, 'base64')); }
async function checkLayout(width, height) {
  await viewport(width, height);
  const layout = await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,panel:document.getElementById("calendar-panel").clientWidth,panelScroll:document.getElementById("calendar-panel").scrollWidth,images:[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src)})');
  assert(layout.scroll <= layout.width && layout.panelScroll <= layout.panel + 1, 'Horizontal overflow: ' + JSON.stringify(layout));
  assert.equal(layout.images.length, 0, 'Broken images');
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=0', '--user-data-dir=' + path.join(root, '.preview', 'chrome-profile'), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = ''; const timer = setTimeout(() => reject(new Error('Chrome did not start: ' + stderr.slice(-500))), 20000);
    browser.stderr.on('data', data => { stderr += data; const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    browser.on('error', error => { clearTimeout(timer); reject(error); });
  });
  ws = new WebSocket(endpoint); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => { const data = JSON.parse(event.data); if (process.env.CALENDAR_DEBUG) console.log('CDP receive', data.id || data.method); if (data.id && pending.has(data.id)) { const p = pending.get(data.id); clearTimeout(p.timer); pending.delete(data.id); data.error ? p.reject(new Error(JSON.stringify(data.error))) : p.resolve(data.result); } if (data.method === 'Runtime.exceptionThrown') pageErrors.push(data.params.exceptionDetails); };
  const target = await command('Target.createTarget', { url: 'about:blank' }, null); session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
  await command('Page.enable'); await command('Runtime.enable'); await command('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Kolkata' });
  await viewport(1440, 900); await navigate(); await evaluate('localStorage.setItem("calendar-test-user","A"); localStorage.removeItem("mannsathi_chats"); window.MannSathiTheme.apply("dark")');
  await openCalendar();
  const today = await evaluate('window.MannSathiDates.dateKey()');
  const tomorrow = await evaluate('window.MannSathiDates.addDays(window.MannSathiDates.dateKey(),1)');
  assert.equal(await evaluate('document.getElementById("open-calendar").getAttribute("aria-current")'), 'page');
  assert.equal(records.size, 0); assert.match(await evaluate('document.getElementById("calendar-status").textContent'), /No events/);
  await click('#calendar-create'); await fill({ 'event-title': 'Lecture one', 'event-start': today + 'T09:00', 'event-end': today + 'T10:00', 'event-description': 'Bring notes', 'event-location': 'Room 12', 'event-reminder': '15' });
  await saveEvent(); const first = [...records.values()][0]; assert.equal(first.reminder_minutes, 15); assert.equal(first.starts_at, today + 'T03:30:00.000Z'); assert.equal(first.user_id, 'A');
  assert.equal(requests.find(request => request.method === 'POST').body.user_id, undefined);
  await click('#calendar-create'); await fill({ 'event-title': '<img src=x onerror="window.__injected=true">', 'event-start': today + 'T09:30', 'event-end': today + 'T10:30' });
  assert.equal(await evaluate('document.getElementById("event-overlap-note").hidden'), false); await saveEvent();
  const second = [...records.values()].find(event => event.id !== first.id); assert.equal(records.size, 2);
  assert.equal(await evaluate('window.__injected'), undefined); assert.equal(await evaluate('document.querySelectorAll(".calendar-event-title img").length'), 0);
  assert((await evaluate('document.querySelectorAll("#calendar-grid .is-overlapping").length')) >= 2);
  await openEvent(first.id); await fill({ 'event-title': 'Updated lecture', 'event-start': today + 'T11:00', 'event-end': today + 'T12:00' }); await saveEvent(); assert.equal(records.get(first.id).title, 'Updated lecture');
  await openEvent(first.id); await fill({ 'event-end': today + 'T10:00' }); await evaluate('document.getElementById("calendar-event-form").requestSubmit()');
  assert.match(await evaluate('document.getElementById("event-form-error").textContent'), /after the start/); assert.equal(records.get(first.id).ends_at, today + 'T06:30:00.000Z');
  await click('#calendar-event-dialog [data-calendar-close]');
  await click('#calendar-create'); await fill({ 'event-title': 'All-day assignment', 'event-all-day': true, 'event-start-date': tomorrow, 'event-end-date': tomorrow }); await saveEvent();
  const allDay = [...records.values()].find(event => event.all_day); assert.equal(allDay.starts_at, null); assert.equal(allDay.end_date, await evaluate(`window.MannSathiDates.addDays(${JSON.stringify(tomorrow)},1)`));
  assert.match(await evaluate('document.getElementById("calendar-upcoming-list").textContent'), /All-day assignment/);
  await openEvent(allDay.id); assert.equal(await evaluate('document.getElementById("event-end-date").value'), tomorrow); await click('#calendar-event-dialog [data-calendar-close]');
  await command('Page.reload'); await waitFor('document.readyState === "complete" && !!window.MannSathiCalendarService'); await delay(100); await openCalendar(); assert.equal(records.size, 3);
  assert.match(await evaluate('document.getElementById("calendar-grid").textContent'), /Updated lecture/);
  await click('[data-calendar-view="day"]'); await calendarReady(); await click('#calendar-today'); await calendarReady(); assert.equal(await evaluate('document.querySelectorAll("#calendar-grid .calendar-event").length'), 2);
  const dayPeriod = await evaluate('document.getElementById("calendar-period-label").textContent'); await click('#calendar-next'); await calendarReady(); assert.notEqual(await evaluate('document.getElementById("calendar-period-label").textContent'), dayPeriod); assert.match(await evaluate('document.getElementById("calendar-grid").textContent'), /All-day assignment/);
  await click('#calendar-prev'); await calendarReady(); assert.equal(await evaluate('document.getElementById("calendar-period-label").textContent'), dayPeriod);
  await click('[data-calendar-view="week"]'); await calendarReady(); assert.equal(await evaluate('document.querySelectorAll("#calendar-grid .calendar-agenda-day").length'), 7);
  await click('[data-calendar-view="month"]'); await calendarReady(); assert.equal(await evaluate('document.querySelectorAll("#calendar-grid .calendar-day").length'), 42);
  await openEvent(second.id); await click('#event-delete'); await click('#calendar-delete-dialog [data-calendar-close]'); assert(records.has(second.id)); assert.equal(await evaluate('document.getElementById("calendar-event-dialog").open'), true);
  await click('#event-delete'); await click('#calendar-delete-confirm'); await waitFor('!document.getElementById("calendar-event-dialog").open'); await calendarReady(); assert(!records.has(second.id));
  console.log('PASS calendar CRUD, cancelled deletion, reload persistence, local UTC conversion, all-day dates, overlaps, escaping, invalid ranges and view navigation');
  for (const [width,height] of [[1440,900],[390,844],[320,740]]) {
    await checkLayout(width,height); await screenshot('calendar-dark-' + width);
    await evaluate('window.MannSathiTheme.apply("light")'); await checkLayout(width,height); await screenshot('calendar-light-' + width);
    await click('#calendar-create'); await checkLayout(width,height);
    const dialogLayout = await evaluate('(()=>{const d=document.getElementById("calendar-event-dialog"),r=d.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,client:d.clientWidth,scroll:d.scrollWidth};})()');
    assert(dialogLayout.left >= 0 && dialogLayout.right <= dialogLayout.width + 1 && dialogLayout.scroll <= dialogLayout.client + 1, 'Dialog overflow: ' + JSON.stringify(dialogLayout));
    await screenshot('calendar-dialog-' + width); await click('#calendar-event-dialog [data-calendar-close]'); await evaluate('window.MannSathiTheme.apply("dark")');
  }
  await viewport(1440,900); await evaluate('window.__testSetUser("B")'); await calendarReady(); assert.equal(await evaluate('document.querySelectorAll("#calendar-grid .calendar-event").length'), 0);
  await click('#calendar-create'); await fill({ 'event-title': 'Private B event', 'event-start': today + 'T14:00', 'event-end': today + 'T15:00' }); await saveEvent();
  assert.equal([...records.values()].find(event=>event.title==='Private B event').user_id,'B');
  await evaluate('window.__testSetUser("A")'); await calendarReady(); assert.match(await evaluate('document.getElementById("calendar-grid").textContent'), /Updated lecture/); assert.doesNotMatch(await evaluate('document.getElementById("calendar-grid").textContent'), /Private B event/);
  await click('#user-profile-card'); await click('#sidebar-signout');
  await waitFor('location.pathname === "/index.html" && document.readyState === "complete" && document.querySelector(".login-button")?.disabled === false');
  await fill({ email: 'a@example.test', password: 'test-password' }); await evaluate('document.getElementById("login-form").requestSubmit()');
  await waitFor('location.pathname === "/app.html" && document.readyState === "complete" && !!window.MannSathiCalendarService && !!document.getElementById("open-calendar")'); await delay(100); await openCalendar(); assert.match(await evaluate('document.getElementById("calendar-grid").textContent'), /Updated lecture/);
  expired = true; await click('#calendar-refresh'); await waitFor('!document.getElementById("calendar-auth").hidden'); assert.equal(await evaluate('document.querySelectorAll("#calendar-grid .calendar-event").length'), 0); assert.equal(await evaluate('document.getElementById("calendar-create").disabled'), true);
  expired = false; await click('#calendar-refresh'); await calendarReady(); offline = true; await click('#calendar-refresh'); await waitFor('!document.getElementById("calendar-retry").hidden'); assert.match(await evaluate('document.getElementById("calendar-status").textContent'), /connection|reach/); offline = false; await click('#calendar-retry'); await calendarReady();
  await navigate('app.html?guest=true'); await click('#open-calendar'); await waitFor('!document.getElementById("calendar-auth").hidden'); assert.equal(await evaluate('document.getElementById("calendar-create").disabled'), true); await click('#open-chat'); await fill({ 'message-input': 'Hello from guest' }); await evaluate('document.getElementById("chat-form").requestSubmit()'); await waitFor('!!document.querySelector(".message.assistant .msg-body")'); assert.match(await evaluate('document.querySelector(".message.assistant").textContent'), /Chat still works/);
  await click('#open-calendar'); await waitFor('!document.getElementById("calendar-auth").hidden'); await click('#new-chat');
  assert.equal(await evaluate('!document.getElementById("chat-area").hidden && document.getElementById("calendar-panel").hidden'), true, 'New chat returns from Calendar to Chat');
  await click('#open-calendar'); await waitFor('!document.getElementById("calendar-auth").hidden');
  await evaluate('[...document.querySelectorAll(".chat-item-open")].find(button=>button.textContent.includes("Hello from guest")).click()');
  assert.equal(await evaluate('!document.getElementById("chat-area").hidden && document.getElementById("calendar-panel").hidden'), true, 'History returns from Calendar to Chat');
  assert.match(await evaluate('document.getElementById("messages").textContent'), /Hello from guest.*Chat still works/s, 'Saved conversation restored');
  assert.equal(pageErrors.length, 0, 'Unhandled JavaScript exceptions: ' + JSON.stringify(pageErrors));
  console.log('PASS responsive layouts and dialogs (1440/390/320), light/dark themes, account isolation, logout/login persistence, expired auth, offline recovery, guest chat, New chat and history navigation');
  console.log('Calendar browser tests passed. Screenshots: ' + output);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (ws) { try { await command('Browser.close', {}, null); } catch {} ws.close(); }
  if (browser) browser.kill();
  for (const item of pending.values()) clearTimeout(item.timer);
  server.close();
});
