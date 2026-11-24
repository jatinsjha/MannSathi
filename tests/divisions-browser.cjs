/* Local browser contract fixtures only. Production uses authenticated Supabase RPCs. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.preview', 'divisions-screenshots');
fs.mkdirSync(output, { recursive: true });
const users = Object.fromEntries(['A', 'B', 'C', 'T'].map((label, index) => [label, '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0')]));
const tasks = new Map(), recipients = new Map(), notices = new Map(), requests = [];
let sequence = 0, expired = false, offline = false, base, browser, ws, session, nextId = 0;
const pending = new Map(), pageErrors = [];
const uuid = () => '00000000-0000-4000-9000-' + String(++sequence).padStart(12, '0');
const isTeacher = user => user === users.T;
const profiles = new Map(), memberships = new Map();
const member = user => memberships.get(user)?.status === 'approved';
const role = user => isTeacher(user) ? 'teacher' : 'student';
const classRows = () => Object.values(users).filter(user => !isTeacher(user) && member(user)).map(user => ({id:user,full_name:profiles.get(user)?.full_name || 'Student',roll_number:profiles.get(user)?.roll_number || '',batch_id:'25cs',division:memberships.get(user)?.division || null}));
const classInfo = () => ({id:'25cs',label:'25CS',student_count:classRows().length,divisions:['A','B','C'].map(id=>({id,label:id,student_count:classRows().filter(student=>student.division===id).length}))});
const context = user => ({role:role(user),user_id:user,batches:isTeacher(user)||member(user)?[classInfo()]:[],students:isTeacher(user)?classRows():[]});
function visible(task, user) {
  if (task.audience === 'personal') return task.created_by === user;
  return isTeacher(user) && task.created_by === user || member(user) && recipients.has(task.id + ':' + user) && (task.audience !== 'division' || memberships.get(user)?.division === task.target_division);
}
function view(task, user) {
  const assigned = [...recipients.entries()].filter(([key]) => key.startsWith(task.id + ':')).map(([, value]) => value);
  const progress = recipients.get(task.id + ':' + user);
  return { ...task, ...(progress && !isTeacher(user) ? progress : {}),
    assigned_by: task.audience === 'personal' ? null : 'Teacher T',
    recipient_count: assigned.length, completed_count: assigned.filter(value => value.status === 'completed').length };
}
const stubSdk = `(() => {
  const users = ${JSON.stringify(users)}, callbacks = [];
  const label = () => { const value=localStorage.getItem('tasks-test-user'); return value==='none' ? null : value || 'A'; };
  const current = () => label() ? {access_token:'test-'+label(),user:{id:users[label()],email:label().toLowerCase()+'@example.test',user_metadata:{full_name:(label()==='T'?'Teacher ':'Student ')+label()}}} : null;
  window.__testSetUser = value => {localStorage.setItem('tasks-test-user',value||'none');callbacks.forEach(callback=>callback(value?'SIGNED_IN':'SIGNED_OUT',current()));};
  window.supabase = {createClient:()=>({auth:{
    getSession:async()=>({data:{session:current()},error:null}),
    getUser:async()=>({data:{user:current()?.user||null},error:null}),
    onAuthStateChange:callback=>{callbacks.push(callback);setTimeout(()=>callback('INITIAL_SESSION',current()),0);return {data:{subscription:{unsubscribe(){}}}};},
    signOut:async()=>{window.__testSetUser(null);return {error:null};},
    signInWithPassword:async({email})=>{window.__testSetUser(email.split('@')[0].slice(0,1).toUpperCase());return {data:{session:current(),user:current()?.user},error:null};},
    resetPasswordForEmail:async(email)=>{window.__resetEmail=email;return {error:null};}
  }})};
})();`;
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function assignment(task) {
  const targets = task.audience === 'class' ? classRows().map(student=>student.id) : task.audience === 'division' ? classRows().filter(student=>student.division===task.target_division).map(student=>student.id) : task.audience === 'student' ? [task.assigned_to] : [];
  for (const user_id of targets) {
    recipients.set(task.id + ':' + user_id, { status: 'pending', completed_at: null });
    const id = uuid();
    notices.set(id, { id, user_id, task_id: task.id, batch_id:task.batch_id,target_division:task.target_division||null, title: 'New work assigned', message: 'Teacher T assigned you ' + task.title + '.', read_at: null, created_at: new Date().toISOString() });
  }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/test-supabase.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(stubSdk); return; }
  if (url.pathname === '/api/config') { json(res, 200, { supabaseUrl: 'https://example.test', supabaseKey: 'test-publishable-fixture' }); return; }
  if (url.pathname === '/api/chat') { for await (const chunk of req) {} json(res, 200, { reply: 'Chat still works.' }); return; }
  if (url.pathname === '/api/calendar') { json(res, 200, { events: [] }); return; }
  if (url.pathname === '/api/tasks') {
    if (offline) { req.socket.destroy(); return; }
    let raw=''; for await (const chunk of req) raw+=chunk;
    const user = users[(req.headers.authorization || '').replace('Bearer test-', '')];
    const action = url.searchParams.get('action') || ({ GET:'list',POST:'create',PATCH:'edit',DELETE:'delete' }[req.method]);
    const body=raw ? JSON.parse(raw) : {}, id=url.searchParams.get('id');
    requests.push({ action, method:req.method, user, body });
    if (!user || expired) { json(res,401,{error:'Your session has expired. Sign in again.'}); return; }
    if(req.method==='GET' && action==='settings') {const label=Object.keys(users).find(key=>users[key]===user);json(res,200,{role:role(user),profile:profiles.get(user)||{full_name:(isTeacher(user)?'Teacher ':'Student ')+label,roll_number:'',class_code:null,division:null},membership:memberships.get(user)||null,classes:[{id:'25cs',label:'25CS',divisions:['A','B','C']}]});return;}
    if(req.method==='PATCH' && action==='settings') {
      if(isTeacher(user)){json(res,403,{error:'Student details are for student accounts.'});return;}
      const previous=memberships.get(user), same=previous?.batch_id===body.class_code && previous?.division===body.division;
      profiles.set(user,{...body});memberships.set(user,{batch_id:body.class_code,batch_code:body.class_code,division:body.division,status:same?previous.status:'pending'});
      json(res,200,{role:'student',profile:profiles.get(user),membership:memberships.get(user),classes:[{id:'25cs',label:'25CS',divisions:['A','B','C']}]});return;
    }
    if(req.method==='GET' && action==='enrollments') {if(!isTeacher(user)){json(res,403,{error:'Teacher access required.'});return;}const enrollments=[...memberships].filter(([uid,m])=>m.status==='pending'&&m.batch_id==='25cs').map(([uid,m])=>({user_id:uid,...profiles.get(uid),...m}));json(res,200,{role:'teacher',enrollments});return;}
    if(req.method==='PATCH' && action==='enrollment') {const membership=memberships.get(body.student_id);if(!isTeacher(user)||body.batch_id!=='25cs'||!membership||membership.batch_id!==body.batch_id){json(res,403,{error:'Enrollment access denied.'});return;}if(!Object.hasOwn(body,'expected_division')||body.expected_division!==membership.division){json(res,409,{error:'This enrollment request changed. Refresh the roster before reviewing it.'});return;}membership.status=body.approve?'approved':'rejected';json(res,200,{approved:body.approve,membership});return;}

    if (req.method==='GET' && action==='context') { json(res,200,context(user)); return; }
    if (req.method==='GET' && action==='list') { json(res,200,{role:role(user),tasks:[...tasks.values()].filter(task=>visible(task,user)).map(task=>view(task,user))}); return; }
    if (req.method==='GET' && action==='notifications') {
      const notifications=[...notices.values()].filter(notice=>notice.user_id===user&&member(user)&&(!notice.target_division||memberships.get(user)?.division===notice.target_division)&&(!notice.task_id||visible(tasks.get(notice.task_id),user))).sort((a,b)=>b.created_at.localeCompare(a.created_at));
      json(res,200,{notifications,unread_count:notifications.filter(notice=>!notice.read_at).length}); return;
    }
    if (req.method==='PATCH' && action==='read') {
      const notice=notices.get(id); if(!notice||notice.user_id!==user){json(res,404,{error:'Notification unavailable.'});return;}
      notice.read_at=new Date().toISOString();json(res,200,{read:true});return;
    }
    if (req.method==='POST' && action==='create') {
      if(body.audience!=='personal' && (!isTeacher(user)||body.batch_id!=='25cs'||body.audience==='student'&&!member(body.assigned_to))){json(res,403,{error:'You can assign work only to approved students in your classes.'});return;}
      const old=[...tasks.values()].find(task=>task.created_by===user&&task.request_id===body.request_id);
      if(old){json(res,201,{task:view(old,user)});return;}
      const now=new Date().toISOString();
      const task={...body,id:uuid(),created_by:user,assigned_to:body.audience==='personal'?user:body.assigned_to||null,status:body.audience==='personal'?body.status:'pending',completed_at:body.audience==='personal'&&body.status==='completed'?now:null,created_at:now,updated_at:now};
      tasks.set(task.id,task);assignment(task);json(res,201,{task:view(task,user)});return;
    }
    const task=tasks.get(id);
    if(!task||!visible(task,user)){json(res,404,{error:'Task unavailable.'});return;}
    if(req.method==='PATCH' && action==='status') {
      if(task.audience!=='personal' && isTeacher(user)){json(res,403,{error:'Only the student can change this progress.'});return;}
      const target=task.audience==='personal'?task:recipients.get(task.id+':'+user);
      target.status=body.status;target.completed_at=body.status==='completed'?new Date().toISOString():null;json(res,200,{task:view(task,user)});return;
    }
    if(task.created_by!==user){json(res,403,{error:'You cannot edit or delete teacher assignments.'});return;}
    if(req.method==='PATCH' && action==='edit'){Object.assign(task,body,{updated_at:new Date().toISOString()});json(res,200,{task:view(task,user)});return;}
    if(req.method==='DELETE' && action==='delete'){
      tasks.delete(id);for(const key of recipients.keys())if(key.startsWith(id+':'))recipients.delete(key);
      for(const notice of notices.values())if(notice.task_id===id)notice.task_id=null;
      json(res,200,{deleted:true});return;
    }
    json(res,405,{error:'Method not allowed.'});return;
  }
  const file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{
    let data=fs.readFileSync(file);
    if(path.extname(file)==='.html')data=Buffer.from(data.toString('utf8').replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2','/test-supabase.js'));
    res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]||'application/octet-stream'});res.end(data);
  }catch{res.writeHead(404);res.end('Not found');}
});
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
function command(method, params={}, sid=session) {
  const id=++nextId;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));
  });
}
async function evaluate(expression) {
  const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.text+': '+JSON.stringify(result.exceptionDetails.exception));
  return result.result.value;
}
async function waitFor(expression) {
  const start=Date.now();while(Date.now()-start<10000){if(await evaluate(expression))return;await delay(50);}
  throw new Error('Condition not reached: '+expression);
}
async function navigate(file='app.html') {
  await command('Page.navigate',{url:base+'/'+file});
  await waitFor('location.pathname === '+JSON.stringify('/'+file.split('?')[0])+' && document.readyState === "complete" && !!window.supabaseReady');
  await evaluate('document.fonts.ready');await delay(100);
  if (file.includes('login')) await waitFor('!!document.getElementById("login-form") && !document.querySelector(".login-button").disabled');
}
async function reload() {
  await command('Page.reload');await waitFor('document.readyState === "complete" && !!window.MannSathiTaskService && !!document.getElementById("open-tasks")');await delay(100);
}
async function click(selector) {await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);}
async function fill(values) {
  await evaluate(`for(const [id,value] of Object.entries(${JSON.stringify(values)})){const el=document.getElementById(id);if(!el)throw new Error('Missing control '+id);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}`);
}
async function taskReady() {await waitFor('document.getElementById("tasks-panel").getAttribute("aria-busy") === "false" && !document.getElementById("tasks-create").disabled');}
async function openTasks() {await click('#open-tasks');await taskReady();}
async function switchUser(label) {
  await evaluate(`window.__testSetUser(${JSON.stringify(label)})`);await delay(150);await openTasks();
  assert.equal(await evaluate('document.getElementById("account-type").textContent'),label==='T'?'Teacher account':'Student account');
}
async function saveTask() {await evaluate('document.getElementById("task-form").requestSubmit()');await waitFor('!document.getElementById("task-dialog").open');await taskReady();}
async function openTask(id) {await click(`[data-task-edit="${id}"]`);await waitFor('document.getElementById("task-dialog").open');}
async function statusTask(id,status) {
  await evaluate(`(()=>{const select=document.querySelector('[data-task-status="${id}"]');select.value=${JSON.stringify(status)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('[data-task-status="${id}"]')?.value === ${JSON.stringify(status)} && !document.querySelector('[data-task-status="${id}"]')?.disabled`);
  await taskReady();
}
async function resetFilters() {await fill({'tasks-filter-status':'all','tasks-filter-priority':'all','tasks-filter-source':'all','tasks-search':'','tasks-sort':'due_asc'});}
async function visibleIds() {return evaluate('[...document.querySelectorAll("#tasks-list [data-task-id]")].map(el=>el.dataset.taskId)');}
async function notificationsReady(count) {
  await click('#notifications-button');
  await waitFor(`document.getElementById('notifications-dialog').open && document.querySelectorAll('#notifications-list [data-notification-id]').length === ${count}`);
}
async function viewport(width,height){await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<761});}
async function screenshot(name){const{data}=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(data,'base64'));}
async function checkLayout(width,height) {
  await viewport(width,height);
  const layout=await evaluate(`(()=>{const box=document.querySelector('.app-card'),rect=box.getBoundingClientRect(),style=getComputedStyle(box),panel=document.getElementById('tasks-panel');return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,border:style.borderTopWidth,radius:style.borderTopLeftRadius,panel:panel.clientWidth,panelScroll:panel.scrollWidth,images:[...document.images].filter(image=>!image.complete||!image.naturalWidth).map(image=>image.src)};})()`);
  assert(layout.scroll<=layout.width&&layout.panelScroll<=layout.panel+1,'Horizontal overflow: '+JSON.stringify(layout));
  assert(Math.abs(layout.left)<1&&Math.abs(layout.top)<1&&Math.abs(layout.right-layout.width)<1&&Math.abs(layout.bottom-layout.height)<1,'Workspace is boxed: '+JSON.stringify(layout));
  assert.equal(layout.border,'0px');assert.equal(layout.radius,'0px');assert.equal(layout.images.length,0);
}
async function initializeBrowser() {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--remote-debugging-port=0','--user-data-dir='+path.join(output,'chrome-profile'),'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  const endpoint=await new Promise((resolve,reject)=>{
    let stderr='';const timer=setTimeout(()=>reject(new Error('Chrome did not start: '+stderr.slice(-500))),20000);
    browser.stderr.on('data',data=>{stderr+=data;const match=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    browser.on('error',error=>{clearTimeout(timer);reject(error);});
  });
  ws=new WebSocket(endpoint);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  ws.onmessage=event=>{const data=JSON.parse(event.data);if(data.id&&pending.has(data.id)){const entry=pending.get(data.id);clearTimeout(entry.timer);pending.delete(data.id);data.error?entry.reject(new Error(JSON.stringify(data.error))):entry.resolve(data.result);}if(data.method==='Runtime.exceptionThrown')pageErrors.push(data.params.exceptionDetails);};
  const target=await command('Target.createTarget',{url:'about:blank'},null);session=(await command('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId;
  await command('Page.enable');await command('Runtime.enable');await command('Emulation.setTimezoneOverride',{timezoneId:'Asia/Kolkata'});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`const RealDate=Date;window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-11-24T06:30:00Z']));}static now(){return new RealDate('2026-11-24T06:30:00Z').getTime();}};`});
  await viewport(1440,900);await navigate();await evaluate('localStorage.removeItem("mannsathi_chats");window.__testSetUser("A");window.MannSathiTheme.apply("dark")');await delay(100);await openTasks();
}
async function createPersonal(title, values={}) {
  await click('#tasks-create');
  await fill({'task-title':title,...values});await saveTask();
  return [...tasks.values()].find(task=>task.title===title);
}
async function deleteTask(id, cancel=false) {
  await openTask(id);await click('#task-delete');
  if(cancel){await click('#task-delete-dialog [data-task-close]');assert(tasks.has(id));await click('#task-dialog [data-task-close]');return;}
  await click('#task-delete-confirm');await waitFor('!document.getElementById("task-dialog").open');await taskReady();assert(!tasks.has(id));
}
async function details(label, name, roll, division, expected='pending') {
  await switchUser(label); await click('#settings-button'); await click('[data-settings-tab="profile"]');
  await waitFor('!document.getElementById("student-profile-section").hidden && document.querySelectorAll("#profile-class option").length > 0');
  await fill({'profile-name':name,'profile-roll':roll,'profile-class':'25cs','profile-division':division});
  await evaluate('document.getElementById("student-profile-form").requestSubmit()');
  await waitFor(`document.getElementById('profile-membership-status').textContent.toLowerCase().includes(${JSON.stringify(expected)})`);
  assert.equal(memberships.get(users[label]).status,expected); assert.equal(profiles.get(users[label]).division,division);
  await waitFor(`document.getElementById('sidebar-username').textContent === ${JSON.stringify(name)}`);
  await click('#settings-dialog [data-close-dialog]');
}
async function rosterReady(user, division) {
  await waitFor('document.getElementById("roster-status").textContent.toLowerCase().includes("up to date") && [...document.querySelectorAll("[data-enrollment-approve],[data-enrollment-reject]")].every(button=>!button.disabled)');
  if(user) await waitFor(`(()=>{const row=document.querySelector('[data-enrollment-user="${user}"]');const button=document.querySelector('[data-enrollment-approve="${user}"]');return row?.dataset.enrollmentDivision === ${JSON.stringify(division)} && !!button && !button.disabled;})()`);
}
async function refreshRoster(user, division) {
  await click('#roster-refresh');await rosterReady(user, division);
}
async function enrollmentChecks() {
  await switchUser('T'); await waitFor('!document.getElementById("teacher-roster-section").hidden');
  assert.equal(classRows().length,0); await click('#tasks-create'); await fill({'task-title':'Empty class work','task-audience':'class','task-batch':'25cs'});
  const count=requests.filter(request=>request.action==='create').length;
  assert.equal(await evaluate('document.getElementById("task-save").disabled'),true,'Empty class must disable assignment');
  await click('#task-save'); assert.equal(requests.filter(request=>request.action==='create').length,count); await click('#task-dialog [data-task-close]');
  await details('A','Alice Student','01','A'); await details('B','Bob Student','02','B'); await details('C','Carol Student','03','C');
  assert.equal(classRows().length,0,'Settings must not approve their own enrollment');
  await switchUser('T'); await refreshRoster(); await waitFor('document.querySelectorAll("[data-enrollment-user]").length === 3');
  for(const label of ['A','B','C']) {await rosterReady(users[label],label);await click(`[data-enrollment-approve="${users[label]}"]`);await waitFor(`!document.querySelector('[data-enrollment-user="${users[label]}"]')`);await rosterReady();}
  await waitFor('document.querySelectorAll("[data-roster-user]").length === 3');
  assert.equal(classRows().length,3); assert(classRows().every(student=>student.roll_number&&student.division));
  await click('#tasks-create'); await fill({'task-title':'All 25CS work','task-audience':'class','task-batch':'25cs'}); await saveTask();
  const all=[...tasks.values()].find(task=>task.title==='All 25CS work');
  for(const label of ['A','B','C'])assert(recipients.has(all.id+':'+users[label]));
  await click('#tasks-create'); await fill({'task-title':'Division A work','task-audience':'division','task-batch':'25cs','task-division':'A'}); await saveTask();
  const a=[...tasks.values()].find(task=>task.title==='Division A work'); assert.equal(a.target_division,'A');
  assert(recipients.has(a.id+':'+users.A)); assert(!recipients.has(a.id+':'+users.B)); assert(!recipients.has(a.id+':'+users.C));
  await click('#tasks-create'); await fill({'task-title':'Division B work','task-audience':'division','task-batch':'25cs','task-division':'B'}); await saveTask();
  const b=[...tasks.values()].find(task=>task.title==='Division B work'); assert(recipients.has(b.id+':'+users.B)); assert(!recipients.has(b.id+':'+users.A));
  await click('#tasks-create'); await fill({'task-audience':'student','task-batch':'25cs','task-roster-division':'A'});
  assert.equal(await evaluate('document.querySelectorAll("#task-student option").length'),2,'A division filter must expose one student and placeholder');
  await fill({'task-title':'Alice individual work','task-student':users.A});await saveTask();
  const one=[...tasks.values()].find(task=>task.title==='Alice individual work');assert.equal(one.assigned_to,users.A);assert(!one.target_division);
  await switchUser('A'); const ids=await visibleIds();assert(ids.includes(all.id)&&ids.includes(a.id)&&ids.includes(one.id)&&!ids.includes(b.id));
  await statusTask(a.id,'completed');assert.equal(recipients.get(a.id+':'+users.A).status,'completed');assert.equal(recipients.get(all.id+':'+users.B).status,'pending');
  await notificationsReady(3); assert.equal(await evaluate('document.getElementById("notifications-count").textContent'),'3');await click('#notifications-dialog [data-task-close]');
  await details('A','Alice Updated','11','A','approved');await reload();await openTasks();await waitFor('document.getElementById("sidebar-username").textContent === "Alice Updated"');
  assert.equal(memberships.get(users.A).status,'approved','Name/roll changes must preserve an unchanged approved class/division');
  await details('A','Alice Updated','11','B'); await openTasks();assert.equal((await visibleIds()).length,0,'Division change stays pending until reviewed');
  await switchUser('T');await refreshRoster(users.A,'B');await click(`[data-enrollment-approve="${users.A}"]`);await waitFor(`!document.querySelector('[data-enrollment-user="${users.A}"]')`);await rosterReady();
  await switchUser('A');assert(!(await visibleIds()).includes(b.id),'Approval must not retroactively add a student to existing division assignments');
  await details('A','Alice Updated','11','C');await switchUser('T');await refreshRoster(users.A,'C');
  memberships.get(users.A).division='A';profiles.get(users.A).division='A';
  await click(`[data-enrollment-approve="${users.A}"]`);
  await waitFor('document.getElementById("roster-status").textContent.toLowerCase().includes("changed")');
  assert.equal(memberships.get(users.A).status,'pending','Stale C review must not approve the new A request');
  const stale=requests.filter(request=>request.action==='enrollment').at(-1);assert.equal(stale.body.expected_division,'C');
  await refreshRoster(users.A,'A');
  await click(`[data-enrollment-approve="${users.A}"]`);await waitFor(`!document.querySelector('[data-enrollment-user="${users.A}"]')`);await rosterReady();
  assert.equal(memberships.get(users.A).status,'approved');assert.equal(memberships.get(users.A).division,'A');
  console.log('PASS self-service profile requests, teacher enrollment review, approved roster counts, class/division/individual targeting and private progress');
}
async function settingsAndLayout() {
  await details('C','<img src=x onerror="window.__profileXss=true">','03','C','approved');
  await switchUser('T');await refreshRoster();await waitFor('document.querySelectorAll("[data-roster-user]").length === 3');
  assert.equal(await evaluate('window.__profileXss'),undefined);assert.equal(await evaluate('document.querySelectorAll("#approved-roster-list img").length'),0);
  for(const [width,height] of [[1440,900],[390,844],[320,740]]) {
    await viewport(width,height);await screenshot('teacher-roster-'+width);
    await click('#tasks-create');await fill({'task-audience':'division','task-batch':'25cs','task-division':'B'});
    const bounds=await evaluate('(()=>{const d=document.getElementById("task-dialog"),r=d.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,scroll:d.scrollWidth,client:d.clientWidth};})()');
    assert(bounds.left>=0&&bounds.right<=bounds.width+1&&bounds.scroll<=bounds.client+1);await screenshot('division-editor-'+width);await click('#task-dialog [data-task-close]');
  }
  await viewport(1440,900);await switchUser('A');await click('#settings-button');await click('[data-settings-tab="account"]');
  await waitFor('document.getElementById("settings-account-email").textContent.includes("a@example.test")');await click('#settings-password-reset');
  await waitFor('window.__resetEmail === "a@example.test"');
  await click('[data-settings-tab="appearance"]');assert.equal(await evaluate('document.querySelector("[data-settings-panel=appearance]").hidden'),false);
  await click('[data-settings-tab="profile"]');await waitFor('!document.getElementById("student-profile-section").hidden');
  for(const [width,height] of [[1440,900],[390,844],[320,740]]) {
    await viewport(width,height);
    for(const theme of ['dark','light']) {
      await evaluate(`window.MannSathiTheme.apply(${JSON.stringify(theme)})`);
      const bounds=await evaluate('(()=>{const d=document.getElementById("settings-dialog"),r=d.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,scroll:d.scrollWidth,client:d.clientWidth};})()');
      assert(bounds.left>=0&&bounds.right<=bounds.width+1&&bounds.scroll<=bounds.client+1);await screenshot('student-settings-'+theme+'-'+width);
    }
  }
  await click('#settings-dialog [data-close-dialog]');await viewport(1440,900);await switchUser('T');await click('#settings-button');await click('[data-settings-tab="profile"]');
  await waitFor('document.getElementById("student-profile-section").hidden');assert.equal(await evaluate('document.getElementById("student-profile-section").hidden'),true);
  await click('#settings-dialog [data-close-dialog]');
  console.log('PASS persisted profile names, safe roster text, own-account reset, settings sections and responsive settings/division dialogs');
}
(async()=>{
  await initializeBrowser();await enrollmentChecks();await settingsAndLayout();
  assert.equal(pageErrors.length,0,'Unhandled JavaScript exceptions: '+JSON.stringify(pageErrors));
  console.log('Division/settings browser checks passed. Screenshots: '+output);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(ws){try{await command('Browser.close',{},null);}catch{}ws.close();}
  if(browser)browser.kill();for(const entry of pending.values())clearTimeout(entry.timer);server.close();
});
