// Admin records include student-supplied names. Render all record values as text nodes.
export const unavailable = "Not available from provider";
const quantities = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const dollars = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 });
export const number = value => value == null ? "Unavailable" : quantities.format(value);
const money = value => value == null ? "Unavailable" : dollars.format(value);
const pct = value => value == null ? "—" : number(value) + "%";
const instant = value => value ? new Date(value).toLocaleString(undefined, { timeZone: "UTC", timeZoneName: "short" }) : "—";
export function el(tag, value, className) {
    const element = document.createElement(tag);
    if (value != null) element.textContent = String(value);
    if (className) element.className = className;
    return element;
}
function group(className, ...children) {
    const container = el("div", null, className);
    container.append(...children);
    return container;
}
export const note = value => el("p", value, "admin-note");
export function button(label, callback, className = "dashboard-button") {
    const control = el("button", label, className);
    control.type = "button";
    control.addEventListener("click", callback);
    return control;
}
function box(title, ...children) {
    const section = el("section", null, "admin-box");
    section.append(el("h2", title), ...children);
    return section;
}
function facts(items, metrics = false) {
    const list = el("dl", null, metrics ? "admin-metrics" : "admin-facts");
    for (const [label, value] of items) list.append(group("", el("dt", label), el("dd", value ?? "Unavailable")));
    return list;
}
function table(labels, rows, description) {
    if (!rows.length) return note("No records match this selection.");
    const wrap = el("div", null, "admin-scroll"), t = el("table"), head = t.createTHead().insertRow();
    t.setAttribute("aria-label", description);
    for (const label of labels) {
        const th = el("th", label);
        th.scope = "col";
        head.append(th);
    }
    const body = t.createTBody();
    for (const values of rows) {
        const tr = body.insertRow();
        for (const value of values) tr.insertCell().append(value ?? "—");
    }
    wrap.tabIndex = 0;
    wrap.append(t);
    return wrap;
}
function timeline(title, rows, key, fmt = number, dateKey = "day") {
    const section = box(title);
    if (!rows.length) { section.append(note("No usage recorded in this period.")); return section; }
    const max = Math.max(0, ...rows.map(row => row[key] ?? 0));
    const chart = el("div", null, "admin-chart");
    chart.setAttribute("aria-hidden", "true");
    const index = value => {
        const date = new Date(value);
        return dateKey === "month" ? 12*date.getUTCFullYear()+date.getUTCMonth() : Math.floor(date.getTime()/86400000);
    };
    const first = index(rows[0][dateKey]), last = index(rows.at(-1)[dateKey]);
    chart.style.gridTemplateColumns = "repeat("+(last-first+1)+",minmax(1px,1fr))";
    for (const row of rows) {
        const bar = el("span");
        bar.style.gridColumn = String(index(row[dateKey])-first+1);
        bar.style.height = (max && row[key] != null ? row[key] / max * 100 : 0) + "%";
        bar.title = row[dateKey] + " · " + fmt(row[key]);
        chart.append(bar);
    }
    const details = el("details");
    details.append(el("summary", "View values"), table([dateKey === "month" ? "Month" : "Day", title], rows.map(r => [r[dateKey], fmt(r[key])]), title));
    section.append(chart, group("admin-axis", el("span", rows[0][dateKey]), el("span", first === last ? "" : rows.at(-1)[dateKey])), details);
    return section;
}
function ranking(title, rows, label, key, fmt = number) {
    const list = el("ul", null, "admin-ranks");
    if (!rows.length) return box(title, note("No usage recorded in this period."));
    const max = Math.max(0, ...rows.map(row => row[key] ?? 0));
    for (const row of rows) {
        const li = el("li"), bar = el("i");
        bar.style.width = (max ? 100 * (row[key] ?? 0) / max : 0) + "%";
        li.append(el("span", row[label] || row.user_id || "Unknown"), el("strong", fmt(row[key])), bar);
        list.append(li);
    }
    return box(title, list);
}
function pager(data, onPage) {
    const pages = Math.max(1, Math.ceil(data.total / data.page_size));
    const previous = button("Previous", () => onPage(data.page - 1)), next = button("Next", () => onPage(data.page + 1));
    previous.disabled = data.page <= 1;
    next.disabled = data.page >= pages;
    return group("admin-pager", el("span", number(data.total) + " records · Page " + data.page + " of " + pages), group("", previous, next));
}
function coverage(summary) {
    const messages = [];
    if (summary.unknown_tokens || summary.unknown_input || summary.unknown_output) messages.push("Some requests have incomplete token metadata. Totals include reported counts only.");
    if (summary.unknown_cost) messages.push(number(summary.unknown_cost) + " requests have incomplete cost data. Estimates include priced records only.");
    return messages.length ? note(messages.join(" ")) : document.createDocumentFragment();
}
function breakdown(summary) {
    return ranking("Input and output tokens", [{label:"Input", count:summary.input_tokens}, {label:"Output", count:summary.output_tokens}], "label", "count");
}
export function overview(data) {
    const s = data.summary;
    return group("", facts([["AI requests",number(s.requests)],["Total tokens",number(s.total_tokens)],["Active AI users",number(s.active_users)],["Estimated application cost",money(s.estimated_cost)],
        ["Input tokens",number(s.input_tokens)],["Output tokens",number(s.output_tokens)],["Successful requests",number(s.succeeded)],["Failed requests",number(s.failed)],["Average tokens per measured request",number(s.average_tokens)]], true),
        box("Request activity", facts([["Student tokens",number(data.student_summary?.total_tokens)+(data.student_summary?.unknown_total ? " (partial)" : "")],
            ["Student requests",number(data.student_summary?.requests)],["Guest requests",number(s.guest_requests)],["Blocked",number(s.blocked)],["Pending settlement",number(s.pending)]])),
        coverage(s), group("admin-grid",timeline("Daily tokens",data.daily,"total_tokens"),timeline("Daily requests",data.daily,"requests"),breakdown(s),
            ranking("Tokens by model",data.models,"model","total_tokens"), ranking("Top students by tokens",data.students,"name","total_tokens")));
}
export function students(data, actions) {
    const measured = (value, unknown, fmt) => fmt(value) + (value != null && unknown ? " (partial)" : "");
    return box("Student usage", table(["Student","Email","Class","Division","Requests","Input","Output","Total tokens","Estimated cost","Limit used¹","Last active (UTC)","Pilot approval","Usage policy"],data.rows.map(r => [
        button(r.name || r.email || r.user_id, () => actions.student(r.user_id), "admin-link"),r.email,r.class_code,r.division,
        number(r.requests),measured(r.input_tokens,r.unknown_input,number),measured(r.output_tokens,r.unknown_output,number),measured(r.total_tokens,r.unknown_total,number),measured(r.estimated_cost,r.unknown_cost,money),pct(r.usage_pct),instant(r.last_active),pilotApproval(r.pilot_approved),r.access_status
    ]),"Student usage"),note("¹ Highest utilization of this student’s current daily or monthly limits, including reserved capacity."),pager(data,actions.page));
}
function logTable(data, onPage) {
    const rows = data.rows.map(r => [instant(r.created_at), r.status === "pending" ? "Pending settlement" : r.status, r.error_category, r.feature, r.reported_model || r.model, number(r.input_tokens),
        number(r.output_tokens), number(r.total_tokens), r.duration_ms == null ? "—" : number(r.duration_ms) + " ms",r.user_id ?? "Guest",r.request_id, r.retry_of ?? "—"]);
    return group("",table(["Time (UTC)","Status","Error category","Feature","Model","Input","Output","Total tokens","Duration","User ID","Request ID","Retry of"],rows,"AI request history"),pager(data,onPage));
}
export function logs(data, actions) {
    return box("Request history",logTable(data,actions.page),
        data.rows.some(r => r.status === "pending") ? note("Pending requests keep their reservation until settled. An older entry can indicate an interrupted request.") : document.createDocumentFragment());
}
const field = (id, label, type = "number", extra = {}) => ({id,label,type,...extra});
const globalFields = [field("enabled","Enable AI","checkbox"),field("requests_per_minute","Requests per minute","number",{required:true}),
    field("daily_token_limit","Daily tokens","number",{required:true}),field("monthly_token_limit","Monthly tokens","number",{required:true}),
    field("warning_thresholds","Warning thresholds (%)","text",{required:true})];
const studentFields = [field("enabled","Enable student AI","checkbox"),field("daily_token_limit","Daily tokens"),field("monthly_token_limit","Monthly tokens"),
    field("request_limit","Requests per day"),field("restricted","Restrict student AI","checkbox"),field("restriction_reason","Restriction reason","text"),field("restricted_until","Restriction expires (local time)","datetime-local")];
const localDateTime = value => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset()*60000).toISOString().slice(0,16); };
function editForm(title, desc, action, fields, values, actions) {
    const form = el("form"), inputs = el("div",null,"admin-fields"), problem = note("");
    const original = new Map();
    problem.setAttribute("role","alert");
    const reason = field("audit_reason","Reason for change","text");
    for (const f of [...fields,reason]) {
        const label = el("label", f.label), input = el("input");
        input.type = f.type; input.name = f.id; input.required = !!f.required;
        if (f.type === "checkbox") { input.checked = values[f.id] === true; label.className = "admin-check"; label.prepend(input); }
        else {
            if (f.type === "number") { input.min = "0"; input.step = f.step || "1"; }
            if (f.type === "text") input.maxLength = 300;
            let value = values[f.id];
            if (f.type === "datetime-local" && value) value = localDateTime(value);
            input.value = Array.isArray(value) ? value.join(", ") : value ?? "";
            label.append(input);
        }
        original.set(f.id, f.type === "checkbox" ? input.checked : input.value);
        inputs.append(label);
    }
    const save = el("button","Save changes","primary-button"); save.type = "submit";
    form.append(inputs,problem,group("admin-form-footer",save));
    form.addEventListener("submit",async event => {
        event.preventDefault();
        if (save.disabled) return;
        const changes = {};
        for (const f of fields) {
            const input = form.elements.namedItem(f.id), raw = input.value.trim();
            if (action !== "pricing" && original.get(f.id) === (f.type === "checkbox" ? input.checked : input.value)) continue;
            let value = raw || null;
            if (f.type === "checkbox") value = input.checked;
            if (f.type === "number" && raw !== "") value = Number(raw);
            if (f.id === "warning_thresholds") {
                value = raw.split(",").map(x => Number(x.trim()));
                if (value.some((n,i) => !Number.isInteger(n) || n < 1 || n > 100 || i && n <= value[i-1])) {
                    problem.textContent = "Enter increasing whole percentages from 1 to 100, separated by commas."; return;
                }
            }
            if (f.type === "datetime-local" && raw) value = new Date(raw).toISOString();
            changes[f.id] = value;
        }
        if (!Object.keys(changes).length) { problem.textContent = "There are no changes to save."; return; }
        save.disabled = true; problem.textContent = "";
        try { await actions.save(action, changes, form.elements.namedItem(reason.id).value.trim()); }
        catch (err) { problem.textContent = err.message; }
        finally { save.disabled = false; }
    });
    return box(title,note(desc),form);
}
export function student(data, actions) {
    const r = data.student, s = data.summary;
    return group("", button("Back to students",actions.back), box(r.name || r.email || r.user_id,
        note([r.email,r.class_code,r.division].filter(Boolean).join(" · ")),facts([["User ID",r.user_id],["Pilot approval",pilotApproval(r.pilot_approved)],["Usage policy",r.access_status],["Current limit used",pct(r.usage_pct)],["Warning threshold reached",pct(r.warning_pct)],["Requests",number(s.requests)],["Reported tokens",number(s.total_tokens)],["Average per measured request",number(s.average_tokens)],["Estimated cost",money(s.estimated_cost)]])),
        coverage(s),group("admin-grid",timeline("Daily tokens",data.daily,"total_tokens"),timeline("Monthly tokens in selection",data.monthly,"total_tokens",number,"month"),breakdown(s),ranking("Tokens by model",data.models,"model","total_tokens")),
        editForm("Student AI controls","Blank limits remove the individual cap. Global limits still apply. A restriction can have an optional expiry.","student_policy",studentFields,{enabled:true,...data.policy},actions),
        box("Request history",logTable(data.logs,actions.page)));
}
export function limits(data,actions) {
    return group("",editForm("Global AI controls","Set finite limits for approved adult pilot accounts. Guest chat is closed. All periods use UTC.","global",globalFields,data.global,actions),
        box("Individual students",button("Find a student",actions.back)));
}
export function billing(data,actions) {
    const provider = data.actual_spend == null ? unavailable : money(data.actual_spend);
    const basis = data.budget_basis === "actual_provider_spend" ? "reported spend" : "application estimate";
    const budget = editForm("Monthly budget","Enter a monthly USD budget to track spending against it.","global",[field("monthly_budget","Monthly budget (USD)","number",{step:"0.01"})],{monthly_budget:data.budget},actions);
    return group("",note("Current UTC month · USD"),facts([["Configured budget",money(data.budget)],["Actual provider-reported cost",provider],["Estimated application cost",money(data.estimated_cost)],["Projected month-end estimate",money(data.projection)]],true),
        box("Budget utilization",facts([["Remaining budget (" + basis + ")",money(data.remaining_budget)],["Budget used (" + basis + ")",pct(data.budget_pct)],["Billing last synchronized",data.last_billing_update ? instant(data.last_billing_update) : unavailable],["Provider export updated through",data.billing_through ? instant(data.billing_through) : unavailable]])),
        coverage(data),group("admin-grid",timeline("Estimated cost by day",data.daily,"estimated_cost",money),ranking("Estimated cost by model",data.models,"model","estimated_cost",money),ranking("Highest estimated student costs",data.students,"name","estimated_cost",money)),
        budget);
}
function externalLink(label,href) {
    const a = el("a",label); a.href = href; a.rel = "noopener noreferrer"; a.target = "_blank"; return a;
}
export function provider(data) {
    const missing = unavailable;
    const success = data.last_success ? new Date(data.last_success).getTime() : 0;
    const failure = data.last_failure ? new Date(data.last_failure).getTime() : 0;
    const observed = !data.key_configured ? "API key missing" : !success && !failure ? "No recorded response" : failure > success ? "Latest request failed" : "Latest request succeeded";
    const metrics = data.metrics || [];
    const rows = metrics.map(r => [r.model,r.metric,r.limit_name,number(r.reported_limit),r.consumption == null ? missing : number(r.consumption),
        r.remaining == null ? missing : number(r.remaining),r.used_pct == null ? missing : pct(r.used_pct),r.remaining_pct == null ? missing : pct(r.remaining_pct),
        instant(r.window_start),instant(r.window_end),r.reset_at ? instant(r.reset_at) : missing,instant(r.synced_at)]);
    const absent = ["RPM","TPM","RPD"].filter(metric => !metrics.some(r => r.metric === metric && r.model === data.configured_model));
    const measured = rows.length ? table(["Model","Metric","Google limit name","Reported limit","Consumption","Remaining","Used","Remaining %","Window start","Observed through","Reset","Synced"],rows,"Gemini provider quota") : document.createDocumentFragment();
    const absentMetrics = absent.length ? table(["Configured model","Metric","Limit and consumption"],absent.map(metric => [data.configured_model,metric,missing]),"Unavailable Google quota metrics") : document.createDocumentFragment();
    return group("",facts([["Gemini connection evidence",observed],["Configured model",data.configured_model],["Paid project review",paidReview(data.paid_pilot_ready)],["Upstream 429s · last 24 hours",number(data.rate_limits)]],true),
        box("Provider quota",note("Google Cloud observations can arrive late. Capacity and percentages refer to the displayed observation window."),
            facts([["Google project",data.project ?? missing],["Last quota sync",data.last_sync ? instant(data.last_sync) : missing]]),
            measured, absentMetrics,
            group("admin-links",externalLink("AI Studio rate limits","https://aistudio.google.com/rate-limit"),externalLink("Cloud Quotas","https://console.cloud.google.com/iam-admin/quotas"),externalLink("Cloud Monitoring","https://console.cloud.google.com/monitoring/metrics-explorer"))),
        box("Recent provider responses",facts([["Last success",instant(data.last_success)],["Last failure",instant(data.last_failure)]]),
            table(["Time (UTC)","Model","Error category"],data.errors.map(r => [instant(r.created_at),r.model,r.error_category]),"Provider errors in the last 24 hours")));
}
function changeDetails(row) {
    const details = el("details");
    details.append(el("summary","View change"),el("pre","Previous\n"+JSON.stringify(row.previous_value,null,2)+"\nNew\n"+JSON.stringify(row.new_value,null,2)));
    return details;
}
export function settings(data,actions) {
    const {global:g,audit} = data;
    const prices = [field("model","Model ID","text",{required:true}),field("input_per_million","Input USD per million","number",{required:true,step:"any"}),field("output_per_million","Output USD per million","number",{required:true,step:"any"})];
    const pricesForm = editForm("Set model pricing","Rates apply to future requests. Enter zero only when the configured tier is free.","pricing",prices,{model:data.configured_model,...data.pricing.find(r => r.model === data.configured_model)},actions);
    const linkPrice = row => button(row.model,() => {
        for (const f of prices) pricesForm.querySelector('input[name="'+f.id+'"]').value = row[f.id];
        pricesForm.querySelector("input").focus();
    },"admin-link");
    return group("",box("AI configuration",facts([["Chat",g.enabled ? "Enabled" : "Disabled"],["Gemini model",data.configured_model],["Server API key",data.key_configured ? "Configured" : "Missing"],["Paid project review",paidReview(data.paid_pilot_ready)],["Provider monitoring",data.provider_monitoring],["Monthly budget",money(g.monthly_budget)],["Requests per minute",g.requests_per_minute ?? "Unavailable"],["Daily token limit",g.daily_token_limit ?? "Unavailable"],["Monthly token limit",g.monthly_token_limit ?? "Unavailable"]])),
        box("Model pricing",table(["Model","Input USD per million","Output USD per million"],data.pricing.map(r => [linkPrice(r),money(r.input_per_million),money(r.output_per_million)]),"Model pricing")),pricesForm,
        box("Admin activity and restrictions",button("View blocked requests",actions.blocked),table(["Time (UTC)","Action","Actor ID","Target user ID","Reason","Values"],audit.rows.map(r => [instant(r.created_at),r.action,r.admin_id ?? "Automatic",r.target_user_id,r.reason,changeDetails(r)]),"Admin audit trail"),pager(audit,actions.page)));
}
const pilotApproval = value => value == null ? "Unavailable" : value ? "Approved" : "Not approved";
const paidReview = value => value == null ? "Unavailable" : value ? "Current" : "Required";
