import * as view from "./admin-views.js";

const $ = id => document.getElementById(id);
const panel = $("admin-panel"), content = $("admin-content"), entry = $("open-admin"), filters = $("admin-filters");
const sections = {overview:"AI overview",provider:"Gemini monitor",students:"Students",logs:"Request logs",limits:"Usage limits",billing:"Billing",settings:"Settings & audit"};
const dated = new Set(["overview","students","student","logs","settings"]);
const api = (action, query = {}, options = {}) => window.MannSathiAPI.request("/api/admin",{...options,query:{action,...query}});
const iso = date => date.toISOString().slice(0,10);
function period(preset) {
    const end = new Date(), start = new Date(end);
    if (preset === "month" || preset === "previous") start.setUTCDate(1);
    if (preset === "previous") { end.setUTCDate(0); start.setUTCMonth(start.getUTCMonth()-1); }
    if (preset === "7" || preset === "30") start.setUTCDate(start.getUTCDate()-Number(preset)+1);
    return {start:iso(start),end:iso(end)};
}
let active = "overview", page = 1, studentId = null, preset = "7", range = period("7");
let userId = null, authorized = false, version = 0, loadId = 0, studentFilter = {}, logFilter = {};
const isGuest = new URLSearchParams(location.search).get("guest") === "true";
const dateQuery = () => preset === "custom" ? range : {period:preset};
function status(message = "", error = false) {
    $("admin-status").textContent = message;
    $("admin-status").classList.toggle("is-error",error);
}
function denied() {
    authorized = false; entry.hidden = true; content.replaceChildren(); filters.replaceChildren();
    $("admin-sections").replaceChildren(); $("admin-refresh").hidden = true;
    content.setAttribute("aria-busy","false");
}
function reportError(error) {
    if (error.status === 401 || error.status === 403) denied();
    status(error.message,true);
}
function choose(name, newPage = 1) {
    active = name; page = newPage;
    $("admin-heading").textContent = name === "student" ? "Student details" : sections[name];
    const nav = $("admin-sections");
    nav.replaceChildren();
    for (const [key,label] of Object.entries(sections)) {
        const btn = view.button(label,() => choose(key),"");
        if (key === (name === "student" ? "students" : name)) btn.setAttribute("aria-current","page");
        nav.append(btn);
    }
    drawFilters(); load();
}
function control(form,key,label,type,value,options) {
    const wrap = view.el("label",label), input = view.el(options ? "select" : "input");
    input.name = key;
    if (options) for (const [id,text] of options) input.add(new Option(text,id));
    else { input.type = type; if (type === "date") input.required = true; else input.maxLength = 120; }
    input.value = value ?? ""; wrap.append(input); form.append(wrap);
    return wrap;
}
function drawFilters() {
    filters.replaceChildren();
    if (!dated.has(active)) return;
    const form = view.el("form",null,"admin-controls");
    const rangeSelect = control(form,"period",active === "settings" ? "Audit period (UTC)" : "Period (UTC)",null,preset,
        [["today","Today"],["7","Last 7 days"],["30","Last 30 days"],["month","This month"],["previous","Previous month"],["custom","Custom range"]]).control;
    const start = control(form,"start","From","date",range.start), end = control(form,"end","Through","date",range.end);
    const showDates = () => { start.hidden = end.hidden = rangeSelect.value !== "custom"; };
    showDates();
    if (active === "students") {
        control(form,"q","Student name or email","search",studentFilter.q);
        control(form,"class_code","Class","text",studentFilter.class_code);
        control(form,"division","Division","text",studentFilter.division);
        control(form,"status","Usage status",null,studentFilter.status,[["","All students"],["active","Active"],["idle","No activity"],["restricted","Restricted"],["warning","At warning threshold"]]);
        control(form,"sort","Sort by",null,studentFilter.sort || "tokens",[["tokens","Highest tokens"],["requests","Highest requests"],["cost","Highest estimated cost"],["recent","Recent activity"]]);
    }
    if (active === "logs") {
        control(form,"user_id","Student ID","text",logFilter.user_id);
        control(form,"model","Model","text",logFilter.model);
        control(form,"feature","Feature","text",logFilter.feature);
        control(form,"status","Outcome",null,logFilter.status,[["","All outcomes"],["success","Success"],["failed","Failed"],["blocked","Blocked"],["pending","Pending"]]);
    }
    const apply = view.el("button","Apply","dashboard-button"); apply.type = "submit"; form.append(apply);
    if (active === "logs") form.append(view.button("Export filtered CSV",async event => {
        if (!form.reportValidity()) return;
        const btn = event.currentTarget;
        const filterValues = collect();
        if (!filterValues) return;
        btn.disabled = true;
        const id = version;
        try {
            const file = await api("export",{...dateQuery(),...logFilter},{responseType:"csv"});
            if (version !== id || !authorized) return;
            const url = URL.createObjectURL(file), a = view.el("a"); a.href = url; a.download = "mannsathi-ai-requests.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
            status("Filtered request history exported.");
        } catch (e) { if (id === version) reportError(e); }
        finally { btn.disabled = false; }
    }));
    function collect() {
        const values = Object.fromEntries(new FormData(form));
        const selected = values.period === "custom" ? {start:values.start,end:values.end} : period(values.period);
        const days = (Date.parse(selected.end)-Date.parse(selected.start))/86400000;
        if (!(days >= 0 && days < 366)) { status("Choose a date range of 1 to 366 days.",true); return false; }
        preset = values.period; range = selected;
        for (const key of ["start","end","period"]) delete values[key];
        const normalized = Object.fromEntries(Object.entries(values).map(([k,v]) => [k,v.trim()]).filter(([,v]) => v));
        if (active === "students") studentFilter = normalized;
        if (active === "logs") logFilter = normalized;
        return true;
    }
    form.addEventListener("submit",e => {e.preventDefault(); if (collect()) { page=1; load(); }});
    rangeSelect.addEventListener("change",() => { showDates(); if (rangeSelect.value !== "custom") form.requestSubmit(); });
    filters.append(form);
}
const actions = {
    page(n) { page=n; load(); },
    student(id) { studentId=id; choose("student"); panel.scrollTop = 0; },
    back() { choose("students"); },
    blocked() { logFilter = {status:"blocked"}; choose("logs"); },
    async save(action,values,reason) {
        const id = version, generation = loadId;
        try {
            await api(action,{}, {method:"POST",body:{values,reason,...(action === "student_policy" ? {user_id:studentId} : {})}});
        } catch (error) {
            if (id === version && (error.status === 401 || error.status === 403)) reportError(error);
            throw error;
        }
        if (id === version && loadId === generation) await load("Changes saved.");
    }
};
async function load(message) {
    if (!authorized || panel.hidden) return;
    const id = ++loadId, paged = {page,page_size:25}, dates = dated.has(active) ? dateQuery() : {};
    content.replaceChildren(); content.setAttribute("aria-busy","true"); status("Loading…");
    try {
        let data;
        switch(active) {
            case "settings": {
                const [config,audit] = await Promise.all([api("settings"),api("audit",{...dates,...paged})]);
                data={...config,audit}; break;
            }
            case "limits": data = await api("settings"); break;
            case "student": data = await api("student",{...dates,...paged,user_id:studentId}); break;
            case "students": data = await api("students",{...dates,...paged,...studentFilter}); break;
            case "logs": data = await api("logs",{...dates,...paged,...logFilter}); break;
            default: data = await api(active,dates);
        }
        if (id !== loadId) return;
        if (preset !== "custom" && data.start && data.end) {
            range={start:data.start,end:data.end};
            const form = filters.querySelector("form");
            if (form) { form.elements.start.value=range.start; form.elements.end.value=range.end; }
        }
        content.replaceChildren(view[active](data,actions)); status([message,data.monitoring_error].filter(Boolean).join(" "),!!data.monitoring_error);
    } catch (e) {
        if (id !== loadId) return;
        reportError(e);
    } finally { if (id === loadId) content.setAttribute("aria-busy","false"); }
}
async function identity(id) {
    if (userId === id && id) return;
    userId = id; const epoch = ++version; ++loadId;
    denied(); status(); studentId = null; studentFilter = {}; logFilter = {}; active = "overview"; page = 1; preset = "7"; range = period(preset);
    if (!panel.hidden) window.MannSathiWorkspace.show("dashboard");
    if (!id || isGuest) return;
    try {
        const result = await api("access");
        if (version !== epoch || result.admin !== true) return;
        authorized = true; entry.hidden = false; $("admin-refresh").hidden = false;
        if (location.hash === "#ai-admin") window.MannSathiWorkspace.show("admin");
    } catch (e) {
        if (version === epoch && location.hash === "#ai-admin") {
            window.MannSathiWorkspace.show("admin"); status(e.message,true);
        }
    }
}
entry.addEventListener("click",() => { if (authorized) window.MannSathiWorkspace.show("admin"); });
$("admin-refresh").addEventListener("click",() => load());
window.addEventListener("mannsathi:view",e => {
    ++loadId;
    if (e.detail === "admin" && authorized) choose(active,page);
    else content.replaceChildren();
});
if (!isGuest) window.supabaseReady.then(async client => {
    let events = 0;
    client.auth.onAuthStateChange((event,session) => {
        events++;
        const nextId = session?.user?.id ?? null;
        if (nextId !== userId || event === "SIGNED_OUT") {
            // Do HTTP work outside the Supabase Auth callback lock.
            if (userId) { ++version; ++loadId; denied(); userId=null; }
            const current = events;
            setTimeout(() => { if (events === current) identity(nextId); },0);
        }
    });
    const current = events, {data} = await client.auth.getSession();
    if (current === events) await identity(data.session?.user?.id ?? null);
}).catch(() => {});
