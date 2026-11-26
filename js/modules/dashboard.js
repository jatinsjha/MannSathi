/* The home overview reads saved workspace data; it never invents study progress. */
(function () {
    "use strict";
    const $ = id => document.getElementById(id), panel = $("dashboard-panel");
    if (!panel) return;
    const dates = window.MannSathiDates, toneNames = ["mint", "lilac", "cream", "rose"];
    let context = null, focus = null, tasks = null, personalExams = null, assignedExams = null;
    let epoch = 0, requestId = 0, loading = false, errors = {}, profileName = "";
    const guest = () => new URLSearchParams(location.search).get("guest") === "true";
    const teacher = () => context?.role === "teacher";
    const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const number = value => Math.max(0, Number(value) || 0);
    const minutes = value => Math.round(number(value) / 60);
    function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
    function icon(name) { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), use = document.createElementNS(svg.namespaceURI, "use"); svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true"); use.setAttribute("href", "#i-" + name); svg.append(use); return svg; }
    function navigate(view) {
        if (view === "calendar") return window.MannSathiCalendar?.show();
        const shown = window.MannSathiWorkspace?.show(view);
        if (shown && view === "tasks") window.MannSathiTasks?.refresh();
        return shown;
    }
    function complete(task) { return teacher() && task.audience !== "personal" ? number(task.recipient_count) > 0 && number(task.completed_count) === number(task.recipient_count) : task.status === "completed"; }
    function active(task) { return !complete(task) && (task.status === "in_progress" || teacher() && task.audience !== "personal" && (number(task.completed_count) > 0 || number(task.in_progress_count) > 0)); }
    function retryError(id, label, error) {
        const el = $(id); el.replaceChildren(); el.hidden = !error;
        if (!error) return;
        el.append(document.createTextNode(label + " could not be loaded. "));
        const retry = node("button", "Retry"); retry.type = "button"; retry.addEventListener("click", refresh); el.append(retry);
    }
    function empty(target, heading, copy) { const el = node("li", undefined, "dashboard-empty"); el.append(node("strong", heading), document.createTextNode(copy)); target.append(el); }
    function greeting() {
        $("dashboard-greeting").textContent = "A little progress, every day" + (profileName ? " · " + profileName : "");
        $("dashboard-heading").textContent = teacher() ? "Class overview" : "My progress";
        $("dashboard-subheading").textContent = teacher() ? "Your assignments and the exams coming up for your students" : "Your study time, goals and what's coming next";
        $("dashboard-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
        panel.classList.toggle("is-teacher", teacher());
        $("dashboard-subject-section").hidden = teacher(); $("dashboard-time-card").hidden = teacher();
        $("dashboard-assign-exam").hidden = !teacher();
        $("dashboard-goals-heading").textContent = teacher() ? "Assignment progress" : "My goals";
        $("dashboard-goals-view").dataset.dashboardView = teacher() ? "tasks" : "focus";
        $("dashboard-task-heading").lastChild.textContent = teacher() ? " tasks set" : " tasks";
        $("dashboard-task-subheading").textContent = teacher() ? "Completion across your assignments" : "A clear view of your workload";
        $("dashboard-next-heading").textContent = teacher() ? "Upcoming assignments" : "My next steps";
    }
    function renderSubjects() {
        const target = $("dashboard-subjects"); target.replaceChildren();
        const subjects = (focus?.subjects || []).filter(subject => !subject.archived);
        if (!subjects.length) {
            const card = node("div", undefined, "dashboard-subject-empty"), copy = node("div"); copy.append(icon("book"));
            copy.append(node("h3", errors.focus ? "Your study progress is unavailable" : "Your progress starts with one subject"));
            copy.append(node("p", errors.focus ? "Refresh to load your saved subjects and study time." : "Add a subject in Focus Room, set a weekly goal and watch your effort grow."));
            card.append(copy);
            if (!errors.focus) { const button = node("button", "Open Focus Room", "dashboard-button"); button.type = "button"; button.addEventListener("click", () => context?.role === "student" ? navigate("focus") : location.assign("index.html")); card.append(button); }
            target.append(card);
        }
        for (const [index, subject] of subjects.slice(0, 4).entries()) {
            const goal = number(subject.weekly_goal_minutes), studied = minutes(subject.week_seconds), progress = goal ? Math.min(100, Math.round(number(subject.week_seconds) / (goal * 60) * 100)) : 0;
            const card = node("button", undefined, "dashboard-subject tone-" + toneNames[index % 4]); card.type = "button";
            const top = node("span", undefined, "dashboard-subject-top"); top.append(icon("book"), node("small", "This week")); card.append(top, node("strong", subject.name || "Subject"));
            const ring = node("span", undefined, "dashboard-ring"); ring.style.setProperty("--dash-progress", progress); ring.append(node("span", goal ? progress + "%" : "—"));
            card.append(ring, node("span", goal ? studied + " / " + goal + " min" : studied + " min · no goal set", "dashboard-subject-note"));
            card.setAttribute("aria-label", (subject.name || "Subject") + ": " + studied + " minutes this week" + (goal ? ", " + progress + "% of your " + goal + " minute weekly time goal" : ", no weekly goal set") + ". Open Focus Room.");
            card.addEventListener("click", () => navigate("focus")); target.append(card);
        }
        retryError("dashboard-focus-error", "Study progress", errors.focus);
    }
    function renderTime() {
        $("dashboard-hours").textContent = errors.focus ? "—" : (number(focus?.total_seconds) / 3600).toLocaleString(undefined, { maximumFractionDigits: 1 });
        $("dashboard-week-time").textContent = errors.focus ? "Unavailable" : minutes(focus?.week_seconds) + " min this week";
        const today = dates.dateKey(), saved = new Map((focus?.daily || []).map(day => [day.date, number(day.seconds)]));
        const week = Array.from({ length: 7 }, (_, i) => ({ date: dates.addDays(today, i - 6), seconds: saved.get(dates.addDays(today, i - 6)) || 0 }));
        const max = Math.max(60, ...week.map(day => day.seconds)), chart = $("dashboard-time-chart"); chart.replaceChildren();
        chart.setAttribute("aria-label", errors.focus ? "Study time unavailable" : "Recorded study time over the last seven days. " + week.map(day => new Date(day.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" }) + ": " + minutes(day.seconds) + " minutes").join("; "));
        for (const day of week) {
            const col = node("div", undefined, "dashboard-chart-day"), track = node("div", undefined, "dashboard-chart-track"), bar = node("div", undefined, "dashboard-chart-bar");
            bar.style.height = (errors.focus ? 0 : day.seconds / max * 100) + "%"; track.append(bar); col.append(node("small", errors.focus ? "—" : String(minutes(day.seconds)), "dashboard-chart-value"), track, node("span", dates.parseDate(day.date).toLocaleDateString(undefined, { weekday: "short" }))); col.title = day.date + ": " + minutes(day.seconds) + " min"; chart.append(col);
        }
    }
    function renderTasks() {
        const list = tasks || [], done = list.filter(complete).length, started = list.filter(active).length, pending = list.length - done - started;
        for (const [id, value] of [["dashboard-task-total", list.length], ["dashboard-task-completed", done], ["dashboard-task-active", started], ["dashboard-task-pending", pending]]) $(id).textContent = errors.tasks ? "—" : String(value);
        const percent = list.length ? Math.round(done / list.length * 100) : 0;
        $("dashboard-task-percent").textContent = errors.tasks ? "—" : percent + "%";
        const donut = $("dashboard-task-donut"), doneAngle = list.length ? done / list.length * 360 : 0, activeAngle = doneAngle + (list.length ? started / list.length * 360 : 0);
        donut.style.background = !list.length ? "conic-gradient(var(--line) 0deg 360deg)" : "conic-gradient(var(--dash-mint) 0deg " + doneAngle + "deg, var(--dash-lilac) " + doneAngle + "deg " + activeAngle + "deg, var(--dash-cream) " + activeAngle + "deg 360deg)";
        donut.setAttribute("aria-label", errors.tasks ? "Task progress unavailable" : list.length ? done + " completed, " + started + " in progress, " + pending + " to do" : "No tasks yet");
        const target = $("dashboard-next-list"); target.replaceChildren();
        const next = list.filter(task => !complete(task)).sort((a, b) => (Date.parse(a.due_at) || Infinity) - (Date.parse(b.due_at) || Infinity)).slice(0, 3);
        if (!next.length) empty(target, errors.tasks ? "Tasks are unavailable" : list.length ? "You're all caught up" : "One small next step", errors.tasks ? "Refresh to load your current tasks." : list.length ? "Your completed work is saved in Tasks." : "Add your tasks and teacher assignments will appear here too.");
        for (const task of next) {
            const row = node("li", undefined, "dashboard-next-item"), button = node("button", undefined, "dashboard-task-action"); button.type = "button"; button.setAttribute("aria-label", "Open tasks for " + task.title); button.append(icon("arrow")); button.addEventListener("click", () => navigate("tasks"));
            const details = node("div", undefined, "dashboard-next-details"); details.append(node("strong", task.title));
            const deadline = task.due_at && Number.isFinite(Date.parse(task.due_at)) ? new Date(task.due_at).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "No deadline";
            details.append(node("p", (task.subject ? task.subject + " · " : "") + deadline + (task.audience !== "personal" ? " · Teacher assigned" : "")));
            row.append(button, details, node("span", task.due_at && Date.parse(task.due_at) < Date.now() ? "Overdue" : active(task) ? "In progress" : "To do", "dashboard-next-badge")); target.append(row);
        }
        retryError("dashboard-tasks-error", "Tasks", errors.tasks);
    }
    function renderGoals() {
        const target = $("dashboard-goals-list"); target.replaceChildren();
        const items = teacher() ? (tasks || []).filter(task => task.audience !== "personal").slice(0, 4).map(task => ({ name: task.title, note: number(task.completed_count) + " / " + number(task.recipient_count) + " students completed", value: number(task.recipient_count) ? Math.min(100, Math.round(number(task.completed_count) / number(task.recipient_count) * 100)) : 0, date: task.due_at, task: true })) : (focus?.subjects || []).filter(subject => !subject.archived && number(subject.weekly_goal_minutes) > 0).slice(0, 4).map(subject => ({ name: subject.name, note: minutes(subject.week_seconds) + " / " + number(subject.weekly_goal_minutes) + " min this week", value: Math.min(100, Math.round(number(subject.week_seconds) / (number(subject.weekly_goal_minutes) * 60) * 100)), task: false }));
        if (!items.length) empty(target, teacher() ? "Assignment progress lives here" : "Give your week a little direction", teacher() ? "Set an assignment in Tasks to see student completion." : "Set a weekly time goal for a subject in Focus Room.");
        for (const item of items) {
            const row = node("li", undefined, "dashboard-goal"), stamp = node("span", undefined, "dashboard-goal-date"), date = item.date && Number.isFinite(Date.parse(item.date)) ? new Date(item.date) : null;
            stamp.append(date ? node("strong", String(date.getDate())) : icon(item.task ? "list" : "book"), node("small", date ? date.toLocaleDateString(undefined, { month: "short" }) : item.task ? "Task" : "Week"));
            const details = node("div", undefined, "dashboard-goal-details"), progress = node("div", undefined, "dashboard-goal-progress"), bar = node("progress"); bar.max = 100; bar.value = item.value; bar.setAttribute("aria-label", item.name + ": " + item.note); progress.append(bar, node("span", item.value + "%"));
            details.append(node("strong", item.name), node("p", item.note), progress); row.append(stamp, details); target.append(row);
        }
    }
    function renderExams() {
        const end = Date.now(), target = $("dashboard-exams-list"); target.replaceChildren();
        const exams = [...(personalExams || []).filter(event => event.category === "examination"), ...(assignedExams || [])].filter(event => { try { return dates.bounds(event)[1] > end; } catch { return false; } }).sort((a, b) => dates.bounds(a)[0] - dates.bounds(b)[0]).slice(0, 4);
        $("dashboard-exams-empty").hidden = exams.length > 0;
        $("dashboard-exams-empty-title").textContent = errors.calendar || errors.exams ? "Your exam schedule is unavailable" : "No upcoming exams yet";
        $("dashboard-exams-empty-copy").textContent = errors.calendar || errors.exams ? "Refresh to check your upcoming exams. Your saved schedule is kept in Calendar." : teacher() ? "Schedule exams for your class or division. They will appear in your students' calendars." : "Exams added by you or assigned by your teacher will appear here.";
        for (const event of exams) {
            const row = node("li", undefined, "dashboard-exam"), top = node("div", undefined, "dashboard-exam-top");
            const day = event.all_day ? dates.parseDate(event.start_date) : new Date(event.starts_at), time = event.all_day ? "All day" : day.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
            top.append(icon("calendar"), node("span", day.toLocaleDateString(undefined, { day: "numeric", month: "short", weekday: "short" }) + " · " + time));
            row.append(top, node("strong", event.title || "Examination"));
            const notes = [event.source === "teacher_exam" ? teacher() ? "Assigned to " + (event.target_division ? "division " + event.target_division : event.audience === "student" ? "one student" : "your class") : "Assigned by your teacher" : "Your calendar", event.location].filter(Boolean);
            row.append(node("p", notes.join(" · "))); target.append(row);
        }
        retryError("dashboard-calendar-error", "Personal calendar", errors.calendar); retryError("dashboard-exams-error", "Teacher exams", errors.exams);
    }
    function render() { greeting(); renderSubjects(); renderTime(); renderTasks(); renderGoals(); renderExams(); }
    function clear(message = "Sign in to see your saved progress, assignments and exams.") {
        epoch++; requestId++; context = null; focus = null; tasks = null; personalExams = null; assignedExams = null; loading = false; errors = {}; profileName = "";
        panel.setAttribute("aria-busy", "false"); $("dashboard-refresh").disabled = false; $("dashboard-signin").hidden = false;
        $("dashboard-status").textContent = message; render();
    }
    async function load() {
        if (!context || loading || guest()) return;
        const version = epoch, current = ++requestId; loading = true; panel.setAttribute("aria-busy", "true"); $("dashboard-refresh").disabled = true;
        $("dashboard-status").textContent = "Refreshing your overview…"; $("dashboard-signin").hidden = true;
        const start = dates.dateKey(), end = dates.addDays(start, 30), service = window.MannSathiCalendarService;
        const names = ["focus", "tasks", "calendar", "exams"], promises = [teacher() ? Promise.resolve(null) : Promise.all([window.MannSathiFocusService.subjects(), window.MannSathiFocusService.summary(zone())]).then(([subjects, summary]) => ({ ...summary, subjects: subjects.subjects.map(subject => ({ ...subject, ...(summary.subjects || []).find(item => item.id === subject.id) })) })), window.MannSathiTaskService.list().then(result => result.tasks), service.list(start, end, zone()), typeof service.listExams === "function" ? service.listExams(start, end, zone()) : Promise.reject(new Error("Assigned exams are unavailable."))];
        try {
            const results = await Promise.allSettled(promises);
            if (version !== epoch || current !== requestId) return;
            const unauthorized = results.find(result => result.status === "rejected" && result.reason?.status === 401);
            if (unauthorized) { clear("Please sign in again to load your saved overview."); return; }
            errors = {}; const values = results.map((result, i) => { if (result.status === "fulfilled") return result.value; errors[names[i]] = result.reason; return null; });
            [focus, tasks, personalExams, assignedExams] = values; render();
            $("dashboard-status").textContent = Object.keys(errors).length ? "Some parts of your overview could not be refreshed. Retry below." : "Your saved overview is up to date. Exams shown for the next 30 days.";
        } catch (error) { if (version === epoch && current === requestId) $("dashboard-status").textContent = error.message || "Your overview could not be loaded. Please refresh."; }
        finally { if (version === epoch && current === requestId) { loading = false; panel.setAttribute("aria-busy", "false"); $("dashboard-refresh").disabled = false; } }
    }
    function receiveContext(value) {
        if (!["student", "teacher"].includes(value?.role) || !value?.user_id || guest()) return;
        const changed = context?.user_id !== value.user_id || context?.role !== value.role;
        if (changed) clear("Loading your overview…"); context = value; $("dashboard-signin").hidden = true; render();
        if (!panel.hidden) load();
    }
    async function refresh() {
        if (guest()) { clear(); return; }
        if (context) { await load(); return; }
        const version = epoch, current = ++requestId; $("dashboard-status").textContent = "Loading your overview…";
        try { const value = await window.MannSathiTaskService.context(); if (version !== epoch || current !== requestId) return; receiveContext(value); }
        catch (error) { if (version === epoch && current === requestId) { clear(error.status === 401 ? "Sign in to see your saved progress, assignments and exams." : "Your overview could not be loaded. Use Refresh to try again."); $("dashboard-signin").hidden = error.status !== 401; } }
    }
    document.querySelectorAll("[data-dashboard-view]").forEach(button => button.addEventListener("click", () => { const view = button.dataset.dashboardView; if (view === "focus" && context?.role !== "student") { location.assign("index.html"); return; } navigate(view); }));
    $("dashboard-refresh").addEventListener("click", refresh);
    $("dashboard-assign-exam").addEventListener("click", () => { if (!teacher()) return; window.MannSathiCalendar?.assignExam(); });
    window.addEventListener("mannsathi:view", event => { if (event.detail === "dashboard") refresh(); });
    window.addEventListener("mannsathi:context", event => receiveContext(event.detail));
    window.addEventListener("mannsathi:session-reset", () => clear());
    window.addEventListener("mannsathi:profile", event => { if (context && typeof event.detail?.full_name === "string") { profileName = event.detail.full_name; greeting(); } });
    for (const name of ["mannsathi:calendar-changed", "mannsathi:tasks-changed", "mannsathi:focus-changed"]) document.addEventListener(name, () => { if (!panel.hidden) refresh(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && !panel.hidden) refresh(); });
    if (window.supabaseReady) window.supabaseReady.then(client => {
        let lastUser = null;
        client.auth.onAuthStateChange((event, session) => { const user = session?.user?.id || null; if (user !== lastUser || event === "SIGNED_OUT") { lastUser = user; clear(user ? "Loading your overview…" : undefined); if (user && !panel.hidden) setTimeout(refresh, 0); } });
    }).catch(() => {});
    window.MannSathiDashboard = Object.freeze({ refresh });
    clear(guest() ? undefined : "Loading your overview…");
    if (window.MannSathiTasks?.context) receiveContext(window.MannSathiTasks.context); else if (!panel.hidden && !guest()) refresh();
})();
