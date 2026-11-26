const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {launch} = require("./browser-driver.cjs");
const submissions=[];
const root=path.resolve(__dirname,"..");
const dirs=["app.html","help.html","js/","css/","images/"];
async function serve(req,res) {
    const url=new URL(req.url,"http://localhost");
    function json(code,body) {res.writeHead(code,{"Content-Type":"application/json"});res.end(JSON.stringify(body));}
    if(url.pathname==="/api/support") {
        let raw="";for await(const data of req) raw+=data;
        const body=JSON.parse(raw);submissions.push(body);
        if(submissions.length===1) return json(503,{error:"Delivery could not be confirmed."});
        return json(201,{reference:body.request_id});
    }
    if(url.pathname==="/api/config") return json(503,{error:"Auth disabled in guest fixture"});
    if(url.pathname.startsWith("/api/")) return json(200,{available:false});
    const rel=url.pathname.slice(1), file=path.resolve(root,rel);
    if(!dirs.some(d=>d.endsWith("/")?rel.startsWith(d):rel===d)||!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()) return json(404,{});
    const mime={".html":"text/html; charset=utf-8",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png"};
    res.writeHead(200,{"Content-Type":mime[path.extname(file)],"Content-Security-Policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"});
    res.end(fs.readFileSync(file));
}
const topics=["help-center","privacy-center","release-notes","download-apps","keyboard-shortcuts","terms","privacy-policy","report-a-bug"];
(async()=>{
    const server=http.createServer((req,res)=>serve(req,res).catch(()=>{res.writeHead(500);res.end();}));
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));let b;
    try {
        b=await launch(path.join(root,".preview/help-browser"));
        const base="http://127.0.0.1:"+server.address().port;
        const go=url=>b.command("Page.navigate",{url:base+url});
        const press=(key,code,modifiers=0)=>b.command("Input.dispatchKeyEvent",{type:"keyDown",key,code,modifiers});
        const activeMenu=async mobile=>{
            if(mobile) await b.click("#mobile-menu");
            await b.click("#user-profile-card");await b.click("#account-help");
            await b.wait('!document.querySelector("#help-menu").hidden');
        };
        await b.viewport(1280,820);await go("/app.html?guest=true");await b.wait('typeof openDialog==="function" && document.readyState==="complete"');
        for(const topic of topics) {
            await activeMenu(false);
            assert.equal(await b.evaluate('document.querySelectorAll("#help-menu a").length'),8);
            if(topic==="help-center") {
                await b.screenshot("help-desktop");
                assert.ok(await b.evaluate('document.querySelector("#help-menu").getBoundingClientRect().left>=document.querySelector("#account-menu").getBoundingClientRect().right'));
                await press("Escape","Escape");await b.wait('document.activeElement.id==="account-help"');await press("ArrowRight","ArrowRight");
            }
            await b.click('#help-menu [data-help-topic="'+topic+'"]');
            await b.wait('document.querySelector("#help-dialog").open && document.querySelector("#help-content").children.length>0');
            if(topic==="download-apps") {
                assert.match(await b.evaluate('document.querySelector("#help-content").innerText'),/Coming soon/);
                assert.equal(await b.evaluate('getComputedStyle(document.querySelector("#help-dialog")).backgroundColor'),"rgb(16, 16, 16)");
                await b.screenshot("download-coming-soon");
            }
            if(topic==="report-a-bug") {
                await b.fill({"bug-detail":"My test calendar could not refresh."});
                await b.click("#help-content button[type=submit]");
                await b.wait('document.querySelector("#help-content [role=status]").textContent.includes("Retry")');
                assert.equal(await b.evaluate('document.querySelector("#bug-detail").value'),"My test calendar could not refresh.");
                await b.click("#help-content button[type=submit]");
                await b.wait('document.querySelector("#help-content [role=status]").textContent.includes("Received")');
                assert.equal(submissions.length,2); assert.deepEqual(submissions[0],submissions[1]);
            }
            await b.click("#help-dialog [data-close-dialog]");
        }
        await b.viewport(320,640);await activeMenu(true);
        await b.wait('(()=>{const r=document.querySelector("#help-menu").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()');
        await b.screenshot("help-mobile");await b.click('#help-menu [data-help-topic="privacy-center"]');
        await b.wait('document.querySelector("#help-content [data-chat-controls]")');await b.click("#help-content [data-chat-controls]");
        await b.wait('document.querySelector("#settings-dialog").open');await b.click("#settings-dialog [data-close-dialog]");
        await press("/","Slash",2);await b.wait('document.querySelector("#help-dialog").open && document.querySelector("#help-content .help-keys")');
        await go("/help.html#privacy-policy");await b.wait('document.querySelector(".help-index [aria-current=page]")?.dataset.helpTopic==="privacy-policy"');
        await b.click('.help-index [data-help-topic="privacy-center"]');await b.wait('!document.querySelector("#privacy-center").hidden');
        await b.fill({"privacy-email":"test@example.test","privacy-detail":"Please correct my test account details."});
        await b.click("#privacy-center button[type=submit]");await b.wait('document.querySelector("#privacy-center [role=status]").textContent.includes("Received")');
        assert.equal(submissions.at(-1).kind,"privacy");
        assert.ok(await b.evaluate('document.documentElement.scrollWidth<=innerWidth'));
        console.log("PASS all eight Help topics, private forms, 320px layout, submenu keyboard navigation, shortcuts and chat-history settings.");
    } finally {if(b) await b.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
