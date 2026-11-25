/* Isolated local contracts for dashboard navigation, sidebar controls and avatar identity. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { launch } = require('./browser-driver.cjs');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.preview', 'sidebar-screenshots');
let browser, base;
const users = { A: '00000000-0000-4000-8000-000000000001', B: '00000000-0000-4000-8000-000000000002' };
const sdk = `(()=>{const ids=${JSON.stringify(users)},callbacks=[];const current=()=>{const key=localStorage.getItem('sidebar-test-user')||'A';return key==='none'?null:{access_token:'test-'+key,user:{id:ids[key],email:key+'@example.test',user_metadata:{full_name:'Student '+key}}};};window.__testSetUser=key=>{localStorage.setItem('sidebar-test-user',key||'none');callbacks.forEach(cb=>cb(key?'SIGNED_IN':'SIGNED_OUT',current()));};window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:current()}}),getUser:async()=>({data:{user:current()?.user}}),onAuthStateChange:cb=>{callbacks.push(cb);setTimeout(()=>cb('INITIAL_SESSION',current()),0);return {data:{subscription:{unsubscribe(){}}}};},signOut:async()=>{window.__testSetUser(null);return {};}}})};})();`;
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/config') return json(res, 200, { supabaseUrl: 'https://fixture.supabase.co', supabaseKey: 'sb_publishable_fixture' });
    if (url.pathname === '/test-supabase.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(sdk); return; }
    if (url.pathname === '/api/chat') return json(res, 200, { reply: 'Local fixture reply.' });
    if (url.pathname.startsWith('/api/')) {
        const user = users[(req.headers.authorization || '').replace('Bearer test-', '')];
        if (!user) return json(res, 401, { error: 'Sign in again.' });
        const action = url.searchParams.get('action');
        if (url.pathname === '/api/tasks') {
            if (action === 'context') return json(res, 200, { role: 'student', user_id: user, batches: [], students: [] });
            if (action === 'list') return json(res, 200, { tasks: [] });
            if (action === 'notifications') return json(res, 200, { notifications: [], unread_count: 0 });
            // Empty names ensure avatar identity never depends on a profile-name event.
            if (action === 'settings') return json(res, 200, { role: 'student', profile: { full_name: '', roll_number: '', class_code: null, division: null }, membership: null, classes: [] });
        }
        if (url.pathname === '/api/calendar') return json(res, 200, { events: [], exams: [] });
        if (url.pathname === '/api/focus') {
            if (action === 'subjects') return json(res, 200, { role: 'student', subjects: [] });
            if (action === 'summary') return json(res, 200, { total_seconds: 0, week_seconds: 0, today_seconds: 0, completed_sessions: 0, subjects: [], daily: [], history: [] });
            if (action === 'state') return json(res, 200, { active: null, prefs: { focus_minutes: 25, short_break_minutes: 5, long_break_minutes: 15, sessions_before_long: 4, auto_start: false, sound: false }, server_now: new Date().toISOString() });
        }
        return json(res, 404, { error: 'Unknown local fixture route.' });
    }
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/app.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
        let data = fs.readFileSync(file);
        if (path.extname(file) === '.html') data = Buffer.from(data.toString('utf8').replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', '/test-supabase.js'));
        res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream' }); res.end(data);
    } catch { res.writeHead(404); res.end(); }
});
const avatar = selector => browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).dataset.avatar`);
async function assertView(view) {
    assert.equal(await browser.evaluate('window.MannSathiWorkspace.current'), view);
    assert.equal(await browser.evaluate('Object.values({dashboard:"dashboard-panel",chat:"chat-area",calendar:"calendar-panel",tasks:"tasks-panel",focus:"focus-panel"}).filter(id=>!document.getElementById(id).hidden).length'), 1);
    assert.equal(await browser.evaluate('document.querySelector(".composer-wrap").hidden'), view !== 'chat');
    assert.equal(await browser.evaluate('document.querySelector("[aria-current=page]").id'), 'open-' + view);
}
async function ready() { await browser.wait('document.readyState === "complete" && !!window.MannSathiWorkspace && !!window.MannSathiDashboard && !!document.querySelector("#user-avatar img")'); await browser.delay(120); }
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port; browser = await launch(output);
    await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('mannsathi.avatar.${users.A}','cat');localStorage.setItem('mannsathi.avatar.${users.B}','dog');localStorage.setItem('mannsathi.avatar.guest','frog');if(!localStorage.getItem('mannsathi_chats'))localStorage.setItem('mannsathi_chats',JSON.stringify([{id:123,title:'Saved conversation',messages:[{role:'user',text:'Hello from history'},{role:'assistant',text:'Saved reply'}],createdAt:new Date().toISOString()}]));}catch{}` });
    await browser.viewport(1440, 900); await browser.command('Page.navigate', { url: base + '/app.html' }); await ready();
    await assertView('dashboard'); assert.equal(await avatar('#user-avatar'), 'cat');
    // The new default skip target must receive keyboard focus.
    await browser.evaluate('document.querySelector(".skip-link").focus()');
    await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
    await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
    assert.equal(await browser.evaluate('document.activeElement.id'), 'dashboard-heading');
    await browser.click('.chat-item-open'); await assertView('chat');
    assert.match(await browser.evaluate('document.getElementById("messages").textContent'), /Hello from history/);
    assert.equal(await avatar('.message.user .msg-avatar'), 'cat');
    await browser.click('#space-home'); await assertView('dashboard');
    await browser.click('#new-chat'); await assertView('chat');
    assert.equal(await browser.evaluate('document.getElementById("messages").children.length'), 0);
    await browser.click('#open-dashboard'); await browser.click('#sidebar-toggle');
    assert.equal(await browser.evaluate('document.getElementById("sidebar-toggle").getAttribute("aria-expanded")'), 'false');
    assert.equal(await browser.evaluate('document.getElementById("sidebar-toggle").getAttribute("aria-label")'), 'Expand sidebar');
    assert.equal(await browser.evaluate('document.querySelector(".sidebar-conversations").getClientRects().length'), 0);
    await browser.wait('document.getElementById("sidebar").getBoundingClientRect().width < 80');
    for (const id of ['open-dashboard', 'open-chat', 'open-calendar', 'open-tasks', 'open-focus', 'new-chat', 'settings-button']) assert(await browser.evaluate(`document.getElementById(${JSON.stringify(id)}).getAttribute('aria-label')`), 'Missing collapsed label: ' + id);
    await browser.command('Page.reload'); await ready();
    assert.equal(await browser.evaluate('document.querySelector(".app-card").classList.contains("sidebar-collapsed")'), true);
    await browser.wait('document.getElementById("sidebar").getBoundingClientRect().width < 80');
    await browser.screenshot('desktop-collapsed');
    await browser.click('#sidebar-toggle');
    assert.equal(await browser.evaluate('document.getElementById("sidebar-toggle").getAttribute("aria-expanded")'), 'true');
    await browser.click('.chat-item-open');
    await browser.evaluate('window.__testSetUser("B")');
    await browser.wait('document.querySelector("#user-avatar").dataset.avatar === "dog"');
    assert.equal(await avatar('.message.user .msg-avatar'), 'dog');
    await browser.evaluate('window.__testSetUser(null)');
    await browser.wait('document.querySelector("#user-avatar").dataset.avatar === "frog"');
    assert.equal(await avatar('.message.user .msg-avatar'), 'frog');
    console.log('PASS default dashboard, accessible skip link, history/New chat routing, collapsed rail persistence and account/guest avatar identity');
    await browser.command('Page.navigate', { url: base + '/app.html?guest=true' }); await ready();
    for (const [width, height] of [[390, 844], [320, 740]]) {
        await browser.viewport(width, height); await browser.click('#open-dashboard');
        await browser.evaluate('document.getElementById("mobile-menu").focus()'); await browser.click('#mobile-menu');
        await browser.wait('document.activeElement.id === "sidebar-close"');
        assert.equal(await browser.evaluate('document.getElementById("mobile-menu").getAttribute("aria-expanded")'), 'true');
        assert.equal(await browser.evaluate('document.getElementById("main-panel").inert'), true);
        assert.equal(await browser.evaluate('document.activeElement.id'), 'sidebar-close');
        assert(await browser.evaluate('document.querySelector("#open-dashboard span").getClientRects().length > 0'), 'Desktop collapsed styles leaked into mobile sidebar');
        await browser.evaluate('document.getElementById("sidebar-signout").focus()');
        await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
        await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
        assert.equal(await browser.evaluate('document.activeElement.classList.contains("sidebar-brand")'), true);
        await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        assert.equal(await browser.evaluate('document.getElementById("mobile-menu").getAttribute("aria-expanded")'), 'false');
        assert.equal(await browser.evaluate('document.getElementById("main-panel").inert'), false);
        assert.equal(await browser.evaluate('document.activeElement.id'), 'mobile-menu');
        await browser.click('#mobile-menu'); await browser.click('#open-chat'); await assertView('chat');
        assert.equal(await browser.evaluate('document.getElementById("sidebar").classList.contains("open")'), false);
        await browser.screenshot('mobile-chat-' + width);
    }
    assert.equal(browser.errors.length, 0, 'Unhandled browser exceptions: ' + JSON.stringify(browser.errors));
    console.log('PASS mobile sidebar labels, focus trap, escape/focus return and navigation at 390/320 pixels');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
