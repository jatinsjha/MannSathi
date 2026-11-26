// Real browser SDK against a disposable, loopback-only email/auth fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const {randomUUID} = require("node:crypto");
const {launch} = require("./browser-driver.cjs");
const root = path.resolve(__dirname, "..");
const user = {id:randomUUID(),email:"member@example.test",aud:"authenticated",role:"authenticated",app_metadata:{},user_metadata:{},identities:[]};
const changes = [], letters = new Map();
let base;
async function serve(req,res) {
    const url=new URL(req.url,base), p=url.pathname;
    const json=(status,body)=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify(body));};
    if (p==="/api/config") return json(200,{supabaseUrl:base,supabaseKey:"sb_publishable_test_fixture"});
    if (p.startsWith("/auth/v1/")) {
        let raw="";for await (const chunk of req) raw+=chunk;
        const body=raw?JSON.parse(raw):{};
        if(p==="/auth/v1/recover") {
            const emailLink=new URL(url.searchParams.get("redirect_to")), hash=randomUUID();
            assert.equal(emailLink.origin,base);emailLink.hash=new URLSearchParams({type:"recovery",token_hash:hash});
            letters.set(hash,{link:emailLink.href,used:false});return json(200,{});
        }
        if(p==="/auth/v1/verify") {
            const letter=letters.get(body.token_hash);
            if(!letter || letter.used || body.type!=="recovery") return json(403,{code:"otp_expired",message:"Expired test link"});
            letter.used=true;
            return json(200,{access_token:"local-test-access",refresh_token:"local-test-refresh",expires_in:3600,token_type:"bearer",user});
        }
        if(p==="/auth/v1/user" && req.headers.authorization==="Bearer local-test-access") {
            if(req.method==="PUT") changes.push(body.password);
            return json(200,user);
        }
        if(p==="/auth/v1/logout") return json(200,{});
        return json(404,{message:"Unknown fixture operation"});
    }
    const file=path.resolve(root,"."+p);
    if(!/^\/(?:index\.html|teacher-login\.html|recover\.html|(?:images|css|js)\/[a-zA-Z0-9._/-]+)$/.test(p) ||
        !file.startsWith(root+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(404,{});
    const mime={".html":"text/html; charset=utf-8",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png"};
    res.writeHead(200,{"Content-Type":mime[path.extname(file)],"Content-Security-Policy":"default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'"});
    res.end(fs.readFileSync(file));
}
(async()=>{
    const server=http.createServer((req,res)=>serve(req,res).catch(e=>{console.error(e.message);res.writeHead(500);res.end();}));
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));base="http://127.0.0.1:"+server.address().port;
    let b;
    try {
        b=await launch(path.join(root,".preview/password-recovery-browser"));
        const go=url=>b.command("Page.navigate",{url});
        for (const [i,role] of ["student","teacher"].entries()) {
            await b.viewport(i?390:1280,i?844:800);
            const login=role==="teacher"?"teacher-login.html":"index.html";
            await go(base+"/"+login);await b.wait('typeof window.supabaseClient?.auth?.resetPasswordForEmail==="function"');
            await b.fill({email:user.email});await b.click("#forgot-password");
            await b.wait('document.querySelector("#form-message").textContent.includes("check your inbox")');
            let link=[...letters.values()].at(-1).link;
            assert.equal(new URL(link).searchParams.get("role"),i?"teacher":null);
            await go(link);await b.wait('document.querySelector("#verify-recovery")?.hidden===false');
            assert.equal(await b.evaluate("location.hash"),"");
            await b.click("#verify-recovery");await b.wait('!document.querySelector("#new-password-form").hidden');
            const newPassword="local-fixture-password-"+role;
            await b.fill({"new-password":newPassword,"confirm-new-password":newPassword});await b.click("#save-password");
            await b.wait('!document.querySelector("#completed-login").hidden');
            assert.equal(changes.at(-1),newPassword);
            assert.equal(await b.evaluate('document.querySelector("#completed-login").getAttribute("href")'),login+"?recovered=1");
            assert.ok(await b.evaluate('!Object.keys(localStorage).some(key=>key.startsWith("sb-") || key==="mannsathi-password-recovery")'));
            if (i) await b.screenshot("teacher-password-updated");
            await go(base+"/"+login+"?recovered=1");await go(link);await b.wait('document.querySelector("#verify-recovery")?.hidden===false');
            await b.click("#verify-recovery");await b.wait('!document.querySelector("#request-recovery-form").hidden');
            assert.match(await b.evaluate('document.querySelector("#recovery-detail").textContent'),/expired|used/);
        }
        console.log("PASS student and teacher recovery with the pinned browser SDK, email callback, confirmed password update, isolated session and used-link handling.");
    } finally {if(b) await b.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
