/* Local exam fixtures only. SQL authorization is tested in exams-sql.cjs. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto'),{launch}=require('./browser-driver.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'.preview','exam-screenshots');
const users={A:'00000000-0000-4000-8000-000000000001',T:'00000000-0000-4000-8000-000000000010'},records=new Map(),requests=[];
let browser,base;
const sdk=`(()=>{const ids=${JSON.stringify(users)},callbacks=[];const label=()=>localStorage.getItem('exam-test-user')||'T';const current=()=>({access_token:'test-'+label(),user:{id:ids[label()],email:label()+'@example.test',user_metadata:{full_name:label()==='T'?'Teacher':'Alice'}}});window.__testSetUser=value=>{localStorage.setItem('exam-test-user',value);callbacks.forEach(cb=>cb('SIGNED_IN',current()));};window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:current()}}),getUser:async()=>({data:{user:current().user}}),onAuthStateChange:cb=>{callbacks.push(cb);setTimeout(()=>cb('INITIAL_SESSION',current()),0);return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>({})}})};})();`;
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/config')return json(res,200,{supabaseUrl:'https://fixture.supabase.co',supabaseKey:'sb_publishable_fixture'});
  if(url.pathname==='/test-supabase.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(sdk);return;}
  if(url.pathname.startsWith('/api/')){
    const user=users[(req.headers.authorization||'').replace('Bearer test-','')],teacher=user===users.T,action=url.searchParams.get('action');
    if(!user)return json(res,401,{error:'Sign in.'});
    let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
    requests.push({method:req.method,path:url.pathname,action,body,user});
    if(url.pathname==='/api/tasks'){
      if(action==='context')return json(res,200,{user_id:user,role:teacher?'teacher':'student',batches:[{id:'25cs',label:'25CS'}],students:teacher?[{id:users.A,batch_id:'25cs',division:'A',full_name:'Alice',roll_number:'01'}]:[]});
      if(action==='settings')return json(res,200,{role:teacher?'teacher':'student',profile:{full_name:teacher?'Teacher':'Alice',class_code:'25cs',division:'A'},classes:[],membership:null});
      if(action==='notifications')return json(res,200,{notifications:[],unread_count:0});
      return json(res,200,{tasks:[],role:teacher?'teacher':'student',enrollments:[]});
    }
    if(url.pathname==='/api/focus')return json(res,200,{subjects:[],daily:[],history:[],total_seconds:0,today_seconds:0,week_seconds:0,completed_sessions:0});
    if(url.pathname==='/api/calendar'){
      if(action!=='exams')return json(res,200,{events:[]});
      if(req.method==='GET')return json(res,200,{events:[...records.values()].map(row=>({...row,can_edit:teacher}))});
      if(!teacher)return json(res,403,{error:'Teacher access required.'});
      const id=url.searchParams.get('id');
      if(req.method==='POST'){const row={...body,id:randomUUID(),user_id:user,source:'teacher_exam',can_edit:true};records.set(row.id,row);return json(res,201,{event:row});}
      if(req.method==='PATCH'){const row={...records.get(id),...body};records.set(id,row);return json(res,200,{event:row});}
      if(req.method==='DELETE'){records.delete(id);return json(res,200,{deleted:true});}
    }
    return json(res,200,{reply:'Fixture reply'});
  }
  const file=path.resolve(root,'.'+(url.pathname==='/'?'/app.html':decodeURIComponent(url.pathname)));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{let data=fs.readFileSync(file);if(path.extname(file)==='.html')data=Buffer.from(data.toString('utf8').replace('js/vendor/supabase-2.119.2/supabase.js','/test-supabase.js'));res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream'});res.end(data);}catch{res.writeHead(404);res.end();}
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  browser=await launch(output);await browser.viewport(1440,900);await browser.command('Page.navigate',{url:base+'/app.html'});
  await browser.wait('document.readyState==="complete" && !!window.MannSathiCalendar');
  await browser.evaluate('window.__testSetUser("T")');
  await browser.evaluate('window.MannSathiCalendar.assignExam()');
  await browser.wait('document.getElementById("calendar-event-dialog").open');
  assert.equal(await browser.evaluate('document.getElementById("event-category").value'),'examination');
  assert.equal(await browser.evaluate('document.getElementById("event-category").disabled'),true);
  const today=await browser.evaluate('window.MannSathiDates.dateKey()');
  await browser.fill({'event-title':'Division A exam','event-exam-audience':'division','event-exam-division':'A','event-start':today+'T09:00','event-end':today+'T11:00'});
  await browser.evaluate('document.getElementById("calendar-event-form").requestSubmit()');
  await browser.wait('!document.getElementById("calendar-event-dialog").open && document.getElementById("calendar-content").getAttribute("aria-busy")==="false"');
  const exam=[...records.values()][0];assert.equal(exam.audience,'division');assert.equal(exam.target_division,'A');assert.equal(exam.user_id,users.T);
  assert.equal(requests.find(row=>row.method==='POST'&&row.action==='exams').body.user_id,undefined);
  await browser.evaluate(`window.MannSathiCalendar.openAssignedExam(${JSON.stringify(exam)})`);
  await browser.fill({'event-title':'Revised exam'});await browser.evaluate('document.getElementById("calendar-event-form").requestSubmit()');
  await browser.wait('!document.getElementById("calendar-event-dialog").open');assert.equal(records.get(exam.id).title,'Revised exam');
  await browser.evaluate('window.__testSetUser("A")');await browser.delay(100);
  await browser.evaluate(`window.MannSathiCalendar.openAssignedExam(${JSON.stringify(exam)})`);
  await browser.wait('document.getElementById("calendar-event-dialog").open');
  assert.equal(await browser.evaluate('document.getElementById("event-title").disabled'),true);
  assert.equal(await browser.evaluate('document.getElementById("event-save").hidden'),true);
  assert.equal(await browser.evaluate('document.getElementById("event-delete").hidden'),true);
  assert.match(await browser.evaluate('document.getElementById("event-exam-note").textContent'),/teacher manages/);
  const before=requests.filter(row=>row.method==='PATCH').length;
  await browser.evaluate('document.getElementById("calendar-event-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}))');
  await browser.delay(100);assert.equal(requests.filter(row=>row.method==='PATCH').length,before);
  await browser.screenshot('student-assigned-exam');
  await browser.click('#calendar-event-dialog [data-calendar-close]');
  assert.equal(await browser.evaluate('document.getElementById("calendar-assign-exam").hidden'),true);
  for(const [width,height] of [[390,844],[320,740]]){await browser.viewport(width,height);await browser.evaluate(`window.MannSathiCalendar.openAssignedExam(${JSON.stringify(exam)})`);const widths=await browser.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,dialog:document.getElementById("calendar-event-dialog").getBoundingClientRect().width})');assert(widths.scroll<=widths.width&&widths.dialog<=widths.width);await browser.click('#calendar-event-dialog [data-calendar-close]');}
  assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
  console.log('PASS teacher creates/edits division exam, student sees read-only details, submission blocked, teacher CTA hidden for students, mobile dialogs.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.close();});
