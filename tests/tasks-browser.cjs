/* Local browser contract fixtures only. Production uses authenticated Supabase RPCs. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.preview', 'tasks-screenshots');
fs.mkdirSync(output, { recursive: true });
const users = Object.fromEntries(['A', 'B', 'C', 'T'].map((label, index) => [label, '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0')]));
const tasks = new Map(), recipients = new Map(), notices = new Map(), requests = [];
let sequence = 0, expired = false, offline = false, base, browser, ws, session, nextId = 0;
const pending = new Map(), pageErrors = [];
const uuid = () => '00000000-0000-4000-9000-' + String(++sequence).padStart(12, '0');
const isTeacher = user => user === users.T;
const member = user => user === users.A || user === users.B;
const role = user => isTeacher(user) ? 'teacher' : 'student';
const context = user => ({ role: role(user), user_id: user,
  batches: isTeacher(user) || member(user) ? [{ id: '25cs', label: '25CS' }] : [],
  students: isTeacher(user) ? ['A', 'B'].map(label => ({ id: users[label], full_name: 'Student ' + label, batch_id: '25cs' })) : [] });
function visible(task, user) {
  if (task.audience === 'personal') return task.created_by === user;
  return isTeacher(user) && task.created_by === user || member(user) && recipients.has(task.id + ':' + user);
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
    resetPasswordForEmail:async()=>({error:null})
  }})};
})();`;
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function assignment(task) {
  const targets = task.audience === 'class' ? [users.A, users.B] : task.audience === 'student' ? [task.assigned_to] : [];
  for (const user_id of targets) {
    recipients.set(task.id + ':' + user_id, { status: 'pending', completed_at: null });
    const id = uuid();
    notices.set(id, { id, user_id, task_id: task.id, title: 'New work assigned', message: 'Teacher T assigned you ' + task.title + '.', read_at: null, created_at: new Date().toISOString() });
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
    if (req.method==='GET' && action==='context') { json(res,200,context(user)); return; }
    if (req.method==='GET' && action==='list') { json(res,200,{role:role(user),tasks:[...tasks.values()].filter(task=>visible(task,user)).map(task=>view(task,user))}); return; }
    if (req.method==='GET' && action==='notifications') {
      const notifications=[...notices.values()].filter(notice=>notice.user_id===user).sort((a,b)=>b.created_at.localeCompare(a.created_at));
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
async function personalChecks() {
  assert.equal(tasks.size,0);assert.match(await evaluate('document.getElementById("tasks-status").textContent'),/No tasks/);
  const first=await createPersonal('Read arrays',{'task-description':'Review insertion and deletion','task-subject':'Data structures','task-type':'homework','task-due':'2026-11-24T14:00','task-estimated':'35','task-priority':'urgent'});
  assert.equal(first.created_by,users.A);assert.equal(first.audience,'personal');assert.equal(first.due_at,'2026-11-24T08:30:00.000Z');assert.equal(first.estimated_minutes,35);assert.equal(first.task_type,'homework');assert.equal(first.subject,'Data structures');
  assert.equal(notices.size,0,'Personal tasks must not generate teacher notifications');
  const request=requests.find(entry=>entry.action==='create');assert.match(request.body.request_id,/^[0-9a-f-]{36}$/);assert.equal(request.body.created_by,undefined);
  const retryStatus=await evaluate(`fetch('/api/tasks?action=create',{method:'POST',headers:{Authorization:'Bearer test-A','Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(request.body)})}).then(response=>response.status)`);
  assert.equal(retryStatus,201);assert.equal(tasks.size,1,'Retry must not duplicate a task');
  await openTask(first.id);await fill({'task-title':'Read arrays carefully','task-due':'2026-11-24T15:00'});await saveTask();assert.equal(tasks.get(first.id).title,'Read arrays carefully');
  await openTask(first.id);await fill({'task-title':'   '});await evaluate('document.getElementById("task-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
  await waitFor('document.getElementById("task-form-error").textContent.length > 0');assert.equal(tasks.get(first.id).title,'Read arrays carefully');await click('#task-dialog [data-task-close]');
  const project=await createPersonal('Plan project',{'task-priority':'low','task-status':'in_progress','task-type':'project'});
  const done=await createPersonal('Finished revision',{'task-due':'2026-11-23T10:00','task-priority':'high','task-status':'completed'});
  const late=await createPersonal('Overdue practical',{'task-due':'2026-11-23T12:00','task-priority':'medium','task-type':'practical'});
  await fill({'tasks-filter-status':'today'});assert.deepEqual(await visibleIds(),[first.id]);
  await fill({'tasks-filter-status':'upcoming'});assert.deepEqual(await visibleIds(),[first.id]);
  await fill({'tasks-filter-status':'overdue'});assert.deepEqual(await visibleIds(),[late.id]);
  await fill({'tasks-filter-status':'completed'});assert.deepEqual(await visibleIds(),[done.id]);
  await fill({'tasks-filter-status':'in_progress'});assert.deepEqual(await visibleIds(),[project.id]);
  await resetFilters();await fill({'tasks-filter-priority':'urgent'});assert.deepEqual(await visibleIds(),[first.id]);
  await resetFilters();await fill({'tasks-search':'Data structures'});assert.deepEqual(await visibleIds(),[first.id]);
  await resetFilters();assert.deepEqual(await visibleIds(),[done.id,late.id,first.id,project.id]);
  await fill({'tasks-sort':'priority'});assert.deepEqual(await visibleIds(),[first.id,done.id,late.id,project.id]);
  await resetFilters();await statusTask(done.id,'pending');assert.equal(tasks.get(done.id).status,'pending');assert.equal(tasks.get(done.id).completed_at,null);
  await statusTask(done.id,'completed');assert.equal(tasks.get(done.id).status,'completed');assert(tasks.get(done.id).completed_at);
  await deleteTask(done.id,true);await deleteTask(done.id);
  const unsafe=await createPersonal('<img src=x onerror="window.__taskInjected=true">',{'task-description':'<script>window.__taskInjected=true</script>'});
  assert.equal(await evaluate('window.__taskInjected'),undefined);assert.equal(await evaluate('document.querySelectorAll(".task-title img,.task-description script").length'),0);await deleteTask(unsafe.id);
  await reload();await openTasks();assert.equal(tasks.size,3);assert.match(await evaluate('document.getElementById("tasks-list").textContent'),/Read arrays carefully/);
  await switchUser('B');assert.equal((await visibleIds()).length,0,'Personal tasks must be private');await switchUser('A');
  console.log('PASS personal task CRUD, cancellation, status/reopen, deadline/priority filters and sorting, UTC dates, estimates, escaping, retry and reload persistence');
}
async function teacherAssignments() {
  await evaluate('window.__testSetUser(null)');await navigate('teacher-login.html');
  await fill({email:'t@example.test',password:'test-password'});await evaluate('document.getElementById("login-form").requestSubmit()');
  await waitFor('location.pathname === "/app.html" && document.readyState === "complete" && !!window.MannSathiTaskService && !!document.getElementById("open-tasks")');await delay(100);await openTasks();
  assert.equal(await evaluate('document.getElementById("account-type").textContent'),'Teacher account');
  await click('#tasks-create');assert.equal(await evaluate('document.getElementById("task-assignment-fields").hidden'),false);
  await fill({'task-title':'Class homework','task-audience':'class','task-batch':'25cs','task-due':'2026-11-25T09:00','task-priority':'high','task-subject':'Compilers','task-estimated':'60'});await saveTask();
  const classTask=[...tasks.values()].find(task=>task.title==='Class homework');assert.equal(classTask.created_by,users.T);assert.equal(classTask.batch_id,'25cs');assert.equal(classTask.audience,'class');
  assert(recipients.has(classTask.id+':'+users.A));assert(recipients.has(classTask.id+':'+users.B));assert.equal(notices.size,2);
  const classRequest=requests.filter(entry=>entry.action==='create').find(entry=>entry.body.title==='Class homework');
  await evaluate(`fetch('/api/tasks?action=create',{method:'POST',headers:{Authorization:'Bearer test-T','Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(classRequest.body)})}).then(response=>response.json())`);
  assert.equal(notices.size,2,'An assignment retry must not notify students twice');
  await click('#tasks-create');await fill({'task-audience':'student','task-batch':'25cs'});
  assert.equal(await evaluate('document.querySelectorAll("#task-student option").length'),3,'Roster contains only the two approved students and placeholder');
  await fill({'task-title':'Individual project','task-student':users.A,'task-type':'project','task-due':'2026-11-26T12:00'});await saveTask();
  const singleTask=[...tasks.values()].find(task=>task.title==='Individual project');assert.equal(singleTask.assigned_to,users.A);assert.equal(notices.size,3);assert(!recipients.has(singleTask.id+':'+users.B));
  await openTask(classTask.id);assert.equal(await evaluate('document.getElementById("task-audience").disabled'),true);await fill({'task-description':'Submit the solution with explanations.'});await saveTask();
  await switchUser('A');const aIds=await visibleIds();assert(aIds.includes(classTask.id)&&aIds.includes(singleTask.id));
  assert.equal(await evaluate(`document.querySelector('[data-task-edit="${classTask.id}"]')`),null);
  await fill({'tasks-filter-source':'assigned'});assert.deepEqual(new Set(await visibleIds()),new Set([classTask.id,singleTask.id]));await resetFilters();
  await statusTask(classTask.id,'completed');assert.equal(recipients.get(classTask.id+':'+users.A).status,'completed');assert.equal(recipients.get(classTask.id+':'+users.B).status,'pending');
  await notificationsReady(2);assert.equal(await evaluate('document.getElementById("notifications-count").textContent'),'2');
  const aNotice=[...notices.values()].find(notice=>notice.user_id===users.A&&notice.task_id===classTask.id);
  await click(`[data-notification-read="${aNotice.id}"]`);await waitFor('document.getElementById("notifications-count").textContent === "1"');assert(notices.get(aNotice.id).read_at);
  await click('#notifications-dialog [data-task-close]');await reload();await openTasks();await notificationsReady(2);assert.equal(await evaluate('document.getElementById("notifications-count").textContent'),'1');
  const singleNotice=[...notices.values()].find(notice=>notice.user_id===users.A&&notice.task_id===singleTask.id);
  await click(`[data-notification-open="${singleNotice.id}"]`);await waitFor('!document.getElementById("notifications-dialog").open && !document.getElementById("tasks-panel").hidden');await taskReady();assert((await visibleIds()).includes(singleTask.id));
  await switchUser('B');assert.deepEqual(await visibleIds(),[classTask.id]);await notificationsReady(1);assert.equal(await evaluate('document.getElementById("notifications-count").textContent'),'1');await click('#notifications-dialog [data-task-close]');
  assert.match(await evaluate('document.getElementById("tasks-list").textContent'),/Submit the solution/);assert.equal(await evaluate(`document.querySelector('[data-task-status="${classTask.id}"]').value`),'pending');
  await switchUser('C');assert.equal((await visibleIds()).length,0);await notificationsReady(0);assert.equal(await evaluate('document.getElementById("notifications-count").hidden'),true);await click('#notifications-dialog [data-task-close]');
  await switchUser('A');const denied=await evaluate(`fetch('/api/tasks?action=create',{method:'POST',headers:{Authorization:'Bearer test-A','Content-Type':'application/json'},body:JSON.stringify({...${JSON.stringify(classRequest.body)},request_id:crypto.randomUUID()})}).then(response=>response.status)`);assert.equal(denied,403);
  await switchUser('T');assert.match(await evaluate('document.getElementById("tasks-list").textContent'),/1 \/ 2 students completed/);await deleteTask(singleTask.id);await switchUser('A');assert(!(await visibleIds()).includes(singleTask.id));assert((await visibleIds()).includes(classTask.id));
  console.log('PASS approved teacher login, class/single assignments, private student visibility, individual completion, assignment notifications/read persistence, teacher edits/deletes and student permission denial');
}
async function layoutAndNavigation() {
  for(const [width,height] of [[1440,900],[390,844],[320,740]]){
    await checkLayout(width,height);await screenshot('tasks-dark-'+width);
    await evaluate('window.MannSathiTheme.apply("light")');await checkLayout(width,height);await screenshot('tasks-light-'+width);
    await click('#tasks-create');await checkLayout(width,height);
    const layout=await evaluate(`(()=>{const dialog=document.getElementById('task-dialog'),rect=dialog.getBoundingClientRect();return {left:rect.left,right:rect.right,client:dialog.clientWidth,scroll:dialog.scrollWidth,width:innerWidth};})()`);
    assert(layout.left>=0&&layout.right<=layout.width+1&&layout.scroll<=layout.client+1,'Dialog overflow: '+JSON.stringify(layout));
    await screenshot('task-dialog-'+width);await click('#task-dialog [data-task-close]');await evaluate('window.MannSathiTheme.apply("dark")');
  }
  await viewport(390,844);await click('#mobile-menu');assert.equal(await evaluate('document.getElementById("main-panel").inert'),true);await screenshot('tasks-mobile-menu');await click('#sidebar-close');assert.equal(await evaluate('document.getElementById("main-panel").inert'),false);
  await viewport(1440,900);await click('#open-calendar');
  await waitFor('!document.getElementById("calendar-panel").hidden && document.getElementById("calendar-content").getAttribute("aria-busy") === "false"');
  assert.equal(await evaluate('document.getElementById("tasks-panel").hidden'),true);assert.equal(await evaluate('document.getElementById("chat-area").hidden'),true);
  await openTasks();assert.equal(await evaluate('document.getElementById("calendar-panel").hidden'),true);assert.equal(await evaluate('document.getElementById("chat-area").hidden'),true);
  await click('#open-chat');assert.equal(await evaluate('document.getElementById("tasks-panel").hidden'),true);assert.equal(await evaluate('document.getElementById("calendar-panel").hidden'),true);assert.equal(await evaluate('document.getElementById("chat-area").hidden'),false);
  await openTasks();
  console.log('PASS edge-to-edge viewport at 1440/390/320, both themes, modal layout, mobile drawer and exclusive Task/Calendar/Chat navigation');
}
async function recoveryAndRoles() {
  expired=true;await click('#tasks-refresh');await waitFor('!document.getElementById("tasks-auth").hidden');assert.equal((await visibleIds()).length,0);assert.equal(await evaluate('document.getElementById("tasks-create").disabled'),true);
  expired=false;await click('#tasks-retry');await taskReady();
  offline=true;await click('#tasks-refresh');await waitFor('!document.getElementById("tasks-retry").hidden');assert.match(await evaluate('document.getElementById("tasks-status").textContent'),/reach|connection|network|retry/i);
  offline=false;await click('#tasks-retry');await taskReady();
  await click('#tasks-create');await fill({'task-title':'Connection retry task'});offline=true;await evaluate('document.getElementById("task-form").requestSubmit()');await waitFor('document.getElementById("task-form-error").textContent.length > 0');assert.equal(await evaluate('document.getElementById("task-dialog").open'),true);
  offline=false;await saveTask();assert.equal([...tasks.values()].filter(task=>task.title==='Connection retry task').length,1);
  await navigate('teacher-login.html');await waitFor('!document.getElementById("role-login-message-link").hidden');assert.equal(await evaluate('location.pathname'),'/teacher-login.html');
  await fill({email:'a@example.test',password:'test-password'});await evaluate('document.getElementById("login-form").requestSubmit()');await waitFor('document.getElementById("form-message").textContent.includes("does not have approved teacher access")');assert.equal(await evaluate('location.pathname'),'/teacher-login.html');assert.equal(await evaluate('localStorage.getItem("tasks-test-user")'),'none');
  await navigate('app.html?guest=true');await click('#open-tasks');await waitFor('!document.getElementById("tasks-auth").hidden');assert.equal(await evaluate('document.getElementById("tasks-create").disabled'),true);assert.equal((await visibleIds()).length,0);
  await click('#open-chat');await fill({'message-input':'Hello from guest'});await evaluate('document.getElementById("chat-form").requestSubmit()');await waitFor('!!document.querySelector(".message.assistant")');assert.match(await evaluate('document.querySelector(".message.assistant").textContent'),/Chat still works/);
  console.log('PASS expired-session clearing, offline load/save recovery, incorrect teacher-login denial and guest Task denial with working chat');
}
(async()=>{
  await initializeBrowser();await personalChecks();await teacherAssignments();await layoutAndNavigation();await recoveryAndRoles();
  assert.equal(pageErrors.length,0,'Unhandled JavaScript exceptions: '+JSON.stringify(pageErrors));
  console.log('Task Manager browser tests passed. Screenshots: '+output);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(ws){try{await command('Browser.close',{},null);}catch{}ws.close();}
  if(browser)browser.kill();for(const entry of pending.values())clearTimeout(entry.timer);server.close();
});
