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
async function press(key) {
    const keyCodes = { Tab: 9, Enter: 13, Escape: 27, End: 35, ArrowDown: 40 };
    const event = { key, code: key, windowsVirtualKeyCode: keyCodes[key] };
    if (key === 'Enter') await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', ...event, text: '\r' });
    else await browser.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
    await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}
async function clickVisible(selector) {
    const point = await browser.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        return element.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    })()`);
    assert(point, 'Control must be visible and clickable: ' + selector);
    await browser.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await browser.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function checkMenuOpen() {
    await browser.wait('document.getElementById("user-profile-card").getAttribute("aria-expanded") === "true" && !document.getElementById("account-menu").hidden');
    const fits = await browser.evaluate(`(() => {
        const rect = document.getElementById('account-menu').getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1;
    })()`);
    assert(fits, 'The account menu must fit on screen');
}
async function checkMenuClosed() {
    assert.equal(await browser.evaluate('document.getElementById("user-profile-card").getAttribute("aria-expanded")'), 'false');
    assert.equal(await browser.evaluate('document.getElementById("account-menu").hidden'), true);
    assert.equal(await browser.evaluate('document.getElementById("settings-button").getClientRects().length'), 0);
}
async function checkSettingsFromMenu(selector, tab, returnFocus) {
    await clickVisible('#user-profile-card');
    await checkMenuOpen();
    await clickVisible(selector);
    assert.equal(await browser.evaluate('document.getElementById("settings-dialog").open'), true);
    assert.equal(await browser.evaluate(`document.querySelector('[data-settings-panel="${tab}"]').hidden`), false);
    await checkMenuClosed();
    await clickVisible('#settings-dialog [data-close-dialog]');
    await browser.wait(`document.activeElement.id === ${JSON.stringify(returnFocus)}`);
}
async function checkChatThemes(state) {
    const selectors = state === 'empty' ? ['.prompt-chip'] : ['.msg-bubble', '.message.assistant .msg-body'];
    for (const theme of ['dark', 'light']) {
        await browser.evaluate(`window.MannSathiTheme.apply(${JSON.stringify(theme)})`);
        const styles = await browser.evaluate(`${JSON.stringify(['#chat-form', '#send-button', ...selectors])}.map(selector => {
            const element = document.querySelector(selector);
            return { selector, visible: !!element.getClientRects().length, background: getComputedStyle(element).backgroundImage };
        })`);
        for (const style of styles) {
            assert(style.visible, 'Visible chat control: ' + style.selector);
            assert.equal(style.background, 'none', 'Flat chat surface: ' + style.selector);
        }
        await browser.wait(`(() => {
            const swatch = document.createElement('span');
            swatch.style.color = 'var(--accent)';
            document.body.append(swatch);
            const accent = getComputedStyle(swatch).color;
            swatch.remove();
            return getComputedStyle(document.getElementById('send-button')).backgroundColor === accent;
        })()`);
        await browser.screenshot('desktop-chat-' + state + '-' + theme);
    }
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port; browser = await launch(output);
    await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('mannsathi.avatar.${users.A}','cat');localStorage.setItem('mannsathi.avatar.${users.B}','dog');localStorage.setItem('mannsathi.avatar.guest','frog');if(!localStorage.getItem('mannsathi_chats'))localStorage.setItem('mannsathi_chats',JSON.stringify([{id:123,title:'Saved conversation',messages:[{role:'user',text:'Hello from history'},{role:'assistant',text:'Saved reply'}],createdAt:new Date().toISOString()}]));}catch{}` });
    await browser.viewport(1440, 900); await browser.command('Page.navigate', { url: base + '/app.html' }); await ready();
    await assertView('dashboard'); assert.equal(await avatar('#user-avatar'), 'cat');
    await checkMenuClosed();
    await clickVisible('#user-avatar');
    await checkMenuOpen();
    assert.equal(await avatar('#account-menu-avatar'), 'cat');
    assert.equal(await browser.evaluate('document.getElementById("account-menu-name").textContent'), 'Student A');
    assert.equal(await browser.evaluate('document.getElementById("sidebar-username").textContent'), 'Student A');
    assert.equal(await browser.evaluate('document.activeElement.dataset.openSettings'), 'profile');
    await press('End');
    assert.equal(await browser.evaluate('document.activeElement.id'), 'sidebar-signout');
    await press('ArrowDown');
    assert.equal(await browser.evaluate('document.activeElement.dataset.openSettings'), 'profile');
    assert.match(await browser.evaluate('document.getElementById("sidebar-signout").textContent'), /sign out|log out/i);
    await browser.screenshot('desktop-account-menu-dark');
    await clickVisible('#dashboard-heading');
    await checkMenuClosed();
    await checkSettingsFromMenu('#settings-button', 'account', 'user-profile-card');
    await checkSettingsFromMenu('#account-menu [data-open-settings="profile"]', 'profile', 'user-profile-card');
    await checkSettingsFromMenu('#account-menu [data-open-settings="appearance"]', 'appearance', 'user-profile-card');
    await clickVisible('#sidebar-username');
    await clickVisible('#account-help');
    assert.equal(await browser.evaluate('document.getElementById("help-dialog").open'), true);
    await clickVisible('#help-dialog [data-close-dialog]');
    await browser.wait('document.activeElement.id === "user-profile-card"');
    // The default skip target must receive keyboard focus.
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
    await checkChatThemes('empty');
    await clickVisible('#message-input');
    await browser.command('Input.insertText', { text: 'Help me plan my study break.' });
    await press('Enter');
    await browser.wait('document.querySelector(".message.assistant .msg-body")?.textContent.includes("Local fixture reply.")');
    await checkChatThemes('populated');
    await browser.click('#open-dashboard'); await browser.click('#sidebar-toggle');
    assert.equal(await browser.evaluate('document.getElementById("sidebar-toggle").getAttribute("aria-expanded")'), 'false');
    assert.equal(await browser.evaluate('document.getElementById("sidebar-toggle").getAttribute("aria-label")'), 'Expand sidebar');
    assert.equal(await browser.evaluate('document.querySelector(".sidebar-conversations").getClientRects().length'), 0);
    await browser.wait('document.getElementById("sidebar").getBoundingClientRect().width < 80');
    for (const id of ['open-dashboard', 'open-chat', 'open-calendar', 'open-tasks', 'open-focus', 'new-chat', 'user-profile-card']) assert(await browser.evaluate(`document.getElementById(${JSON.stringify(id)}).getAttribute('aria-label')`), 'Missing collapsed label: ' + id);
    await browser.command('Page.reload'); await ready();
    assert.equal(await browser.evaluate('document.querySelector(".app-card").classList.contains("sidebar-collapsed")'), true);
    await browser.wait('document.getElementById("sidebar").getBoundingClientRect().width < 80');
    await browser.screenshot('desktop-collapsed');
    await clickVisible('#user-avatar');
    await checkMenuOpen();
    await browser.screenshot('desktop-account-menu-collapsed-light');
    await clickVisible('#settings-button');
    await clickVisible('#settings-dialog [data-close-dialog]');
    await browser.click('#sidebar-toggle');
    assert.equal(await browser.evaluate('document.getElementById("sidebar-toggle").getAttribute("aria-expanded")'), 'true');
    await browser.click('.chat-item-open');
    await browser.evaluate('window.__testSetUser("B")');
    await browser.wait('document.querySelector("#user-avatar").dataset.avatar === "dog"');
    assert.equal(await avatar('#account-menu-avatar'), 'dog');
    assert.equal(await browser.evaluate('document.getElementById("account-menu-name").textContent'), 'Student B');
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
        await browser.wait('Math.abs(document.getElementById("sidebar").getBoundingClientRect().left) < 1');
        assert.equal(await browser.evaluate('document.getElementById("mobile-menu").getAttribute("aria-expanded")'), 'true');
        assert.equal(await browser.evaluate('document.getElementById("main-panel").inert'), true);
        assert.equal(await browser.evaluate('document.activeElement.id'), 'sidebar-close');
        assert(await browser.evaluate('document.querySelector("#open-dashboard span").getClientRects().length > 0'), 'Desktop collapsed styles leaked into mobile sidebar');
        await browser.evaluate('document.getElementById("user-profile-card").focus()');
        await press('Tab');
        assert.equal(await browser.evaluate('document.activeElement.classList.contains("sidebar-brand")'), true);
        await browser.evaluate('document.getElementById("user-profile-card").focus()');
        await press('Enter');
        await checkMenuOpen();
        assert.match(await browser.evaluate('document.getElementById("sidebar-signout").textContent'), /sign in/i);
        assert.equal(await browser.evaluate('document.querySelector(\'#account-menu [data-open-settings="profile"]\').getClientRects().length'), 0);
        await browser.screenshot('mobile-account-menu-' + width);
        await press('Escape');
        await checkMenuClosed();
        assert.equal(await browser.evaluate('document.activeElement.id'), 'user-profile-card');
        assert.equal(await browser.evaluate('document.getElementById("main-panel").inert'), true);
        await press('Escape');
        assert.equal(await browser.evaluate('document.getElementById("mobile-menu").getAttribute("aria-expanded")'), 'false');
        assert.equal(await browser.evaluate('document.getElementById("main-panel").inert'), false);
        assert.equal(await browser.evaluate('document.activeElement.id'), 'mobile-menu');
        await clickVisible('#mobile-menu');
        await browser.wait('Math.abs(document.getElementById("sidebar").getBoundingClientRect().left) < 1');
        await checkSettingsFromMenu('#settings-button', 'account', 'mobile-menu');
        await clickVisible('#mobile-menu');
        await browser.wait('Math.abs(document.getElementById("sidebar").getBoundingClientRect().left) < 1');
        await clickVisible('#open-chat'); await assertView('chat');
        assert.equal(await browser.evaluate('document.getElementById("sidebar").classList.contains("open")'), false);
        await browser.screenshot('mobile-chat-' + width);
    }
    for (const [width, height] of [[820, 360], [740, 320]]) {
        await browser.viewport(width, height);
        if (width <= 760) {
            await clickVisible('#mobile-menu');
            await browser.wait('Math.abs(document.getElementById("sidebar").getBoundingClientRect().left) < 1');
        }
        const bounds = await browser.evaluate('document.getElementById("user-profile-card").getBoundingClientRect().toJSON()');
        assert(bounds.top >= 0 && bounds.bottom <= height, 'Profile control must fit at ' + width + ' × ' + height + ': ' + JSON.stringify(bounds));
        await clickVisible('#user-profile-card');
        await checkMenuOpen();
        await browser.screenshot('account-menu-short-' + width);
        await press('Escape');
        if (width <= 760) await press('Escape');
    }
    assert.equal(browser.errors.length, 0, 'Unhandled browser exceptions: ' + JSON.stringify(browser.errors));
    console.log('PASS mobile focus, profile menu and settings routes, short-height layouts, and dark/light chat controls');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
