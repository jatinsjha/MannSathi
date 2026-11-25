/* Isolated local account fixtures exercise the production dashboard and shell. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { launch } = require('./browser-driver.cjs');
const dates = require('../js/utils/date-utils.js');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.preview', 'dashboard-screenshots');
const ids = { A: '00000000-0000-4000-8000-000000000001', B: '00000000-0000-4000-8000-000000000002', T: '00000000-0000-4000-8000-000000000010' };
const batch = { id: '25cs', label: '25CS' }, requests = [];
const subjects = ['Mathematics', 'Biology', 'Music', 'Chemistry'].map((name, i) => ({ id: 'subject-' + i, name, color: '#bda0ed', archived: false, weekly_goal_minutes: i === 2 ? 0 : 120, week_seconds: [1800, 5400, 900, 7200][i], total_seconds: 9000 + i * 900 }));
const tasks = [
  { id: 'task-1', title: 'Practice quadratic equations', subject: 'Mathematics', status: 'pending', audience: 'personal', due_at: new Date(Date.now() + 86400000).toISOString(), created_by: ids.A, recipient_count: 6, completed_count: 2 },
  { id: 'task-2', title: 'Finish the biology worksheet', subject: 'Biology', status: 'in_progress', audience: 'batch', due_at: new Date(Date.now() + 2 * 86400000).toISOString(), created_by: ids.T, recipient_count: 6, completed_count: 3 },
  { id: 'task-3', title: 'Review chemical bonds', subject: 'Chemistry', status: 'completed', audience: 'batch', due_at: new Date(Date.now() + 3 * 86400000).toISOString(), created_by: ids.T, recipient_count: 6, completed_count: 6 }
];
const exam = { id: 'exam-1', title: 'Mathematics midterm', source: 'teacher_exam', category: 'examination', audience: 'batch', target_division: 'A', batch_id: '25cs', all_day: false, starts_at: new Date(Date.now() + 7 * 86400000).toISOString(), ends_at: new Date(Date.now() + 7 * 86400000 + 3600000).toISOString(), time_zone: 'Asia/Kolkata', location: 'Room 204', reminder_minutes: 30, color: '#bda0ed', description: 'Chapters 1–3', can_edit: false };
const personal = { ...exam, id: 'personal-1', title: 'Music practical', source: undefined, audience: undefined, all_day: true, start_date: dates.addDays(dates.dateKey(), 9), end_date: dates.addDays(dates.dateKey(), 10), location: '' };
let browser, base, failSource = null, delayMs = 0;
const sdk = `(()=>{const ids=${JSON.stringify(ids)},callbacks=[];const label=()=>localStorage.getItem('dashboard-test-user')||'A';const current=()=>label()==='none'?null:{access_token:'test-'+label(),user:{id:ids[label()],email:label()+'@example.test',user_metadata:{full_name:label()==='T'?'Teacher':'Student '+label()}}};window.__dashboardSetUser=value=>{localStorage.setItem('dashboard-test-user',value||'none');callbacks.forEach(cb=>cb(value?'SIGNED_IN':'SIGNED_OUT',current()));};window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:current()}}),getUser:async()=>({data:{user:current()?.user}}),onAuthStateChange:cb=>{callbacks.push(cb);setTimeout(()=>cb('INITIAL_SESSION',current()),0);return {data:{subscription:{unsubscribe(){}}}};},signOut:async()=>{window.__dashboardSetUser(null);return {};},resetPasswordForEmail:async()=>({})}})};})();`;
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/config') return json(res, 200, { supabaseUrl: 'https://fixture.supabase.co', supabaseKey: 'sb_publishable_fixture' });
  if (url.pathname === '/test-supabase.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(sdk); return; }
  if (url.pathname.startsWith('/api/')) {
    const user = (req.headers.authorization || '').replace('Bearer test-', ''), action = url.searchParams.get('action');
    if (!ids[user]) return json(res, 401, { error: 'Sign in again.' });
    requests.push({ path: url.pathname, action, user, start: url.searchParams.get('start'), end: url.searchParams.get('end') });
    const context = { role: user === 'T' ? 'teacher' : 'student', user_id: ids[user], batches: user === 'T' ? [batch] : [], students: user === 'T' ? [{ id: ids.A, full_name: 'Student A', batch_id: batch.id, division: 'A', roll_number: '25CS01' }] : [] };
    if (url.pathname === '/api/tasks') {
      if (action === 'context') return json(res, 200, context);
      if (action === 'settings') return json(res, 200, { ...context, profile: { full_name: user === 'T' ? 'Teacher' : 'Student ' + user, roll_number: '25CS01', class_code: '25cs', division: 'A' }, membership: null, classes: [batch] });
      if (action === 'notifications') return json(res, 200, { notifications: [], unread_count: 0 });
      if (action === 'enrollments') return json(res, 200, { role: 'teacher', enrollments: [] });
      if (action === 'list') { if (failSource === 'tasks') return json(res, 502, { error: 'Tasks temporarily unavailable.' }); return json(res, 200, { tasks: user === 'B' ? [] : user === 'T' ? tasks.filter(task => task.created_by === ids.T) : tasks }); }
    }
    if (url.pathname === '/api/focus') {
      if (user === 'T') return json(res, 403, { error: 'Student accounts only.' });
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (failSource === 'focus') return json(res, 502, { error: 'Study time temporarily unavailable.' });
      if (action === 'subjects') return json(res, 200, { role: 'student', subjects: user === 'A' ? subjects : [] });
      if (action === 'summary') return json(res, 200, { total_seconds: user === 'A' ? 32400 : 0, today_seconds: user === 'A' ? 3600 : 0, week_seconds: user === 'A' ? 12600 : 0, completed_sessions: 6, subjects: user === 'A' ? subjects : [], daily: Array.from({ length: 14 }, (_, i) => ({ date: dates.addDays(dates.dateKey(), i - 13), seconds: user === 'A' ? i * 300 : 0 })), history: [], server_now: new Date().toISOString() });
      if (action === 'state') return json(res, 200, { active: null, prefs: { focus_minutes: 25, short_break_minutes: 5, long_break_minutes: 15, sessions_before_long: 4, auto_start: false, sound: false }, server_now: new Date().toISOString() });
    }
    if (url.pathname === '/api/calendar') {
      const start = url.searchParams.get('start'), end = url.searchParams.get('end');
      if (!start || !end || (Date.parse(end) - Date.parse(start)) / 86400000 > 62) return json(res, 400, { error: 'Choose a calendar range of at most 62 days.' });
      if (failSource === 'exams' && action === 'exams') return json(res, 502, { error: 'Exam schedule temporarily unavailable.' });
      return json(res, 200, { events: user === 'B' ? [] : action === 'exams' ? [{ ...exam, can_edit: user === 'T' }] : user === 'A' ? [personal] : [] });
    }
    if (url.pathname === '/api/chat') return json(res, 200, { reply: 'Fixture reply' });
    return json(res, 404, { error: 'Unknown fixture route' });
  }
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/app.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try { let data = fs.readFileSync(file); if (path.extname(file) === '.html') data = Buffer.from(data.toString('utf8').replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', '/test-supabase.js')); res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream' }); res.end(data); } catch { res.writeHead(404); res.end(); }
});
async function navigate(query = '') { await browser.command('Page.navigate', { url: base + '/app.html' + query }); await browser.wait('document.readyState === "complete" && !!window.MannSathiDashboard'); await browser.evaluate('document.fonts.ready'); }
async function ready() { await browser.wait('document.getElementById("dashboard-panel").getAttribute("aria-busy") === "false" && document.getElementById("dashboard-status").textContent.includes("up to date")'); }
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port; browser = await launch(output); await browser.viewport(1440, 900); await navigate(); await ready();
  assert.equal(await browser.evaluate('window.MannSathiWorkspace.current'), 'dashboard');
  assert.equal(await browser.evaluate('document.querySelectorAll(".dashboard-subject").length'), 4);
  assert.equal(await browser.evaluate('document.getElementById("dashboard-hours").textContent'), '9');
  assert.equal(await browser.evaluate('document.getElementById("dashboard-task-percent").textContent'), '33%');
  assert.equal(await browser.evaluate('document.querySelectorAll(".dashboard-chart-day").length'), 7);
  assert.equal(await browser.evaluate('document.querySelectorAll(".dashboard-goal").length'), 3);
  assert.equal(await browser.evaluate('document.querySelectorAll(".dashboard-exam").length'), 2);
  assert(await browser.evaluate('document.getElementById("dashboard-exams-list").textContent.includes("Assigned by your teacher")'));
  assert(await browser.evaluate('document.querySelectorAll(".dashboard-subject")[2].textContent.includes("no goal set")'));
  await browser.click('#sidebar-toggle'); assert(await browser.evaluate('document.querySelector(".app-card").classList.contains("sidebar-collapsed")')); await browser.screenshot('dashboard-collapsed-dark'); await browser.click('#sidebar-toggle');
  for (const [width, height] of [[1440, 900], [390, 844], [320, 740]]) {
    await browser.viewport(width, height);
    for (const theme of ['dark', 'light']) {
      await browser.evaluate(`window.MannSathiTheme.apply(${JSON.stringify(theme)})`);
      const bounds = await browser.evaluate('(()=>{const p=document.getElementById("dashboard-panel");return {page:document.documentElement.scrollWidth,panel:p.clientWidth,content:p.scrollWidth};})()');
      assert(bounds.page <= width && bounds.content <= bounds.panel + 1, 'Dashboard overflow: ' + JSON.stringify(bounds));
      await browser.screenshot('dashboard-' + theme + '-' + width);
    }
  }
  await browser.viewport(1440, 900); await browser.evaluate('window.MannSathiTheme.apply("dark")');
  const before = requests.filter(req => req.path === '/api/calendar').length; await browser.click('#dashboard-refresh'); await ready(); assert(requests.filter(req => req.path === '/api/calendar').length > before);
  failSource = 'focus'; await browser.click('#dashboard-refresh'); await browser.wait('!document.getElementById("dashboard-focus-error").hidden && document.getElementById("dashboard-panel").getAttribute("aria-busy") === "false"'); assert.equal(await browser.evaluate('document.getElementById("dashboard-hours").textContent'), '—'); assert.equal(await browser.evaluate('document.getElementById("dashboard-task-total").textContent'), '3');
  failSource = null; await browser.click('#dashboard-focus-error button'); await ready();
  subjects[0].name = '<img src=x onerror="window.__dashboardXss=true">'; await browser.click('#dashboard-refresh'); await ready(); assert.equal(await browser.evaluate('window.__dashboardXss'), undefined); assert.equal(await browser.evaluate('document.querySelectorAll("#dashboard-subjects img").length'), 0); subjects[0].name = 'Mathematics';
  delayMs = 400; await browser.evaluate('window.MannSathiDashboard.refresh();window.__dashboardSetUser("B")'); await ready(); await browser.delay(550); assert.equal(await browser.evaluate('document.getElementById("dashboard-hours").textContent'), '0'); assert.equal(await browser.evaluate('document.getElementById("dashboard-task-total").textContent'), '0'); assert.equal(await browser.evaluate('document.querySelectorAll(".dashboard-subject,.dashboard-exam").length'), 0); await browser.screenshot('dashboard-empty-dark'); delayMs = 0;
  await browser.evaluate('window.__dashboardSetUser("T")'); await ready(); const teacherStart = requests.length; await browser.click('#dashboard-refresh'); await ready(); assert(!requests.slice(teacherStart).some(req => req.path === '/api/focus'), 'Teacher overview must not request student study time'); assert.equal(await browser.evaluate('document.getElementById("dashboard-heading").textContent'), 'Class overview'); assert.equal(await browser.evaluate('document.getElementById("dashboard-assign-exam").hidden'), false); await browser.screenshot('dashboard-teacher-dark');
  await browser.click('#dashboard-assign-exam'); await browser.wait('document.getElementById("calendar-event-dialog").open'); assert.equal(await browser.evaluate('document.getElementById("event-exam-fields").hidden'), false); await browser.click('#calendar-event-dialog [data-calendar-close]'); await browser.click('#open-dashboard'); await ready();
  await browser.evaluate('window.__dashboardSetUser("A")'); await ready(); await navigate('?guest=true'); await browser.wait('document.getElementById("dashboard-status").textContent.includes("Sign in")'); assert.equal(await browser.evaluate('document.querySelectorAll(".dashboard-subject,.dashboard-exam").length'), 0); assert.equal(await browser.evaluate('document.getElementById("dashboard-task-total").textContent'), '0');
  assert.equal(browser.errors.length, 0, 'Unhandled browser exceptions: ' + JSON.stringify(browser.errors));
  console.log('PASS real subject goals/time charts/tasks/personal and teacher exams; desktop collapse; dark/light 1440,390,320; per-source retry; safe text; account races; teacher and guest states. Screenshots: ' + output);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server.close(); });
