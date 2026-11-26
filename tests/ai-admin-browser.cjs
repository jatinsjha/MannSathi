/* Exercise the deployed markup, workspace navigation, authenticated fetch, and admin modules. */
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { launch } = require("./browser-driver.cjs");
const root = path.resolve(__dirname, "..");
const requests = [], writes = [];
const owner = "00000000-0000-4000-8000-000000000001", pupil = "00000000-0000-4000-8000-000000000002";
const secondAdmin = "00000000-0000-4000-8000-000000000003";
const stats = {requests:2,input_tokens:10,output_tokens:6,total_tokens:16,active_users:1,succeeded:1,failed:1,blocked:0,pending:0,guest_requests:0,average_tokens:16,estimated_cost:null,unknown_cost:2,unknown_tokens:1};
const student = {user_id:pupil,name:"Test <student>",email:"student@example.test",access_status:"enabled",...stats};
const global = {enabled:true,guest_token_limit:0,guest_request_limit:0,warning_thresholds:[50,75,90,100],monthly_budget:null};
const page = rows => ({rows,total:rows.length,page:1,page_size:25});
const overview = {summary:stats,student_summary:{requests:2,total_tokens:16,unknown_total:1},daily:[{day:"2026-06-01",...stats}],models:[{model:"test",...stats}],students:[student]};
const reports = {access:{admin:true},overview,students:page([student]),student:{...overview,student,policy:{enabled:true},monthly:[],logs:page([])},
    settings:{global,pricing:[],configured_model:"test",key_configured:true,provider_monitoring:"Awaiting first quota snapshot"},
    billing:{daily:[],models:[],students:[],budget:null,actual_spend:null},logs:page([]),audit:page([]),
    provider:{configured_model:"test",key_configured:true,errors:[],metrics:[],rate_limits:0}};
const mock = `let identity="${owner}", stepped=false; const hooks=[]; function session(){return {user:{id:identity},access_token:identity+(stepped?'-verified':'')};}
  window.supabaseReady=Promise.resolve({auth:{getSession:async()=>({data:{session:session()}}),onAuthStateChange(fn){hooks.push(fn);},
    mfa:{listFactors:async()=>({data:{totp:[]}}),enroll:async()=>({data:{id:"test-factor",totp:{secret:"TESTKEY"}}}),unenroll:async()=>({}),challengeAndVerify:async({code})=>{if(code!=="123456")return {error:{message:"Invalid"}};stepped=true;return {data:{}};}}
    }});
  window.switchUser=id=>{identity=id;hooks.forEach(fn=>fn('SIGNED_IN',session()));};`;
async function serve(req,res) {
    const url = new URL(req.url,"http://localhost");
    if (url.pathname === "/mock.js") { res.setHeader("Content-Type","application/javascript"); return res.end(mock); }
    if (url.pathname === "/api/admin") {
        const action = url.searchParams.get("action");
        const allowed = req.headers.authorization === "Bearer "+owner || req.headers.authorization === "Bearer "+secondAdmin+"-verified";
        requests.push([action,Object.fromEntries(url.searchParams)]);
        res.setHeader("Content-Type","application/json");
        if (req.headers.authorization === "Bearer "+secondAdmin) {res.statusCode=403;return res.end(JSON.stringify({error:"Verify your identity.",code:"mfa_required"}));}
        if (!allowed) { res.statusCode=403; return res.end(JSON.stringify({error:"Administrator access is required."})); }
        if (req.method === "POST") {
            let data=""; for await (const chunk of req) data+=chunk;
            writes.push([action,JSON.parse(data)]); return res.end('{"saved":true}');
        }
        if (action === "export") { res.setHeader("Content-Type","text/csv"); return res.end("request_id\n"); }
        return res.end(JSON.stringify(reports[action]));
    }
    const full = path.resolve(root,"."+url.pathname);
    if (!full.startsWith(root+path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {res.writeHead(404); return res.end();}
    let data = fs.readFileSync(full);
    if (url.pathname === "/app.html") {
        data=data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,"").replace(/<link[^>]+https:[^>]+>/g,"")
            .replace("</body>",'<script src="/mock.js"></script><script src="js/workspace.js"></script><script src="js/services/authenticated-api.js"></script><script type="module" src="js/modules/admin.js"></script></body>');
    }
    res.setHeader("Content-Type", {".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml"}[path.extname(full)] || "application/octet-stream");
    res.end(data);
}
const server = http.createServer((req,res)=>serve(req,res).catch(()=>{res.writeHead(500);res.end();}));
async function main() {
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const browser = await launch(path.join(root,".preview","ai-admin-browser"));
    const {evaluate,wait,click} = browser;
    const section = async name => {await evaluate(`Array.from(document.querySelectorAll('#admin-sections button')).find(b=>b.textContent===${JSON.stringify(name)}).click()`); await wait("document.querySelector('#admin-content').children.length>0");};
    try {
        await browser.viewport(1280,850);
        await browser.command("Page.navigate",{url:`http://127.0.0.1:${server.address().port}/app.html`});
        await wait("!document.querySelector('#open-admin').hidden"); await click("#open-admin");
        await wait("document.querySelector('#admin-content').innerText.includes('Daily tokens')");
        assert.equal(await evaluate("document.querySelectorAll('#admin-sections button').length"),7);
        assert(requests.some(([a,q])=>a==="overview" && q.period==="7"));
        await evaluate("const range=document.querySelector('[name=period]');range.value='custom';range.dispatchEvent(new Event('change'));const dates=range.form.elements;dates.start.value='2026-06-01';dates.end.value='2026-06-15';range.form.requestSubmit()");
        await wait("document.querySelector('#admin-content').innerText.includes('Daily tokens')");
        assert(requests.some(([a,q])=>a==="overview" && q.start==="2026-06-01" && q.end==="2026-06-15" && !q.period));
        await browser.screenshot("overview");
        await section("Students");
        await evaluate("let q=document.querySelector('[name=q]');q.value='Example';q.form.requestSubmit()");
        await wait("document.querySelector('#admin-content .admin-link') !== null");
        assert(requests.some(([a,q])=>a==="students" && q.q==="Example"));
        await click("#admin-content .admin-link"); await wait("document.querySelector('[name=restricted]')");
        await evaluate("const f=document.querySelector('[name=restricted]').form;f.elements.restricted.checked=true;f.elements.restriction_reason.value='Review';f.requestSubmit()");
        await wait("document.querySelector('#admin-status').textContent==='Changes saved.'");
        assert.equal(writes.at(-1)[1].user_id,pupil);
        await section("Request logs"); await evaluate("const f2=document.querySelector('#admin-filters form');f2.elements.status.value='failed';f2.querySelector('button:last-child').click()");
        await wait("document.querySelector('#admin-status').textContent.includes('exported')");
        assert(requests.some(([a,q])=>a==="export" && q.status==="failed"));
        await section("Usage limits"); await wait("document.querySelector('[name=requests_per_minute]').required && !document.querySelector('[name=guest_token_limit]')");
        await section("Billing"); await wait("document.querySelector('#admin-content').innerText.includes('Not available from provider')");
        await section("Settings & audit"); await wait("document.querySelector('#admin-content').innerText.includes('Admin activity')");
        await section("Gemini monitor"); await browser.viewport(390,844);
        assert(await evaluate("document.documentElement.scrollWidth<=window.innerWidth && document.querySelector('#admin-panel').scrollWidth<=document.querySelector('#admin-panel').clientWidth+1"));
        await browser.screenshot("mobile");
        await evaluate(`switchUser("${pupil}")`);
        await wait("document.querySelector('#open-admin').hidden && !document.querySelector('#admin-content').childElementCount");
        await evaluate(`switchUser("${secondAdmin}")`); await wait("!document.querySelector('#open-admin').hidden");
        await click("#open-admin"); await wait("document.querySelector('.admin-mfa button')");
        await click(".admin-mfa button");await wait("document.querySelector('.admin-mfa button')?.textContent==='Set up an authenticator'");
        await click(".admin-mfa button");await wait("document.querySelector('.admin-mfa input')");
        await evaluate("const c=document.querySelector('.admin-mfa input');c.value='000000';c.form.requestSubmit()");
        await wait("document.querySelector('.admin-mfa [role=status]').textContent.includes('failed')");
        await evaluate("c.value='123456';c.form.requestSubmit()");
        await wait("document.querySelector('#admin-content').innerText.includes('Daily tokens')");
        assert.deepEqual(browser.errors,[]);
        console.log("PASS all seven admin sections, filtered reports/export, student policy changes, account-switch privacy and mobile layout.");
    } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
