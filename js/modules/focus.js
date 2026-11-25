/* Private Pomodoros. The server owns study time; breaks never enter statistics. */
(function () {
    "use strict";
    const $ = id => document.getElementById(id), panel = $("focus-panel");
    if (!panel) return;
    const service = window.MannSathiFocusService, clock = window.MannSathiFocusClock.create();
    const defaults = { focus_minutes: 25, short_break_minutes: 5, long_break_minutes: 15, sessions_before_long: 4, auto_start: false, sound: false };
    const labels = { focus: "Focus", short_break: "Short break", long_break: "Long break" };
    let context = null, subjects = [], tasks = [], active = null, summary = null, prefs = { ...defaults };
    let mode = "focus", breakSession = null, epoch = 0, loading = false, busy = false, ready = false, pendingStart = null, editing = null, audio = null, finishing = false, finishRetryAt = 0;
    const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("mannsathi-focus") : null;
    const student = () => context?.role === "student";
    const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const key = () => "mannsathi-focus-rhythm:" + context.user_id;
    function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
    function status(text, retry = false) { $("focus-status").textContent = text; $("focus-status").classList.toggle("is-error", retry); $("focus-retry").hidden = !retry; }
    function savedRhythm() { try { return JSON.parse(localStorage.getItem(key())) || {}; } catch { return {}; } }
    function storeRhythm(value) { try { localStorage.setItem(key(), JSON.stringify(value)); } catch { /* Timer still works without browser storage. */ } }
    function saveBreak() { if (student()) storeRhythm({ ...savedRhythm(), break: breakSession, mode, subject_id: $("focus-subject").value, task_id: $("focus-task").value }); }
    function clear() {
        epoch++; context = null; subjects = []; tasks = []; active = null; summary = null; breakSession = null; pendingStart = null;
        ready = false; loading = false; busy = false; finishing = false; finishRetryAt = 0; mode = "focus"; prefs = { ...defaults };
        $("focus-subject-dialog").close(); $("focus-discard-dialog").close();
        $("focus-subject-form").reset(); preferenceFields();
        for (const id of ["focus-subject-list", "focus-history-list", "focus-insights", "focus-daily-chart", "focus-subject-chart", "focus-daily-table", "focus-subject-table"]) $(id).replaceChildren();
        for (const id of ["focus-total-hours", "focus-today-minutes", "focus-week-minutes", "focus-completed-count"]) $(id).textContent = "—";
        $("focus-subject").replaceChildren(new Option("Choose a subject", "")); $("focus-task").replaceChildren(new Option("No task selected", ""));
        $("focus-subject-error").textContent = ""; $("focus-preferences-status").textContent = "";
        $("open-focus").hidden = true; $("focus-auth").hidden = false; status("Sign in with a student account to save your study time."); renderTimer();
        if (window.MannSathiWorkspace.current === "focus") window.MannSathiWorkspace.show("chat");
    }
    function report(error) {
        if (error.status === 401 || error.status === 403) { clear(); status(error.message); return; }
        status(error.message || "Could not load your study space. Please retry.", true);
    }
    function notifyTabs() { channel?.postMessage({ user: context?.user_id }); }
    function preferenceFields() {
        for (const [id, name] of [["focus-duration", "focus_minutes"], ["focus-short-duration", "short_break_minutes"], ["focus-long-duration", "long_break_minutes"], ["focus-cycle-count", "sessions_before_long"]]) $(id).value = prefs[name];
        $("focus-auto-start").checked = prefs.auto_start; $("focus-sound").checked = prefs.sound;
    }
    function renderSelections() {
        const rhythm = student() ? savedRhythm() : {};
        const subjectId = active?.subject_id || pendingStart?.subject_id || $("focus-subject").value || rhythm.subject_id;
        $("focus-subject").replaceChildren(new Option("Choose a subject", ""));
        subjects.filter(s => !s.archived || s.id === active?.subject_id).forEach(s => $("focus-subject").add(new Option(s.name + (s.archived ? " (archived)" : ""), s.id)));
        $("focus-subject").value = subjectId;
        const taskId = active?.task_id || pendingStart?.task_id || $("focus-task").value || rhythm.task_id;
        $("focus-task").replaceChildren(new Option("No task selected", ""));
        tasks.filter(t => t.status !== "completed" || t.id === taskId).forEach(t => $("focus-task").add(new Option(t.title, t.id)));
        $("focus-task").value = taskId || "";
        if (active?.task_id && !tasks.some(t => t.id === active.task_id)) {
            $("focus-task").add(new Option("Previously linked task", active.task_id)); $("focus-task").value = active.task_id;
        }
    }
    function renderSubjects() {
        const list = $("focus-subject-list"); list.replaceChildren();
        if (!subjects.length) list.append(node("li", "Add a subject to start tracking your study time.", "focus-empty"));
        for (const subject of subjects) {
            const row = node("li", undefined, "subject-row"), details = node("div"), title = node("strong");
            const dot = node("span", undefined, "subject-color"); dot.style.backgroundColor = subject.color; title.append(dot, document.createTextNode(subject.name));
            details.append(title, node("p", subject.archived ? "Archived · history retained" : subject.weekly_goal_minutes ? "Weekly goal: " + subject.weekly_goal_minutes + " min" : "No weekly goal set"));
            const actions = node("div", undefined, "subject-actions"), edit = node("button", "Edit", "focus-button");
            edit.type = "button"; edit.dataset.focusEdit = subject.id; edit.disabled = busy || loading; actions.append(edit); row.append(details, actions); list.append(row);
        }
        renderSelections();
    }
    function breakRemaining() { return breakSession ? breakSession.paused ? breakSession.remaining : Math.max(0, (breakSession.deadline - clock.now()) / 1000) : duration(); }
    function duration() { return 60 * (mode === "focus" ? prefs.focus_minutes : mode === "short_break" ? prefs.short_break_minutes : prefs.long_break_minutes); }
    function renderTimer() {
        const live = !!active || !!breakSession, running = active?.status === "running" || breakSession && !breakSession.paused;
        const remaining = active ? clock.remaining(active) : breakRemaining(), planned = active?.planned_seconds || breakSession?.planned || duration();
        if (active) mode = "focus";
        $("focus-timer-type").textContent = labels[mode]; $("focus-timer-display").textContent = window.MannSathiFocusClock.format(remaining);
        $("focus-timer-progress").value = live ? Math.max(0, Math.min(1, 1 - remaining / planned)) : 0;
        $("focus-session-status").textContent = active ? active.subject_name + " · " + (remaining <= 0 ? "Saving your completed session…" : active.status === "paused" ? "Paused. This time does not count." : "Studying. One step at a time.") : breakSession ? (breakSession.paused ? "Break paused." : "Rest your eyes, stretch or get some water.") : "Ready when you are.";
        $("focus-start").hidden = live; $("focus-pause").hidden = !live || !running; $("focus-resume").hidden = !live || !!running; $("focus-stop").hidden = !live;
        $("focus-stop").textContent = active ? "Finish early" : "End break"; $("focus-start").textContent = mode === "focus" ? pendingStart ? "Retry start" : "Start focus" : "Start break";
        const blocked = !student() || !ready || busy || loading;
        for (const id of ["focus-start", "focus-pause", "focus-resume", "focus-stop", "focus-reset", "focus-subject-create", "focus-preferences-save"]) $(id).disabled = blocked;
        $("focus-start").disabled = blocked || mode === "focus" && !$("focus-subject").value;
        for (const id of ["focus-subject", "focus-task"]) $(id).disabled = blocked || live || !!pendingStart || mode !== "focus";
        $("focus-preferences-form").querySelectorAll("input").forEach(el => { el.disabled = blocked || live || !!pendingStart; });
        $("focus-preferences-save").disabled = blocked || live || !!pendingStart;
        panel.querySelectorAll("[data-focus-mode]").forEach(el => { el.disabled = blocked || live || !!pendingStart; el.setAttribute("aria-pressed", String(el.dataset.focusMode === mode)); });
    }
    async function load() {
        if (!student() || loading || busy) return;
        const version = epoch; loading = true; renderTimer(); panel.setAttribute("aria-busy", "true");
        try {
            const results = await Promise.allSettled([service.subjects(), service.state(), service.summary(zone()), window.MannSathiTaskService.list()]);
            if (version !== epoch) return;
            for (const result of results.slice(0, 3)) if (result.status === "rejected") throw result.reason;
            subjects = results[0].value.subjects; const state = results[1].value; summary = results[2].value;
            clock.sync(state.server_now); active = state.active; prefs = state.prefs; tasks = results[3].status === "fulfilled" ? results[3].value.tasks : [];
            if (active) { breakSession = null; mode = "focus"; if (active.id === pendingStart?.session_id) pendingStart = null; }
            ready = true; preferenceFields(); renderSubjects(); renderStats();
            status(results[3].status === "rejected" ? "Study time is up to date. Related tasks could not be loaded; retry to refresh them." : "Your saved study space is up to date.", results[3].status === "rejected");
        } catch (error) { if (version === epoch) { ready = false; report(error); } }
        finally { if (version === epoch) { loading = false; panel.setAttribute("aria-busy", "false"); renderTimer(); } }
    }
    async function sync() {
        if (!student() || !ready || busy || loading || finishing) return;
        const version = epoch, prior = active;
        loading = true;
        try {
            const state = await service.state(); if (version !== epoch) return;
            clock.sync(state.server_now); active = state.active;
            if (active) { breakSession = null; mode = "focus"; }
            else if (prior) {
                const result = state.finished?.id === prior.id ? { session: state.finished } : await service.transition(prior.id, "finish");
                if (version !== epoch) return;
                completed(result.session, false); await refreshSummary(version);
            }
            renderSelections();
        } catch (error) { if (version === epoch) report(error); }
        finally { if (version === epoch) { loading = false; renderTimer(); } }
    }
    function unlockSound() {
        if (!prefs.sound) return;
        try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume().catch(() => {}); } catch { /* Sound is optional. */ }
    }
    function chime() {
        if (!prefs.sound || !audio || audio.state !== "running") return;
        const oscillator = audio.createOscillator(), gain = audio.createGain();
        oscillator.frequency.value = 660; gain.gain.setValueAtTime(.08, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .5);
        oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + .5);
    }
    function beginBreak() { breakSession = { planned: duration(), remaining: duration(), deadline: clock.now() + duration() * 1000, paused: false, canAuto: true }; saveBreak(); }
    function completed(session, auto) {
        active = null; pendingStart = null;
        if (session.status === "completed") {
            const rhythm = savedRhythm(), newCompletion = !(rhythm.counted || []).includes(session.id);
            const cycles = (rhythm.cycles || 0) + (newCompletion ? 1 : 0);
            storeRhythm({ ...rhythm, cycles, counted: [...(rhythm.counted || []), ...(newCompletion ? [session.id] : [])].slice(-50) });
            mode = cycles % prefs.sessions_before_long === 0 ? "long_break" : "short_break";
            status("Focus complete. Your study time is saved. Take a " + labels[mode].toLowerCase() + ".");
            if (auto && !document.hidden) { chime(); if (prefs.auto_start) beginBreak(); }
        } else { mode = "focus"; status(session.status === "cancelled" ? "Session discarded. Its time is excluded from statistics." : "Your recorded study time is saved. You can come back when you are ready."); }
        saveBreak();
    }
    async function refreshSummary(version = epoch) {
        try { const data = await service.summary(zone()); if (version !== epoch) return; summary = data; renderStats(); }
        catch (error) { if (version === epoch) report(error); }
    }
    async function start() {
        if (!student() || !ready || busy || loading || active || breakSession) return;
        unlockSound();
        if (mode !== "focus") { beginBreak(); renderTimer(); return; }
        const subject = subjects.find(s => s.id === $("focus-subject").value && !s.archived);
        if (!subject && !pendingStart) { status("Choose a subject before starting."); return; }
        pendingStart ||= { session_id: crypto.randomUUID(), subject_id: subject.id, task_id: $("focus-task").value || null, planned_minutes: prefs.focus_minutes, time_zone: zone() };
        const version = epoch; busy = true; renderTimer(); status("Starting your focus session…");
        try {
            const result = await service.start(pendingStart); if (version !== epoch) return;
            clock.sync(result.server_now); pendingStart = null;
            if (["running", "paused"].includes(result.session.status)) { active = result.session; breakSession = null; mode = "focus"; status("Your focus session is running."); }
            else { completed(result.session, false); await refreshSummary(version); }
            notifyTabs();
        } catch (error) {
            if (version !== epoch) return;
            if (error.status >= 400 && error.status < 500) pendingStart = null;
            report(error);
        } finally { if (version === epoch) { busy = false; renderSelections(); renderTimer(); } }
    }
    async function change(action, natural = false) {
        if (!active || busy || loading || !student()) return;
        const version = epoch, id = active.id; busy = true; finishing = natural; renderTimer();
        try {
            const result = await service.transition(id, action); if (version !== epoch) return;
            clock.sync(result.server_now); finishRetryAt = 0;
            if (["running", "paused"].includes(result.session.status)) active = result.session;
            else { completed(result.session, natural); await refreshSummary(version); }
            $("focus-discard-dialog").close(); notifyTabs();
        } catch (error) { if (version === epoch) { finishRetryAt = performance.now() + 15000; report(error); } }
        finally { if (version === epoch) { busy = false; finishing = false; renderSelections(); renderTimer(); } }
    }
    function tick() {
        renderTimer();
        if (active?.status === "running" && clock.remaining(active) === 0 && !busy && !loading && !finishing && performance.now() >= finishRetryAt) change("finish", true);
        else if (breakSession && !breakSession.paused && breakRemaining() === 0) {
            const canAuto = breakSession.canAuto;
            breakSession = null; mode = "focus"; saveBreak(); status("Break complete. Choose your next small study step.");
            if (!document.hidden && canAuto) { chime(); if (prefs.auto_start) start(); }
        }
    }
    function openSubject(id) {
        if (busy || loading || !student()) return;
        editing = subjects.find(s => s.id === id) || null;
        $("focus-subject-form").reset(); $("focus-subject-error").textContent = "";
        $("focus-subject-dialog-title").textContent = editing ? "Edit subject" : "Add subject";
        $("focus-subject-name").value = editing?.name || ""; $("focus-subject-color").value = editing?.color || "#bda0ed";
        $("focus-subject-goal").value = editing?.weekly_goal_minutes || 0; $("focus-subject-archived").checked = !!editing?.archived;
        $("focus-subject-archived").closest("label").hidden = !editing;
        $("focus-subject-dialog").showModal(); $("focus-subject-name").focus();
    }
    async function saveSubject(event) {
        event.preventDefault(); if (busy || loading || !student() || !$("focus-subject-form").reportValidity()) return;
        const data = { name: $("focus-subject-name").value.trim(), color: $("focus-subject-color").value, weekly_goal_minutes: Number($("focus-subject-goal").value) };
        if (!data.name || data.name.length > 100 || !Number.isInteger(data.weekly_goal_minutes)) return;
        if (editing) data.archived = $("focus-subject-archived").checked;
        const version = epoch; busy = true; $("focus-subject-save").disabled = true; renderTimer();
        try {
            const result = editing ? await service.editSubject(editing.id, data) : await service.createSubject(data);
            if (version !== epoch) return;
            subjects = [...subjects.filter(s => s.id !== result.subject.id), result.subject];
            $("focus-subject-dialog").close(); renderSubjects();
            if (!active && !pendingStart && !result.subject.archived) $("focus-subject").value = result.subject.id;
            status("Subject saved."); await refreshSummary(version); notifyTabs();
        } catch (error) { if (version === epoch) { $("focus-subject-error").textContent = error.message; if ([401, 403].includes(error.status)) report(error); } }
        finally { if (version === epoch) { busy = false; $("focus-subject-save").disabled = false; renderSubjects(); renderTimer(); } }
    }
    async function savePreferences(event) {
        event.preventDefault(); if (busy || loading || active || breakSession || pendingStart || !student() || !$("focus-preferences-form").reportValidity()) return;
        const data = { focus_minutes: Number($("focus-duration").value), short_break_minutes: Number($("focus-short-duration").value), long_break_minutes: Number($("focus-long-duration").value), sessions_before_long: Number($("focus-cycle-count").value), auto_start: $("focus-auto-start").checked, sound: $("focus-sound").checked };
        const version = epoch; busy = true; renderTimer();
        try { const result = await service.savePreferences(data); if (version !== epoch) return; prefs = result.prefs; unlockSound(); $("focus-preferences-status").textContent = "Preferences saved."; notifyTabs(); }
        catch (error) { if (version === epoch) { $("focus-preferences-status").textContent = error.message; if ([401, 403].includes(error.status)) report(error); } }
        finally { if (version === epoch) { busy = false; renderTimer(); } }
    }
    const minutes = seconds => (Math.max(0, Number(seconds) || 0) / 60).toLocaleString(undefined, { maximumFractionDigits: 1 });
    function table(id, headers, rows) {
        const target = $(id), head = node("thead"), heading = node("tr"), body = node("tbody");
        headers.forEach(label => { const cell = node("th", label); cell.scope = "col"; heading.append(cell); }); head.append(heading);
        rows.forEach(values => { const row = node("tr"); values.forEach(value => row.append(node("td", String(value)))); body.append(row); });
        target.replaceChildren(head, body);
    }
    function svgNode(tag, attrs, text) {
        const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, String(value));
        if (text !== undefined) el.textContent = text; return el;
    }
    function chart(id, items, title, goals = false) {
        const target = $(id); target.replaceChildren();
        if (goals) {
            const caption = target.closest("figure").querySelector("figcaption");
            caption.textContent = "Time by subject this week";
            caption.append(node("p", "Minutes recorded · faded bars show weekly goals.", "focus-note"));
        }
        if (!items.length || !items.some(item => item.seconds > 0 || item.goal > 0)) { target.append(node("p", "Your saved study sessions will appear here.")); return; }
        const svg = svgNode("svg", { viewBox: "0 0 520 " + (goals ? 40 + items.length * 42 : 235), class: "focus-chart-svg", role: "img", "aria-labelledby": id + "-title " + id + "-desc" });
        svg.append(svgNode("title", { id: id + "-title" }, title), svgNode("desc", { id: id + "-desc" }, "Recorded study minutes. The data table below contains every value."));
        const maximum = Math.max(60, ...items.map(item => Math.max(item.seconds || 0, item.goal || 0)));
        if (goals) {
            items.forEach((item, index) => {
                const y = 20 + index * 42;
                svg.append(svgNode("text", { x: 0, y: y + 11, class: "focus-chart-label" }, item.label.length > 15 ? item.label.slice(0, 14) + "…" : item.label));
                if (item.goal) svg.append(svgNode("rect", { x: 170, y, width: 270 * item.goal / maximum, height: 17, fill: item.color || "#bda0ed", opacity: .2 }));
                const bar = svgNode("rect", { x: 170, y: y + 4, width: 270 * item.seconds / maximum, height: 9, fill: item.color || "#bda0ed", class: "focus-chart-bar" });
                bar.append(svgNode("title", {}, item.label + ": " + minutes(item.seconds) + " minutes; goal " + minutes(item.goal) + " minutes")); svg.append(bar);
                svg.append(svgNode("text", { x: 450, y: y + 11, class: "focus-chart-label" }, minutes(item.seconds)));
            });
        } else {
            svg.append(svgNode("line", { x1: 38, x2: 510, y1: 195, y2: 195, class: "focus-chart-grid" }));
            items.forEach((item, index) => {
                const width = 470 / items.length, height = 160 * item.seconds / maximum;
                const bar = svgNode("rect", { x: 40 + index * width, y: 195 - height, width: Math.max(2, width - 7), height, class: "focus-chart-bar" });
                bar.append(svgNode("title", {}, item.label + ": " + minutes(item.seconds) + " minutes")); svg.append(bar);
                if (index % 4 === 0 && index < items.length - 2 || index === items.length - 1) svg.append(svgNode("text", { x: 40 + index * width, y: 217, class: "focus-chart-label" }, item.label.slice(5)));
            });
            svg.append(svgNode("text", { x: 0, y: 25, class: "focus-chart-label" }, minutes(maximum) + "m"));
        }
        target.append(svg);
    }
    function renderStats() {
        if (!summary) return;
        $("focus-total-hours").textContent = (summary.total_seconds / 3600).toLocaleString(undefined, { maximumFractionDigits: 2 });
        $("focus-today-minutes").textContent = minutes(summary.today_seconds); $("focus-week-minutes").textContent = minutes(summary.week_seconds);
        $("focus-completed-count").textContent = String(summary.completed_sessions);
        table("focus-daily-table", ["Date", "Study minutes"], summary.daily.map(day => [day.date, minutes(day.seconds)]));
        table("focus-subject-table", ["Subject", "This week (min)", "Weekly goal (min)", "Total (min)"], summary.subjects.map(s => [s.name + (s.archived ? " (archived)" : ""), minutes(s.week_seconds), s.weekly_goal_minutes || "Unset", minutes(s.total_seconds)]));
        chart("focus-daily-chart", summary.daily.map(day => ({ label: day.date, seconds: day.seconds })), "Daily focus time, last fourteen days");
        chart("focus-subject-chart", [...summary.subjects].sort((a, b) => b.week_seconds - a.week_seconds).slice(0, 12).map(s => ({ label: s.name, color: s.color, seconds: s.week_seconds, goal: s.weekly_goal_minutes * 60 })), "Weekly subject time; faint bars show your goals. Up to twelve subjects shown.", true);
        const history = $("focus-history-list"); history.replaceChildren();
        if (!summary.history.length) history.append(node("li", "No recorded sessions yet. Your first study block can be small.", "focus-empty"));
        const statuses = { completed: "Completed", interrupted: "Finished early", cancelled: "Discarded" };
        for (const session of summary.history) {
            const item = node("li", undefined, "focus-history-item"); item.append(node("strong", session.subject_name));
            item.append(node("p", (statuses[session.status] || session.status) + " · " + minutes(session.focused_seconds) + " min · " + new Date(session.finished_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })));
            history.append(item);
        }
        const advice = [], upcoming = tasks.filter(t => t.status !== "completed" && t.due_at && Date.parse(t.due_at) <= Date.now() + 7 * 86400000).sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
        const gaps = summary.subjects.filter(s => !s.archived && s.weekly_goal_minutes > 0 && s.week_seconds < s.weekly_goal_minutes * 60).sort((a, b) => b.weekly_goal_minutes * 60 - b.week_seconds - (a.weekly_goal_minutes * 60 - a.week_seconds));
        if (upcoming.length) {
            const task = upcoming[0], related = summary.subjects.find(s => s.name.toLowerCase() === (task.subject || "").toLowerCase());
            advice.push((Date.parse(task.due_at) < Date.now() ? "Overdue: " : "Next deadline: ") + task.title + ". Try one focused block" + (related ? " in " + related.name : " on its next step") + ". Check the work itself to decide how much more study it needs.");
        }
        for (const subject of gaps.slice(0, 2)) advice.push(subject.name + " has " + Math.ceil((subject.weekly_goal_minutes * 60 - subject.week_seconds) / 60) + " minutes left toward your weekly goal. Reserve a block if that goal still fits your workload.");
        const reached = summary.subjects.filter(s => !s.archived && s.weekly_goal_minutes > 0 && s.week_seconds >= s.weekly_goal_minutes * 60);
        if (reached.length) advice.push("You reached your time goal for " + reached[0].name + ". Check your understanding with a practice question; you may be ready to give another subject some time.");
        if (!summary.total_seconds) advice.push("Start with one subject and a manageable session. Set an optional weekly goal to compare your study time with your plan.");
        advice.push("After each focus block, take a break. On difficult days, try a shorter block and one small next step.", "Recorded time shows effort, not understanding. Use practice questions, recall and feedback to decide what to revise.");
        $("focus-insights").replaceChildren(...advice.map(text => node("li", text, "focus-insight")));
    }
    function receiveContext(value) {
        if (context?.user_id !== value.user_id || context?.role !== value.role) {
            clear(); context = value;
            if (student()) {
                const rhythm = savedRhythm(); mode = Object.hasOwn(labels, rhythm.mode) ? rhythm.mode : "focus";
                if (rhythm.break && mode !== "focus" && Number.isFinite(rhythm.break.deadline) && Number.isFinite(rhythm.break.remaining) && Number.isFinite(rhythm.break.planned) && rhythm.break.planned >= 60 && rhythm.break.planned <= 7200) breakSession = { ...rhythm.break, canAuto: false };
            }
        } else context = value;
        $("open-focus").hidden = !student(); $("focus-auth").hidden = student();
        if (student()) { status("Choose Focus Room to load your subjects and saved sessions."); if (!panel.hidden) load(); }
        renderTimer();
    }
    $("open-focus").addEventListener("click", () => { if (student()) window.MannSathiWorkspace.show("focus"); });
    window.addEventListener("mannsathi:view", event => { if (event.detail === "focus") load(); });
    window.addEventListener("mannsathi:context", event => receiveContext(event.detail));
    window.addEventListener("mannsathi:session-reset", clear);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && breakSession) { breakSession.canAuto = false; saveBreak(); }
        if (!document.hidden && student()) { if (!panel.hidden) load(); else sync(); }
    });
    channel?.addEventListener("message", event => { if (student() && event.data?.user === context.user_id && !document.hidden) { if (!panel.hidden) load(); else sync(); } });
    $("focus-retry").addEventListener("click", () => { finishRetryAt = 0; if (pendingStart) start(); else load(); });
    $("focus-start").addEventListener("click", start);
    $("focus-pause").addEventListener("click", () => { if (active) change("pause"); else if (breakSession) { breakSession.remaining = breakRemaining(); breakSession.paused = true; saveBreak(); renderTimer(); } });
    $("focus-resume").addEventListener("click", () => { unlockSound(); if (active) change("resume"); else if (breakSession) { breakSession.deadline = clock.now() + breakSession.remaining * 1000; breakSession.paused = false; saveBreak(); renderTimer(); } });
    $("focus-stop").addEventListener("click", () => { if (active) change("interrupt"); else { breakSession = null; mode = "focus"; saveBreak(); renderTimer(); } });
    $("focus-reset").addEventListener("click", () => { if (active) $("focus-discard-dialog").showModal(); else if (pendingStart) status("Check the server before discarding an unconfirmed start. Use Retry start.", true); else { breakSession = null; saveBreak(); renderTimer(); } });
    $("focus-discard-confirm").addEventListener("click", () => change("cancel"));
    document.querySelectorAll("[data-focus-close]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
    panel.querySelectorAll("[data-focus-mode]").forEach(button => button.addEventListener("click", () => { if (!active && !breakSession && !pendingStart) { mode = button.dataset.focusMode; saveBreak(); renderTimer(); } }));
    $("focus-subject-create").addEventListener("click", () => openSubject());
    $("focus-subject-list").addEventListener("click", event => { const button = event.target.closest("[data-focus-edit]"); if (button) openSubject(button.dataset.focusEdit); });
    $("focus-subject").addEventListener("change", () => { saveBreak(); renderTimer(); }); $("focus-task").addEventListener("change", saveBreak);
    $("focus-subject-form").addEventListener("submit", saveSubject); $("focus-preferences-form").addEventListener("submit", savePreferences);
    clear(); if (window.MannSathiTasks?.context) receiveContext(window.MannSathiTasks.context);
    setInterval(tick, 250);
    setInterval(() => { if (!document.hidden) sync(); }, 30000);
    window.MannSathiFocus = Object.freeze({ refresh: load });
})();
