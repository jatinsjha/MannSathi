/* Local fixtures only; production study data is stored by authenticated SQL RPCs. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto'),{launch}=require('./browser-driver.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'.preview','focus-screenshots');
const users={A:'00000000-0000-4000-8000-000000000001',B:'00000000-0000-4000-8000-000000000002',T:'00000000-0000-4000-8000-000000000010'};
const subjects=new Map(),sessions=new Map(),preferences=new Map(),requests=[];
const defaultPrefs={focus_minutes:25,short_break_minutes:5,long_break_minutes:15,sessions_before_long:4,auto_start:false,sound:false};
const task={id:randomUUID(),created_by:users.A,assigned_to:users.A,audience:'personal',title:'Practice arrays',subject:'Mathematics',status:'pending',priority:'high',due_at:new Date(Date.now()+86400000).toISOString()};
let browser,base,failAction=null,ambiguousStart=false,nextStartRemaining=null,delaySubjects=0;
const sdk=`(()=>{const ids=${JSON.stringify(users)},callbacks=[];const label=()=>localStorage.getItem('focus-test-user')||'A';const current=()=>label()==='none'?null:{access_token:'test-'+label(),user:{id:ids[label()],email:label()+'@example.test',user_metadata:{full_name:'Student '+label()}}};window.__testSetUser=value=>{localStorage.setItem('focus-test-user',value||'none');callbacks.forEach(cb=>cb(value?'SIGNED_IN':'SIGNED_OUT',current()));};window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:current()}}),getUser:async()=>({data:{user:current()?.user}}),onAuthStateChange:cb=>{callbacks.push(cb);setTimeout(()=>cb('INITIAL_SESSION',current()),0);return {data:{subscription:{unsubscribe(){}}}};},signOut:async()=>{window.__testSetUser(null);return {};},resetPasswordForEmail:async()=>({})}})};})();`;
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function reconcile(row){if(row?.status==='running'&&Date.now()-row.lastStarted>=1000*(row.planned_seconds-row.focused_seconds)){row.finished_at=new Date(row.lastStarted+1000*(row.planned_seconds-row.focused_seconds)).toISOString();row.focused_seconds=row.planned_seconds;row.status='completed';row.lastStarted=null;}}
function projection(row){const subject=subjects.get(row.subject_id);return {...row,user_id:row.user_id,subject_name:subject?.name||'',color:subject?.color||'#bda0ed',remaining_seconds:row.status==='running'?Math.max(0,row.planned_seconds-row.focused_seconds-(Date.now()-row.lastStarted)/1000):row.status==='paused'?row.planned_seconds-row.focused_seconds:0,deadline_at:row.status==='running'?new Date(row.lastStarted+1000*(row.planned_seconds-row.focused_seconds)).toISOString():null};}
function active(user){const row=[...sessions.values()].find(s=>s.user_id===user&&['running','paused'].includes(s.status));reconcile(row);return row&&['running','paused'].includes(row.status)?row:null;}
function summary(user){active(user);const rows=[...sessions.values()].filter(s=>s.user_id===user&&['completed','interrupted'].includes(s.status));const total=rows.reduce((sum,s)=>sum+s.focused_seconds,0);return {total_seconds:total,today_seconds:total,week_seconds:total,completed_sessions:rows.filter(s=>s.status==='completed').length,subjects:[...subjects.values()].filter(s=>s.user_id===user).map(s=>({...s,total_seconds:rows.filter(f=>f.subject_id===s.id).reduce((sum,f)=>sum+f.focused_seconds,0),week_seconds:rows.filter(f=>f.subject_id===s.id).reduce((sum,f)=>sum+f.focused_seconds,0)})),daily:Array.from({length:14},(_,i)=>({date:new Date(Date.now()-(13-i)*86400000).toISOString().slice(0,10),seconds:i===13?total:0})),history:[...sessions.values()].filter(s=>s.user_id===user&&!['running','paused'].includes(s.status)).reverse().map(projection),server_now:new Date().toISOString()};}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/test-blank.html'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Local fixture idle page</title>');return;}
  if(url.pathname==='/api/config')return json(res,200,{supabaseUrl:'https://fixture.supabase.co',supabaseKey:'sb_publishable_fixture'});
  if(url.pathname==='/test-supabase.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(sdk);return;}
  if(url.pathname==='/api/chat')return json(res,200,{reply:'Fixture reply'});
  if(url.pathname.startsWith('/api/')) {
    const user=users[(req.headers.authorization||'').replace('Bearer test-','')];if(!user)return json(res,401,{error:'Sign in again.'});
    const action=url.searchParams.get('action'),id=url.searchParams.get('id');let body={};for await(const chunk of req)body.__raw=(body.__raw||'')+chunk;body=body.__raw?JSON.parse(body.__raw):{};
    requests.push({path:url.pathname,action,method:req.method,user,body,id});
    if(url.pathname==='/api/tasks') {
      if(action==='context')return json(res,200,{role:user===users.T?'teacher':'student',user_id:user,batches:[],students:[]});
      if(action==='list')return json(res,200,{tasks:user===users.A?[task]:[]});
      if(action==='notifications')return json(res,200,{notifications:[],unread_count:0});
      if(action==='enrollments')return json(res,200,{role:'teacher',enrollments:[]});
      if(action==='settings')return json(res,200,{role:user===users.T?'teacher':'student',profile:{full_name:'Student',roll_number:'',class_code:null,division:null},membership:null,classes:[]});
      return json(res,404,{error:'Unknown fixture route'});
    }
    if(url.pathname==='/api/calendar')return json(res,200,{events:[]});
    if(url.pathname!=='/api/focus')return json(res,404,{error:'Unknown route'});
    if(user===users.T)return json(res,403,{error:'Focus is for student accounts.'});
    if(failAction===action)return json(res,502,{error:'Fixture connection interrupted. Retry.'});
    if(action==='subjects'){if(delaySubjects)await new Promise(resolve=>setTimeout(resolve,delaySubjects));return json(res,200,{role:'student',subjects:[...subjects.values()].filter(s=>s.user_id===user)});}
    if(action==='state'){const before=[...sessions.values()].find(s=>s.user_id===user&&['running','paused'].includes(s.status)),row=active(user);return json(res,200,{active:row?projection(row):null,finished:before?.status==='completed'?projection(before):null,prefs:preferences.get(user)||defaultPrefs,server_now:new Date().toISOString()});}
    if(action==='summary')return json(res,200,summary(user));
    if(action==='prefs'){preferences.set(user,body);return json(res,200,{prefs:body});}
    if(action==='subject'){
      const prior=subjects.get(id);if(id&&prior?.user_id!==user)return json(res,404,{error:'Subject unavailable'});
      if(!/^#[a-f0-9]{6}$/.test(body.color))return json(res,400,{error:'Invalid color'});
      if(body.archived&&active(user)?.subject_id===id)return json(res,409,{error:'End the active session before archiving its subject.'});
      if([...subjects.values()].some(s=>s.user_id===user&&s.id!==id&&!s.archived&&s.name.toLowerCase()===body.name.toLowerCase()))return json(res,409,{error:'Subject name already exists.'});
      const row={id:id||randomUUID(),user_id:user,archived:false,...body};subjects.set(row.id,row);return json(res,id?200:201,{subject:row});
    }
    if(action==='start'){
      let row=sessions.get(body.session_id);
      if(!row){if(active(user))return json(res,409,{error:'A session is already active.'});const now=Date.now();row={id:body.session_id,user_id:user,subject_id:body.subject_id,task_id:body.task_id,status:'running',planned_seconds:body.planned_minutes*60,focused_seconds:0,started_at:new Date(now).toISOString(),lastStarted:now,finished_at:null};if(nextStartRemaining!==null){row.focused_seconds=row.planned_seconds-nextStartRemaining;nextStartRemaining=null;}sessions.set(row.id,row);}
      if(ambiguousStart){ambiguousStart=false;return json(res,502,{error:'The response was interrupted. Retry the same start.'});}
      reconcile(row);return json(res,201,{session:projection(row),server_now:new Date().toISOString()});
    }
    const row=sessions.get(id);if(row?.user_id!==user)return json(res,404,{error:'Session unavailable'});reconcile(row);
    if(['running','paused'].includes(row.status)){
      if(action==='finish')return json(res,409,{error:'Interval not finished yet'});
      if(action==='pause'&&row.status==='running'){row.focused_seconds+=Math.max(0,(Date.now()-row.lastStarted)/1000);row.status='paused';row.lastStarted=null;}
      if(action==='resume'&&row.status==='paused'){row.lastStarted=Date.now();row.status='running';}
      if(['interrupt','cancel'].includes(action)){if(row.status==='running')row.focused_seconds+=Math.max(0,(Date.now()-row.lastStarted)/1000);row.status=action==='cancel'?'cancelled':'interrupted';if(action==='cancel')row.focused_seconds=0;row.finished_at=new Date().toISOString();row.lastStarted=null;}
    }
    return json(res,200,{session:projection(row),server_now:new Date().toISOString()});
  }
  const file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{let data=fs.readFileSync(file);if(path.extname(file)==='.html')data=Buffer.from(data.toString('utf8').replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2','/test-supabase.js'));res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream'});res.end(data);}catch{res.writeHead(404);res.end();}
});
async function openFocus(){await browser.wait('!!window.MannSathiFocus && !document.getElementById("open-focus").hidden');await browser.click('#open-focus');await browser.wait('document.getElementById("focus-status").textContent.includes("up to date") && document.getElementById("focus-panel").getAttribute("aria-busy") === "false"');}
async function navigate(query=''){await browser.command('Page.navigate',{url:base+'/app.html'+query});await browser.wait('document.readyState === "complete" && !!window.MannSathiFocus');await browser.evaluate('document.fonts.ready');}
async function addSubject(name,goal=120){await browser.click('#focus-subject-create');await browser.fill({'focus-subject-name':name,'focus-subject-goal':goal});await browser.evaluate('document.getElementById("focus-subject-form").requestSubmit()');await browser.wait('!document.getElementById("focus-subject-dialog").open && !document.getElementById("focus-start").disabled');return [...subjects.values()].find(s=>s.name===name);}
async function setPrefs(values){await browser.fill(values);await browser.evaluate('document.getElementById("focus-preferences-form").requestSubmit()');await browser.wait('document.getElementById("focus-preferences-status").textContent === "Preferences saved." && !document.getElementById("focus-preferences-save").disabled');}
async function start(){await browser.click('#focus-start');await browser.wait('!document.getElementById("focus-pause").hidden && !document.getElementById("focus-pause").disabled');return [...sessions.values()].at(-1);}
async function end(){await browser.click('#focus-stop');await browser.wait('!document.getElementById("focus-start").hidden && !document.getElementById("focus-start").disabled');}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;browser=await launch(output);
  await browser.viewport(1440,900);await navigate();
  await browser.evaluate('for(const key of Object.keys(localStorage))if(key.startsWith("mannsathi-focus-rhythm:"))localStorage.removeItem(key);window.__testSetUser(null);window.__testSetUser("A")');await openFocus();
  assert.equal(await browser.evaluate('document.getElementById("focus-total-hours").textContent'),'0');
  assert.equal(await browser.evaluate('document.getElementById("focus-start").disabled'),true);
  const math=await addSubject('Mathematics');await setPrefs({'focus-duration':1});await browser.fill({'focus-task':task.id});
  let row=await start();assert.equal(row.subject_id,math.id);assert.equal(row.task_id,task.id);row.lastStarted-=6000;
  await browser.click('#focus-pause');await browser.wait('!document.getElementById("focus-resume").hidden && !document.getElementById("focus-resume").disabled');
  assert.equal(row.status,'paused');const paused=await browser.evaluate('document.getElementById("focus-timer-display").textContent');
  await browser.delay(1200);assert.equal(await browser.evaluate('document.getElementById("focus-timer-display").textContent'),paused);
  await browser.command('Page.reload');await browser.wait('document.readyState === "complete" && !!window.MannSathiFocus');await openFocus();
  assert.equal(await browser.evaluate('document.getElementById("focus-timer-display").textContent'),paused,'Paused session survives page reload');
  await browser.click('#focus-resume');await browser.wait('!document.getElementById("focus-pause").hidden && !document.getElementById("focus-pause").disabled');row.lastStarted-=4000;await end();
  assert.equal(row.status,'interrupted');assert(row.focused_seconds>=10&&row.focused_seconds<12);assert.equal(summary(users.A).completed_sessions,0);
  assert(await browser.evaluate('document.getElementById("focus-history-list").textContent.includes("Finished early")'));
  const before=summary(users.A).total_seconds;row=await start();row.lastStarted-=5000;
  await browser.click('#focus-reset');await browser.click('#focus-discard-confirm');await browser.wait('!document.getElementById("focus-discard-dialog").open && !document.getElementById("focus-start").disabled');
  assert.equal(row.status,'cancelled');assert.equal(summary(users.A).total_seconds,before,'Discarded time is excluded');
  ambiguousStart=true;await browser.click('#focus-start');await browser.wait('document.getElementById("focus-status").textContent.includes("interrupted") && !document.getElementById("focus-retry").hidden');
  const count=sessions.size,firstId=requests.filter(r=>r.action==='start').at(-1).body.session_id;
  await browser.click('#focus-retry');await browser.wait('!document.getElementById("focus-pause").hidden && !document.getElementById("focus-pause").disabled');
  assert.equal(sessions.size,count);assert.equal(requests.filter(r=>r.action==='start').at(-1).body.session_id,firstId,'Ambiguous starts reuse ID');await end();
  console.log('PASS subject creation, task links, prefs, pause/reload/resume, early finish, discard and ambiguous-start retry');
  await setPrefs({'focus-auto-start':true});nextStartRemaining=.8;row=await start();
  await browser.wait('document.getElementById("focus-completed-count").textContent === "1" && document.getElementById("focus-timer-type").textContent === "Short break" && !document.getElementById("focus-pause").hidden');
  assert.equal(row.status,'completed');assert.equal(row.focused_seconds,60);const afterFocus=summary(users.A).total_seconds;
  await browser.delay(800);assert.equal(summary(users.A).total_seconds,afterFocus,'Break time is excluded');
  await browser.command('Page.reload');await browser.wait('document.readyState === "complete" && !!window.MannSathiFocus');await openFocus();
  assert.equal(await browser.evaluate('document.getElementById("focus-timer-type").textContent'),'Short break','Break resumes after refresh without study backfill');
  await end();await browser.click('[data-focus-mode="focus"]');await setPrefs({'focus-auto-start':false});
  failAction='finish';nextStartRemaining=.8;row=await start();await browser.wait('document.getElementById("focus-status").textContent.includes("interrupted")');
  assert.equal(await browser.evaluate('document.getElementById("focus-completed-count").textContent'),'1','No fabricated saved stats on failed finish');
  assert.equal(await browser.evaluate('document.getElementById("focus-timer-display").textContent'),'00:00');failAction=null;
  await browser.click('#focus-retry');await browser.wait('document.getElementById("focus-completed-count").textContent === "2"');
  await browser.click('[data-focus-mode="focus"]');
  const hostile=await addSubject('<img src=x onerror="window.__focusXss=true">',0);
  assert.equal(await browser.evaluate('window.__focusXss'),undefined);assert.equal(await browser.evaluate('document.querySelectorAll("#focus-subject-list img").length'),0);
  await browser.click(`[data-focus-edit="${hostile.id}"]`);await browser.fill({'focus-subject-archived':true});await browser.evaluate('document.getElementById("focus-subject-form").requestSubmit()');await browser.wait('!document.getElementById("focus-subject-dialog").open');
  assert.equal(hostile.archived,false);assert.equal(subjects.get(hostile.id).archived,true);
  assert.equal(await browser.evaluate(`!!document.querySelector('#focus-subject option[value="${hostile.id}"]')`),false);
  assert(await browser.evaluate('document.querySelectorAll("#focus-daily-chart svg,#focus-subject-chart svg").length === 2'));
  assert(await browser.evaluate('document.getElementById("focus-insights").textContent.includes("Mathematics")'));
  console.log('PASS automatic break, no break totals, expiry retry, honest saved stats, archival, safe text and real-data charts/guidance');
  for(const [width,height] of [[1440,900],[390,844],[320,740]]){
    await browser.viewport(width,height);
    for(const theme of ['dark','light']){
      await browser.evaluate(`window.MannSathiTheme.apply(${JSON.stringify(theme)})`);
      const bounds=await browser.evaluate('(()=>{const p=document.getElementById("focus-panel"),r=document.querySelector(".app-card").getBoundingClientRect();return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,panel:p.clientWidth,panelScroll:p.scrollWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()');
      assert(bounds.scroll<=width&&bounds.panelScroll<=bounds.panel+1,'Overflow: '+JSON.stringify(bounds));assert(Math.abs(bounds.left)<1&&Math.abs(bounds.top)<1&&Math.abs(bounds.right-width)<1&&Math.abs(bounds.bottom-height)<1);
      await browser.screenshot('focus-'+theme+'-'+width);
      await browser.evaluate('document.getElementById("focus-statistics").scrollIntoView({block:"start"})');await browser.screenshot('focus-statistics-'+theme+'-'+width);
      await browser.evaluate('document.getElementById("focus-panel").scrollTop=0');
    }
    await browser.click('#focus-subject-create');const dialog=await browser.evaluate('(()=>{const d=document.getElementById("focus-subject-dialog"),r=d.getBoundingClientRect();return {left:r.left,right:r.right,scroll:d.scrollWidth,client:d.clientWidth};})()');assert(dialog.left>=0&&dialog.right<=width+1&&dialog.scroll<=dialog.client+1);await browser.screenshot('subject-dialog-'+width);await browser.click('#focus-subject-dialog [data-focus-close]');
  }
  await browser.viewport(1440,900);await browser.fill({'focus-subject':math.id});await setPrefs({'focus-cycle-count':1,'focus-auto-start':true});nextStartRemaining=.8;await start();
  await browser.wait('document.getElementById("focus-timer-type").textContent === "Long break" && !document.getElementById("focus-pause").hidden');
  const startsBeforeRecovery=requests.filter(r=>r.action==='start').length;
  await browser.command('Page.navigate',{url:base+'/test-blank.html'});await browser.wait('document.readyState === "complete" && location.pathname === "/test-blank.html"');
  await browser.evaluate(`(()=>{const key='mannsathi-focus-rhythm:${users.A}',value=JSON.parse(localStorage.getItem(key));value.break.deadline=Date.now()-10000;localStorage.setItem(key,JSON.stringify(value));})()`);
  await navigate();await openFocus();await browser.delay(800);
  assert.equal(requests.filter(r=>r.action==='start').length,startsBeforeRecovery,'Expired recovered break must not automatically start new study time');
  assert.equal(await browser.evaluate('document.getElementById("focus-timer-type").textContent'),'Focus');
  console.log('PASS configured long-break cycle and expired-break recovery without offline backfill');
  delaySubjects=500;await browser.evaluate('window.MannSathiFocus.refresh();window.__testSetUser("B")');await browser.delay(700);await openFocus();
  assert.equal(await browser.evaluate('document.getElementById("focus-subject-list").textContent.includes("Mathematics")'),false);assert.equal(await browser.evaluate('document.getElementById("focus-total-hours").textContent'),'0');
  await browser.evaluate('window.__testSetUser("T")');await browser.wait('document.getElementById("open-focus").hidden');assert.equal(await browser.evaluate('document.getElementById("focus-history-list").textContent'),'');
  await assert.rejects(()=>browser.evaluate('window.MannSathiFocusService.state()'),/student accounts/);
  await browser.evaluate('window.__testSetUser("A")');await browser.wait('!document.getElementById("open-focus").hidden');await navigate('?guest=true');
  await browser.wait('document.getElementById("open-focus").hidden');assert.equal(await browser.evaluate('document.getElementById("focus-subject-list").textContent'),'');
  assert.equal(browser.errors.length,0,'Unhandled JS errors: '+JSON.stringify(browser.errors));
  console.log('PASS responsive full-screen themes/dialogs, account-change races and teacher/guest restrictions');console.log('Focus browser checks passed. Screenshots: '+output);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.close();});
