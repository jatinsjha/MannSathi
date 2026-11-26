// Check report semantics with inert text nodes. The browser suite covers navigation and layout.
const assert = require("node:assert/strict");

class Element {
    constructor(tag) { this.tag = tag; this.nodes = []; this.style = {}; this.textContent = ""; }
    append(...nodes) { this.nodes.push(...nodes); }
    setAttribute(key,value) { this[key] = value; }
    addEventListener() {}
    insert(tag) { const child = new Element(tag); this.append(child); return child; }
    createTHead() { return this.insert("thead"); }
    createTBody() { return this.insert("tbody"); }
    insertRow() { return this.insert("tr"); }
    insertCell() { return this.insert("td"); }
    get text() { return [this.textContent,...this.nodes.map(n => n instanceof Element ? n.text : String(n))].join(" "); }
}
global.document = {createElement: tag => new Element(tag), createDocumentFragment: () => new Element("fragment")};

async function main() {
    const views = await import("../js/modules/admin-views.js");
    const health = {configured_model:"model-a",key_configured:true,errors:[],metrics:[],rate_limits:0};
    const empty = views.provider(health).text;
    for (const metric of ["RPM","TPM","RPD"]) assert(empty.includes(metric));
    assert(empty.includes("No recorded response"));
    assert(!empty.includes("0%"));
    const snapshot = {model:"model-a",metric:"TPM",limit_name:"provider limit",reported_limit:1000,consumption:120,remaining:880,
        used_pct:12,remaining_pct:88,window_start:"2026-01-02T12:00:00Z",window_end:"2026-01-02T12:01:00Z",synced_at:"2026-01-02T12:06:00Z"};
    const measured = views.provider({...health,metrics:[snapshot]}).text;
    assert(measured.includes("88%") && measured.includes("12%") && measured.includes("880"));
    const overview = views.overview({summary:{total_tokens:200,requests:12},student_summary:{requests:9,total_tokens:160,unknown_total:1},
        daily:[{day:"2026-01-02",requests:5,total_tokens:100},{day:"2026-01-05",requests:7,total_tokens:100}],models:[],students:[]});
    const totals = overview.text;
    assert(totals.includes("200") && totals.includes("160 (partial)") && totals.includes("Student requests"));
    function findChart(node) {
        if (node.className === "admin-chart") return node;
        for (const child of node.nodes || []) { const result=findChart(child); if (result) return result; }
    }
    const chart = findChart(overview);
    assert.equal(chart.style.gridTemplateColumns,"repeat(4,minmax(1px,1fr))");
    assert.deepEqual(chart.nodes.map(bar => bar.style.gridColumn),["1","4"]);
    const logs = views.logs({rows:[{status:"pending",user_id:null}],page:1,page_size:25,total:1},{page(){}}).text;
    assert(logs.includes("Pending settlement") && logs.includes("Guest") && logs.includes("interrupted"));
    console.log("PASS unavailable vs measured Google quotas, observed percentages, all-student totals, and pending request display.");
}
main().catch(error => {console.error(error);process.exitCode=1;});
