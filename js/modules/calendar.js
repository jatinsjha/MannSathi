/* Smart Calendar is independent of chat and Gemini. Supabase is the source of truth. */
(function () {
    "use strict";
    const dates = window.MannSathiDates;
    const service = window.MannSathiCalendarService;
    const $ = id => document.getElementById(id);
    const panel = $("calendar-panel");
    if (!panel) return;
    const categories = { lecture: "Lecture", assignment: "Assignment", examination: "Examination", practical: "Practical", personal: "Personal", study_session: "Study Session", college_event: "College Event", other: "Other" };
    let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    let selected = dates.dateKey(), view = "month", events = [], editing = null;
    let generation = 0, saving = false, loading = false, ready = false;
    const formatter = options => new Intl.DateTimeFormat(undefined, options);
    const formatDate = key => formatter({ year: "numeric", month: "short", day: "numeric" }).format(dates.parseDate(key));
    const formatTime = instant => formatter({ hour: "numeric", minute: "2-digit" }).format(new Date(instant));
    const dialog = $("calendar-event-dialog"), eventForm = $("calendar-event-form");
    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }
    function status(message, retry = false) {
        // Keep the retry control independent of live status text.
        let label = $("calendar-status-text");
        if (!label) { label = node("span", "", ""); label.id = "calendar-status-text"; $("calendar-status").prepend(label); }
        label.textContent = message;
        $("calendar-retry").hidden = !retry;
    }
    function setEnabled(value) {
        $("calendar-create").disabled = !value || loading;
        ready = value;
    }
    function clearPrivateData() {
        generation++;
        events = [];
        setEnabled(false);
        $("calendar-grid").replaceChildren();
        $("calendar-today-list").replaceChildren();
        $("calendar-upcoming-list").replaceChildren();
        dialog.close();
        $("calendar-delete-dialog").close();
    }
    function showCalendar() {
        if (typeof canNavigate === "function" && !canNavigate()) return;
        panel.hidden = false;
        $("chat-area").hidden = true;
        document.querySelector(".composer-wrap").hidden = true;
        $("conversation-title").hidden = true;
        $("open-calendar").setAttribute("aria-current", "page");
        $("open-chat").removeAttribute("aria-current");
        document.querySelector(".skip-link").href = "#calendar-create";
        document.querySelector(".skip-link").textContent = "Skip to calendar";
        if (typeof closeSidebar === "function") closeSidebar();
        load();
    }
    function showChat() {
        panel.hidden = true;
        $("chat-area").hidden = false;
        document.querySelector(".composer-wrap").hidden = false;
        $("conversation-title").hidden = false;
        $("open-chat").setAttribute("aria-current", "page");
        $("open-calendar").removeAttribute("aria-current");
        document.querySelector(".skip-link").href = "#message-input";
        document.querySelector(".skip-link").textContent = "Skip to chat";
        if (typeof closeSidebar === "function") closeSidebar();
    }
    async function load() {
        const current = ++generation;
        const range = dates.range(selected, view);
        const today = dates.dateKey();
        loading = true;
        setEnabled(false);
        $("calendar-content").setAttribute("aria-busy", "true");
        $("calendar-auth").hidden = true;
        events = [];
        render();
        status("Loading your calendar…");
        try {
            const results = await Promise.all([
                service.list(range.start, range.end, timeZone),
                service.list(today, dates.addDays(today, 31), timeZone)
            ]);
            if (current !== generation) return;
            events = [...new Map(results.flat().map(event => [event.id, event])).values()];
            setEnabled(true);
            render();
            status(events.length ? "Calendar is up to date." : "No events yet. Create your first event.");
        } catch (error) {
            if (current !== generation) return;
            events = [];
            render();
            $("calendar-auth").hidden = error.status !== 401;
            status(error.message || "Could not load your calendar.", error.status !== 401);
        } finally {
            if (current === generation) {
                loading = false;
                $("calendar-create").disabled = !ready;
                $("calendar-content").setAttribute("aria-busy", "false");
            }
        }
    }
    function eventLabel(event, key, compact) {
        if (event.all_day) {
            if (compact) return "All day";
            const lastDay = dates.addDays(event.end_date, -1);
            return `All day · ${formatDate(event.start_date)}${lastDay === event.start_date ? "" : ` – ${formatDate(lastDay)}`}`;
        }
        if (compact) return dates.dateKey(new Date(event.starts_at)) < key ? "Continues" : formatTime(event.starts_at);
        return `${formatDate(dates.dateKey(new Date(event.starts_at)))} ${formatTime(event.starts_at)} – ${formatDate(dates.dateKey(new Date(event.ends_at)))} ${formatTime(event.ends_at)}`;
    }
    function eventButton(event, key, compact = false) {
        const conflict = events.some(other => other.id !== event.id && dates.overlaps(event, other));
        const button = node("button", "calendar-event" + (conflict ? " is-overlapping" : ""));
        button.type = "button";
        button.dataset.eventId = event.id;
        button.append(node("span", "calendar-event-time", eventLabel(event, key, compact)), node("span", "calendar-event-title", event.title));
        if (!compact) {
            const details = [categories[event.category] || "Other", event.location, conflict ? "Overlaps another event" : ""].filter(Boolean);
            button.append(node("span", "calendar-event-meta", details.join(" · ")));
        }
        button.title = `${event.title} · ${eventLabel(event, key, false)}${conflict ? " · Overlaps another event" : ""}`;
        button.addEventListener("click", () => openEvent(event));
        return button;
    }
    function renderList(target, list, empty, key = dates.dateKey()) {
        target.replaceChildren();
        if (!list.length) { target.append(node("li", "calendar-empty", empty)); return; }
        dates.sortEvents(list).forEach(event => {
            const item = node("li"); item.append(eventButton(event, key)); target.append(item);
        });
    }
    function render() {
        const range = dates.range(selected, view), grid = $("calendar-grid");
        grid.replaceChildren();
        grid.className = view === "month" ? "calendar-month" : view === "week" ? "calendar-week" : "calendar-day-view";
        $("calendar-time-zone").textContent = `Times shown in ${timeZone.replaceAll("_", " ")}`;
        $("calendar-period-label").textContent = view === "month"
            ? formatter({ month: "long", year: "numeric" }).format(dates.parseDate(selected))
            : view === "week" ? `${formatDate(range.start)} – ${formatDate(dates.addDays(range.end, -1))}` : formatDate(selected);
        document.querySelectorAll("[data-calendar-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.calendarView === view)));
        if (view === "month") {
            for (let i = 0; i < 7; i++) grid.append(node("div", "calendar-weekday", formatter({ weekday: "short" }).format(dates.parseDate(dates.addDays("2026-01-05", i)))));
        }
        for (let key = range.start; key < range.end; key = dates.addDays(key, 1)) {
            const dayEvents = dates.sortEvents(events.filter(event => dates.onDay(event, key)));
            const today = key === dates.dateKey();
            const cell = node("section", view === "month" ? "calendar-day" + (key.slice(0, 7) !== selected.slice(0, 7) ? " is-other-month" : "") + (today ? " is-today" : "") : "calendar-agenda-day" + (today ? " is-today" : ""));
            const day = node("button", view === "month" ? "calendar-day-number" : "calendar-agenda-heading", view === "month" ? String(dates.parseDate(key).getDate()) : formatter({ weekday: "short", month: "short", day: "numeric" }).format(dates.parseDate(key)));
            day.type = "button";
            day.setAttribute("aria-label", `Create event on ${formatDate(key)}`);
            day.addEventListener("click", () => { if (ready && !loading) openEvent(null, key); });
            cell.append(day);
            const list = node("div", view === "month" ? "calendar-day-events" : "calendar-event-list");
            dayEvents.forEach(event => list.append(eventButton(event, key, view === "month")));
            if (!dayEvents.length && view !== "month") list.append(node("p", "calendar-empty", "No events"));
            cell.append(list); grid.append(cell);
        }
        renderList($("calendar-today-list"), events.filter(event => dates.onDay(event, dates.dateKey())), "No events today.");
        const now = Date.now(), today = dates.dateKey(), end = dates.addDays(today, 31);
        const upcoming = events.filter(event => event.all_day ? event.start_date >= today && event.start_date < end : dates.bounds(event)[0] >= now && dates.dateKey(new Date(event.starts_at)) < end)
            .sort((a, b) => dates.bounds(a)[0] - dates.bounds(b)[0]);
        // Upcoming is chronological across categories; it is not silently capped.
        $("calendar-upcoming-list").replaceChildren();
        if (!upcoming.length) $("calendar-upcoming-list").append(node("li", "calendar-empty", "No upcoming events in the next 30 days."));
        upcoming.forEach(event => { const li = node("li"); li.append(eventButton(event, today)); $("calendar-upcoming-list").append(li); });
    }
    function toggleAllDay() {
        const allDay = $("event-all-day").checked;
        $("event-time-fields").hidden = allDay;
        $("event-date-fields").hidden = !allDay;
        ["event-start", "event-end"].forEach(id => { $(id).required = !allDay; $(id).disabled = allDay; });
        ["event-start-date", "event-end-date"].forEach(id => { $(id).required = allDay; $(id).disabled = !allDay; });
        updateOverlap();
    }
    function openEvent(event = null, key = selected) {
        if (!ready || loading || saving) return;
        eventForm.reset(); editing = event;
        $("event-form-error").textContent = "";
        $("calendar-event-title").textContent = event ? "Edit event" : "New event";
        $("event-title").value = event?.title || "";
        $("event-description").value = event?.description || "";
        $("event-category").value = event?.category || "lecture";
        $("event-location").value = event?.location || "";
        $("event-reminder").value = event?.reminder_minutes == null ? "" : String(event.reminder_minutes);
        $("event-all-day").checked = event?.all_day || false;
        $("event-start").value = event && !event.all_day ? dates.localInput(event.starts_at) : `${key}T09:00`;
        $("event-end").value = event && !event.all_day ? dates.localInput(event.ends_at) : `${key}T10:00`;
        $("event-start-date").value = event?.all_day ? event.start_date : key;
        $("event-end-date").value = event?.all_day ? dates.addDays(event.end_date, -1) : key;
        $("event-delete").hidden = !event;
        $("event-time-zone-note").textContent = `Enter times in ${timeZone.replaceAll("_", " ")}.${event && event.time_zone !== timeZone ? ` Originally created in ${event.time_zone}.` : ""} Conflict warnings cover this calendar view and the next 30 days.`;
        toggleAllDay();
        dialog.showModal();
        $("event-title").focus();
    }
    function payload() {
        const allDay = $("event-all-day").checked;
        const data = {
            title: $("event-title").value.trim(), description: $("event-description").value.trim(),
            category: $("event-category").value, location: $("event-location").value.trim(),
            all_day: allDay, time_zone: timeZone,
            reminder_minutes: $("event-reminder").value === "" ? null : Number($("event-reminder").value),
            starts_at: null, ends_at: null, start_date: null, end_date: null
        };
        if (!data.title || data.title.length > 200) throw new Error("Enter a title of 1–200 characters.");
        if (data.description.length > 5000 || data.location.length > 300) throw new Error("Description or location is too long.");
        if (allDay) {
            data.start_date = dates.dateKey(dates.parseDate($("event-start-date").value));
            const inclusiveEnd = dates.dateKey(dates.parseDate($("event-end-date").value));
            if (inclusiveEnd < data.start_date) throw new Error("The end date must be on or after the start date.");
            data.end_date = dates.addDays(inclusiveEnd, 1);
        } else {
            for (const [field, inputId] of [["starts_at", "event-start"], ["ends_at", "event-end"]]) {
                // Preserve the exact instant of an unchanged time, including the second occurrence of a DST fold.
                data[field] = editing && !editing.all_day && dates.localInput(editing[field]) === $(inputId).value ? editing[field] : dates.toInstant($(inputId).value);
            }
            if (new Date(data.ends_at) <= new Date(data.starts_at)) throw new Error("The end time must be after the start time.");
        }
        return data;
    }
    function updateOverlap() {
        const notice = $("event-overlap-note");
        try {
            const candidate = payload();
            const overlaps = events.filter(event => event.id !== editing?.id && dates.overlaps(candidate, event));
            notice.hidden = !overlaps.length;
            notice.textContent = overlaps.length ? `Overlaps ${overlaps.length} event${overlaps.length === 1 ? "" : "s"}. You can still save both events.` : "";
        } catch { notice.hidden = true; }
    }
    function mutationBusy(busy) {
        saving = busy;
        eventForm.querySelectorAll("button").forEach(button => { button.disabled = busy; });
        $("calendar-delete-confirm").disabled = busy;
        eventForm.setAttribute("aria-busy", String(busy));
        $("event-save").textContent = busy ? "Saving…" : "Save event";
    }
    eventForm.addEventListener("submit", async event => {
        event.preventDefault();
        if (saving) return;
        $("event-form-error").textContent = "";
        let data;
        try { data = payload(); } catch (error) { $("event-form-error").textContent = error.message; return; }
        mutationBusy(true);
        const current = generation;
        try {
            const saved = editing ? await service.update(editing.id, data) : await service.create(data);
            if (current !== generation) return;
            if (!saved?.id) throw new Error("The server did not confirm your event. Refresh to check it.");
            dialog.close();
            selected = saved.all_day ? saved.start_date : dates.dateKey(new Date(saved.starts_at));
            if (typeof showToast === "function") showToast("Event saved.");
            await load();
        } catch (error) {
            if (current !== generation) return;
            $("event-form-error").textContent = error.message;
            if (error.status === 401) { clearPrivateData(); status(error.message); $("calendar-auth").hidden = false; }
        } finally { mutationBusy(false); }
    });
    $("event-delete").addEventListener("click", () => {
        $("calendar-delete-title").textContent = "Delete this event?";
        $("calendar-delete-dialog").showModal();
    });
    $("calendar-delete-confirm").addEventListener("click", async () => {
        if (saving || !editing) return;
        mutationBusy(true);
        const current = generation;
        try {
            await service.remove(editing.id);
            if (current !== generation) return;
            $("calendar-delete-dialog").close(); dialog.close();
            if (typeof showToast === "function") showToast("Event deleted.");
            await load();
        } catch (error) {
            if (current !== generation) return;
            $("calendar-delete-dialog").close();
            $("event-form-error").textContent = error.message;
            if (error.status === 401) { clearPrivateData(); status(error.message); $("calendar-auth").hidden = false; }
        } finally { mutationBusy(false); }
    });
    document.querySelectorAll("[data-calendar-close]").forEach(button => button.addEventListener("click", () => { if (!saving) button.closest("dialog").close(); }));
    [dialog, $("calendar-delete-dialog")].forEach(element => {
        element.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
        element.addEventListener("click", event => {
            if (saving && event.target === element) event.stopImmediatePropagation();
        }, true);
    });
    eventForm.addEventListener("input", updateOverlap);
    $("event-all-day").addEventListener("change", () => {
        if ($("event-all-day").checked) {
            $("event-start-date").value = $("event-start").value.slice(0, 10);
            $("event-end-date").value = $("event-end").value.slice(0, 10);
        } else {
            $("event-start").value = $("event-start-date").value + "T09:00";
            $("event-end").value = $("event-end-date").value + "T10:00";
        }
        toggleAllDay();
    });
    $("open-calendar").addEventListener("click", showCalendar);
    $("open-chat").addEventListener("click", showChat);
    ["new-chat", "space-home", "chat-history"].forEach(id => $(id).addEventListener("click", () => { if (typeof canNavigate !== "function" || canNavigate()) showChat(); }));
    document.addEventListener("keydown", event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) showChat(); });
    $("calendar-create").addEventListener("click", () => openEvent());
    ["calendar-refresh", "calendar-retry"].forEach(id => $(id).addEventListener("click", load));
    $("calendar-today").addEventListener("click", () => { selected = dates.dateKey(); load(); });
    [["calendar-prev", -1], ["calendar-next", 1]].forEach(([id, count]) => $(id).addEventListener("click", () => {
        selected = view === "month" ? dates.shiftMonth(selected, count) : dates.addDays(selected, count * (view === "week" ? 7 : 1)); load();
    }));
    document.querySelectorAll("[data-calendar-view]").forEach(button => button.addEventListener("click", () => { view = button.dataset.calendarView; load(); }));
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && !panel.hidden && !saving && !dialog.open) {
            timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
            load();
        }
    });
    // Never carry another account's visible data across a session change.
    if (window.supabaseReady) window.supabaseReady.then(client => {
        let lastUser = null;
        client.auth.onAuthStateChange((event, session) => {
            const nextUser = session?.user?.id || null;
            if (nextUser !== lastUser || event === "SIGNED_OUT") {
                lastUser = nextUser;
                clearPrivateData();
                if (!panel.hidden) setTimeout(load, 0);
            }
        });
    }).catch(() => {});
    setEnabled(false);
})();
