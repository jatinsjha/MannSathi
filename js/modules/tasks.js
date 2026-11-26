/* Personal and teacher-assigned tasks. All records come from the protected API. */
(function () {
    "use strict";
    const $ = id => document.getElementById(id), panel = $("tasks-panel");
    if (!panel) return;
    const service = window.MannSathiTaskService, dates = window.MannSathiDates;
    const types = { personal_task: "Personal task", homework: "Homework", assignment: "Assignment", practical: "Practical", examination_preparation: "Examination preparation", project: "Project", other: "Other" };
    const statuses = { pending: "Pending", in_progress: "In progress", completed: "Completed" };
    const priorities = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" }, rank = { low: 0, medium: 1, high: 2, urgent: 3 };
    let context = null, tasks = [], notifications = [], editing = null, requestId = null, enrollments = [];
    let epoch = 0, loadId = 0, rosterLoadId = 0, loading = false, saving = false, notificationBusy = false, seen = null, enrollmentSeen = null, unreadCount = 0, notificationLoading = false;
    const dialog = $("task-dialog"), form = $("task-form"), notificationDialog = $("notifications-dialog");
    const isTeacher = () => context?.role === "teacher";
    const labelDate = value => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    function element(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }
    function message(text, retry = false) { $("tasks-status").textContent = text; $("tasks-retry").hidden = !retry; }
    function canEdit(task) { return task.created_by === context?.user_id; }
    function complete(task) { return isTeacher() && task.audience !== "personal" ? task.recipient_count > 0 && task.completed_count === task.recipient_count : task.status === "completed"; }
    function overdue(task) { return !complete(task) && task.due_at && new Date(task.due_at).getTime() < Date.now(); }
    function resetPrivate(identity = null) {
        epoch++; loadId++; rosterLoadId++; context = null; tasks = []; notifications = []; seen = null; enrollmentSeen = null; unreadCount = 0;
        loading = false; notificationLoading = false;
        $("tasks-list").replaceChildren(); $("notifications-list").replaceChildren();
        $("tasks-summary").textContent = ""; $("tasks-create").disabled = true; $("notifications-button").disabled = true;
        $("notifications-count").hidden = true; dialog.close(); $("task-delete-dialog").close(); notificationDialog.close();
        enrollments = [];
        $("teacher-roster-section").hidden = true;
        $("enrollment-list").replaceChildren(); $("approved-roster-list").replaceChildren();
        window.dispatchEvent(new CustomEvent("mannsathi:session-reset", { detail: identity }));
    }
    function sessionFailure(error) {
        if (error.status !== 401 && error.status !== 403) return false;
        resetPrivate(); $("tasks-auth").hidden = error.status !== 401; message(error.message, true);
        return true;
    }
    async function initialize() {
        const current = epoch;
        try {
            const result = await service.context();
            if (current !== epoch) return;
            if (!["student", "teacher"].includes(result.role) || !result.user_id || !Array.isArray(result.batches) || !Array.isArray(result.students)) throw new Error("Could not verify your workspace access.");
            context = result;
            $("teacher-roster-section").hidden = !isTeacher();
            if (!isTeacher()) { enrollments = []; $("enrollment-list").replaceChildren(); $("approved-roster-list").replaceChildren(); }
            window.dispatchEvent(new CustomEvent("mannsathi:context", { detail: result }));
            $("tasks-create").disabled = false; $("notifications-button").disabled = false;
            $("tasks-role-note").textContent = isTeacher() ? "Assign work to your classes or an individual student." : "Your personal tasks and work assigned by your teachers.";
            await refreshNotifications();
            if (current !== epoch) return;
            if (!panel.hidden) await load();
        } catch (error) {
            if (current !== epoch) return;
            if (sessionFailure(error)) return;
            context = null; $("tasks-create").disabled = true; $("notifications-button").disabled = true;
            $("teacher-roster-section").hidden = true;
            message(error.message, error.status !== 401);
            $("tasks-auth").hidden = error.status !== 401;
        }
    }
    async function load() {
        if (!context) { await initialize(); return; }
        const current = epoch, request = ++loadId;
        loading = true; $("tasks-create").disabled = true; panel.setAttribute("aria-busy", "true");
        $("tasks-auth").hidden = true; message("Loading your tasks…");
        try {
            const result = await service.list();
            if (current !== epoch || request !== loadId) return;
            if (!Array.isArray(result.tasks)) throw new Error("The task server returned an unreadable response.");
            tasks = result.tasks; render(); message(tasks.length ? "Tasks are up to date." : "No tasks yet. Add your first task.");
        } catch (error) {
            if (current !== epoch || request !== loadId) return;
            tasks = []; render(); message(error.message, error.status !== 401); $("tasks-auth").hidden = error.status !== 401;
            if (error.status === 401 || error.status === 403) { resetPrivate(); message(error.message, true); }
        } finally {
            if (current === epoch && request === loadId) { loading = false; panel.setAttribute("aria-busy", "false"); $("tasks-create").disabled = !context; }
        }
    }
    function filtered() {
        const status = $("tasks-filter-status").value, priority = $("tasks-filter-priority").value, source = $("tasks-filter-source").value, search = $("tasks-search").value.trim().toLowerCase();
        const now = Date.now(), today = dates.dateKey(), end = new Date(dates.parseDate(dates.addDays(today, 8))).getTime();
        return tasks.filter(task => {
            if (priority !== "all" && task.priority !== priority) return false;
            if (source === "personal" && task.audience !== "personal" || source === "assigned" && task.audience === "personal") return false;
            if (search && ![task.title, task.description, task.subject, task.assigned_by].some(value => String(value || "").toLowerCase().includes(search))) return false;
            if (status === "overdue") return overdue(task);
            if (status === "today") return task.due_at && dates.dateKey(new Date(task.due_at)) === today;
            if (status === "upcoming") return !complete(task) && task.due_at && new Date(task.due_at).getTime() >= now && new Date(task.due_at).getTime() < end;
            if (status === "completed") return complete(task);
            if (status === "pending" || status === "in_progress") return task.status === status && !complete(task);
            return true;
        }).sort((a, b) => {
            const due = value => value.due_at ? new Date(value.due_at).getTime() : Infinity;
            const sort = $("tasks-sort").value;
            if (sort === "priority") return rank[b.priority] - rank[a.priority] || due(a) - due(b) || a.id.localeCompare(b.id);
            if (sort === "created_desc") return new Date(b.created_at) - new Date(a.created_at) || a.id.localeCompare(b.id);
            return due(a) - due(b) || a.id.localeCompare(b.id);
        });
    }
    function render() {
        const list = $("tasks-list"), visible = filtered(); list.replaceChildren();
        $("tasks-summary").textContent = `${tasks.length} total · ${tasks.filter(complete).length} completed · ${tasks.filter(overdue).length} overdue · ${visible.length} shown`;
        $("tasks-empty").hidden = visible.length > 0;
        $("tasks-empty").textContent = tasks.length ? "No tasks match these filters." : "Your task list is empty.";
        for (const task of visible) {
            const card = element("li", "task-card" + (overdue(task) ? " is-overdue" : "")); card.dataset.taskId = task.id;
            const heading = element("div", "task-heading"); heading.append(element("h2", "task-title", task.title));
            const badges = element("div", "task-badges");
            badges.append(element("span", "task-badge priority-" + task.priority, priorities[task.priority]), element("span", "task-badge", task.audience === "personal" ? "Personal" : "Teacher assigned"));
            if (overdue(task)) badges.append(element("span", "task-badge", "Overdue"));
            heading.append(badges); card.append(heading);
            const details = [types[task.task_type], task.subject, task.due_at ? "Due " + labelDate(task.due_at) : "No deadline", task.estimated_minutes ? `${task.estimated_minutes} min estimated` : "", task.audience !== "personal" ? `Assigned by ${task.assigned_by || "your teacher"}${task.batch_id ? " · " + task.batch_id.toUpperCase() : ""}${task.target_division ? " · Division " + task.target_division : ""}` : ""].filter(Boolean);
            card.append(element("p", "task-meta", details.join(" · ")));
            if (task.description) card.append(element("p", "task-description", task.description));
            const actions = element("div", "task-actions");
            if (isTeacher() && task.audience !== "personal") actions.append(element("span", "task-meta", `${task.completed_count || 0} / ${task.recipient_count || 0} students completed`));
            else {
                const label = element("label", "task-status-label", "Status "), select = element("select", "task-status-select"); select.dataset.taskStatus = task.id;
                for (const [value, text] of Object.entries(statuses)) { const option = element("option", "", text); option.value = value; select.append(option); }
                select.value = task.status; select.addEventListener("change", () => changeStatus(task, select)); label.append(select); actions.append(label);
            }
            if (canEdit(task)) { const edit = element("button", "task-button", "Edit"); edit.type = "button"; edit.dataset.taskEdit = task.id; edit.addEventListener("click", () => openTask(task)); actions.append(edit); }
            card.append(actions); list.append(card);
        }
    }
    async function changeStatus(task, select) {
        const current = epoch, previous = task.status;
        select.disabled = true;
        try {
            await service.status(task.id, select.value);
            if (current === epoch) await load();
        } catch (error) { if (current === epoch) { select.value = previous; if (!sessionFailure(error)) message(error.message, true); } }
        finally { select.disabled = false; }
    }
    function configureAudience() {
        const audience = $("task-audience").value;
        $("task-batch").disabled = !!editing || audience === "personal";
        $("task-student-field").hidden = audience !== "student";
        $("task-student").disabled = !!editing || audience !== "student";
        $("task-division-field").hidden = audience !== "division";
        $("task-division").disabled = !!editing || audience !== "division";
        $("task-roster-filter-field").hidden = audience !== "student";
        $("task-roster-division").disabled = !!editing || audience !== "student";
        $("task-status").disabled = !!editing || audience !== "personal";
        if (audience !== "personal" && !editing) $("task-status").value = "pending";
        $("task-assignment-note").textContent = audience === "class" ? "Every approved student in this class will receive this task, across all divisions." : audience === "division" ? "Only approved students in the selected division will receive this task and a notification." : audience === "student" ? "Only the selected student will receive this task and its notification." : "This task is private to your account.";
        if (editing && audience !== "personal") $("task-assignment-note").textContent += " Recipients cannot be changed after assignment.";
        updateRosterNote();
    }
    function studentsInClass(batch = $("task-batch").value) { return (context?.students || []).filter(student => student.batch_id === batch); }
    function updateRosterNote() {
        const audience = $("task-audience").value, students = studentsInClass();
        const targets = audience === "division" ? students.filter(student => student.division === $("task-division").value) : audience === "student" ? students.filter(student => !$("task-roster-division").value || student.division === $("task-roster-division").value) : students;
        $("task-roster-note").hidden = audience === "personal" || targets.length > 0;
        $("task-roster-note").textContent = "No approved students in this selection. Ask students to save their class and division in Settings. You can then approve their enrollment requests in Notifications.";
        if (!saving) $("task-save").disabled = !editing && audience !== "personal" && targets.length === 0;
        for (const option of $("task-division").options) option.textContent = `${option.value} (${students.filter(student => student.division === option.value).length} students)`;
    }
    function fillStudents() {
        const target = $("task-student"); target.replaceChildren();
        const placeholder = element("option", "", "Select a student"); placeholder.value = ""; target.append(placeholder);
        const filter = $("task-roster-division").value;
        const students = studentsInClass().filter(student => !filter || student.division === filter).sort((a, b) => String(a.roll_number || a.full_name).localeCompare(String(b.roll_number || b.full_name), undefined, { numeric: true }));
        for (const student of students) {
            const option = element("option", "", `${student.roll_number ? student.roll_number + " · " : ""}${student.full_name || "Student"}${student.division ? " · Division " + student.division : " · Division not set"} (${student.id.slice(-8)})`); option.value = student.id; target.append(option);
        }
        updateRosterNote();
    }
    function openTask(task = null) {
        if (!context || loading || saving || task && !canEdit(task)) return;
        editing = task; requestId = task ? null : crypto.randomUUID(); form.reset();
        $("task-dialog-title").textContent = task ? "Edit task" : isTeacher() ? "New task or assignment" : "New personal task";
        $("task-title").value = task?.title || ""; $("task-description").value = task?.description || ""; $("task-subject").value = task?.subject || "";
        $("task-type").value = task?.task_type || (isTeacher() ? "assignment" : "personal_task");
        $("task-priority").value = task?.priority || "medium"; $("task-status").value = task?.status || "pending";
        $("task-due").value = task?.due_at ? dates.localInput(task.due_at) : ""; $("task-estimated").value = task?.estimated_minutes || "";
        $("task-assignment-fields").hidden = !isTeacher(); $("task-audience").disabled = !!task || !isTeacher();
        $("task-audience").value = task?.audience || (isTeacher() ? "class" : "personal");
        $("task-batch").replaceChildren();
        for (const batch of context.batches) { const count = studentsInClass(batch.id).length; const option = element("option", "", `${batch.label} (${count} students)`); option.value = batch.id; $("task-batch").append(option); }
        if (task?.batch_id) $("task-batch").value = task.batch_id;
        $("task-division").value = task?.target_division || "A";
        $("task-roster-division").value = "";
        fillStudents(); if (task?.assigned_to) $("task-student").value = task.assigned_to;
        configureAudience(); $("task-delete").hidden = !task; $("task-form-error").textContent = "";
        $("task-zone-note").textContent = `Deadlines use ${Intl.DateTimeFormat().resolvedOptions().timeZone}. ${task ? "Change completion status from the task list." : ""}`;
        dialog.showModal(); $("task-title").focus();
    }
    function taskPayload() {
        const title = $("task-title").value.trim(), description = $("task-description").value.trim(), subject = $("task-subject").value.trim();
        if (!title || title.length > 200) throw new Error("Enter a task title of 1–200 characters.");
        if (description.length > 5000 || subject.length > 120) throw new Error("Description or subject is too long.");
        const estimate = $("task-estimated").value;
        if (estimate && (!Number.isInteger(Number(estimate)) || Number(estimate) < 1 || Number(estimate) > 10080)) throw new Error("Estimated time must be 1–10080 whole minutes.");
        const input = $("task-due").value;
        const due = input ? editing?.due_at && dates.localInput(editing.due_at) === input ? editing.due_at : dates.toInstant(input) : null;
        const data = { title, description, subject, task_type: $("task-type").value, due_at: due, estimated_minutes: estimate ? Number(estimate) : null, priority: $("task-priority").value };
        if (!editing) {
            const audience = isTeacher() ? $("task-audience").value : "personal";
            if (audience !== "personal" && !$("task-batch").value) throw new Error("Choose one of your approved classes.");
            if (audience === "student" && !$("task-student").value) throw new Error("Select the student who should receive this task.");
            const targets = audience === "division" ? studentsInClass().filter(student => student.division === $("task-division").value) : studentsInClass();
            if (audience !== "personal" && !targets.length) throw new Error("There are no approved students in this selection. Open Notifications to review enrollment requests first.");
            Object.assign(data, { request_id: requestId, audience, batch_id: audience === "personal" ? null : $("task-batch").value, assigned_to: audience === "student" ? $("task-student").value : null, target_division: audience === "division" ? $("task-division").value : null, status: audience === "personal" ? $("task-status").value : "pending" });
        }
        return data;
    }
    async function refreshRoster() {
        $("teacher-roster-section").hidden = !isTeacher();
        if (!isTeacher()) return;
        const current = epoch, request = ++rosterLoadId, previous = $("roster-class").value;
        $("roster-class").replaceChildren();
        for (const batch of context.batches) { const option = element("option", "", batch.label); option.value = batch.id; $("roster-class").append(option); }
        if (context.batches.some(batch => batch.id === previous)) $("roster-class").value = previous;
        $("roster-status").textContent = "Loading enrollment requests…";
        $("enrollment-list").querySelectorAll("button").forEach(button => { button.disabled = true; });
        try {
            const result = await service.enrollments();
            if (current !== epoch || request !== rosterLoadId || !isTeacher()) return;
            if (!Array.isArray(result.enrollments)) throw new Error("Could not load class enrollment requests.");
            enrollments = result.enrollments.filter(row => context.batches.some(batch => batch.id === row.batch_id));
            const keys = new Set(enrollments.map(row => `${row.user_id}:${row.batch_id}:${row.division || ""}`));
            const newRequest = enrollmentSeen && [...keys].some(key => !enrollmentSeen.has(key));
            enrollmentSeen = keys;
            $("roster-status").textContent = "Class roster is up to date.";
            if (newRequest) showToast("A student requested class enrollment. Open Notifications to review it.");
        } catch (error) {
            if (current !== epoch || request !== rosterLoadId) return;
            enrollments = [];
            $("roster-status").textContent = error.message;
            if (sessionFailure(error)) return;
        }
        if (current === epoch && request === rosterLoadId) { renderRoster(); updateNotificationBadge(); }
    }
    function renderRoster() {
        if (!isTeacher()) return;
        const batch = $("roster-class").value, students = studentsInClass(batch), pending = enrollments.filter(row => row.batch_id === batch);
        $("roster-counts").textContent = `${students.length} approved · ${pending.length} pending · ` + ["A", "B", "C"].map(division => `${division}: ${students.filter(student => student.division === division).length}`).join(" · ");
        $("roster-help").textContent = students.length ? "Approve only students who belong to your class. Division assignments use each student's approved division." : "No approved students yet. Ask students to open Settings → Student details, enter their roll number, class and division, and save. Their requests will appear below for your approval.";
        $("approved-roster-list").replaceChildren(); $("enrollment-list").replaceChildren();
        for (const student of students) {
            const row = element("li", "roster-student"); row.dataset.rosterUser = student.id;
            row.append(element("h4", "", student.full_name || "Student"), element("p", "", `${student.roll_number || "Roll number not set"} · ${batch.toUpperCase()} · ${student.division ? "Division " + student.division : "Division not set"}`));
            $("approved-roster-list").append(row);
        }
        if (!students.length) $("approved-roster-list").append(element("li", "roster-empty", "There are no approved students in this class."));
        for (const request of pending) {
            const row = element("li", "enrollment-card"); row.dataset.enrollmentUser = request.user_id; row.dataset.enrollmentDivision = request.division || "";
            row.append(element("h4", "", request.full_name || "Student"), element("p", "", `${request.roll_number || "Roll number not set"} · Division ${request.division || "not set"}${request.email ? " · " + request.email : ""}`));
            const actions = element("div", "enrollment-actions");
            for (const approve of [true, false]) {
                const button = element("button", "task-button" + (approve ? "" : " task-danger"), approve ? "Approve" : "Reject"); button.type = "button";
                button.dataset[approve ? "enrollmentApprove" : "enrollmentReject"] = request.user_id;
                button.addEventListener("click", async () => {
                    const current = epoch; actions.querySelectorAll("button").forEach(control => { control.disabled = true; });
                    try {
                        await service.approveEnrollment(request.user_id, batch, approve, request.division);
                        if (current !== epoch) return;
                        showToast(approve ? "Student enrolled in this class and division." : "Enrollment request rejected.");
                        await initialize();
                    } catch (error) { if (current === epoch) { $("roster-status").textContent = error.message; actions.querySelectorAll("button").forEach(control => { control.disabled = false; }); } }
                });
                actions.append(button);
            }
            row.append(actions); $("enrollment-list").append(row);
        }
        if (!pending.length) $("enrollment-list").append(element("li", "enrollment-empty", "No pending enrollment requests."));
    }
    function setBusy(value) {
        saving = value; form.querySelectorAll("button").forEach(button => { button.disabled = value; });
        $("task-delete-confirm").disabled = value; $("task-save").textContent = value ? "Saving…" : "Save task";
        form.setAttribute("aria-busy", String(value));
        if (!value && context) updateRosterNote();
    }
    form.addEventListener("submit", async event => {
        event.preventDefault(); if (saving) return;
        let payload; try { payload = taskPayload(); } catch (error) { $("task-form-error").textContent = error.message; return; }
        const current = epoch; setBusy(true); $("task-form-error").textContent = "";
        try {
            const result = editing ? await service.edit(editing.id, payload) : await service.create(payload);
            if (current !== epoch) return;
            if (!result.task?.id) throw new Error("The server did not confirm your task. Refresh to check it.");
            dialog.close(); showToast(payload.audience && payload.audience !== "personal" ? "Assignment sent to its students." : "Task saved."); await load();
        } catch (error) { if (current === epoch && !sessionFailure(error)) $("task-form-error").textContent = error.message; }
        finally { setBusy(false); }
    });
    $("task-delete").addEventListener("click", () => $("task-delete-dialog").showModal());
    $("task-delete-confirm").addEventListener("click", async () => {
        if (saving || !editing) return;
        const current = epoch; setBusy(true);
        try {
            await service.remove(editing.id); if (current !== epoch) return;
            $("task-delete-dialog").close(); dialog.close(); showToast("Task deleted."); await load();
        } catch (error) { if (current === epoch) { $("task-delete-dialog").close(); if (!sessionFailure(error)) $("task-form-error").textContent = error.message; } }
        finally { setBusy(false); }
    });
    $("task-audience").addEventListener("change", () => { configureAudience(); fillStudents(); });
    $("task-batch").addEventListener("change", fillStudents);
    $("task-division").addEventListener("change", updateRosterNote);
    $("task-roster-division").addEventListener("change", fillStudents);
    $("roster-class").addEventListener("change", renderRoster);
    $("roster-refresh").addEventListener("click", initialize);
    function updateNotificationBadge() {
        const pending = isTeacher() ? enrollments.length : 0, total = unreadCount + pending;
        const badge = $("notifications-count"); badge.hidden = total === 0; badge.textContent = total > 99 ? "99+" : String(total);
        $("notifications-button").setAttribute("aria-label", total ? `Notifications, ${unreadCount} unread${isTeacher() ? `, ${pending} enrollment requests` : ""}` : "Notifications");
    }
    function renderNotifications(unread) {
        unreadCount = unread; updateNotificationBadge();
        $("notifications-title").textContent = isTeacher() ? "Notifications & approvals" : "Notifications";
        $("notifications-list").replaceChildren();
        $("notifications-status").textContent = notifications.length ? `${unread} unread · Showing the latest ${notifications.length}` : isTeacher() ? "Enrollment requests appear above. Assignment notifications will appear here." : "No assignment notifications yet.";
        $("notifications-mark-all").textContent = "Mark shown as read";
        $("notifications-mark-all").hidden = isTeacher() && notifications.length === 0;
        $("notifications-mark-all").disabled = !notifications.some(note => !note.read_at);
        for (const note of notifications) {
            const item = element("li", "notification-item" + (!note.read_at ? " is-unread" : "")); item.dataset.notificationId = note.id;
            const card = element("div", "notification-card");
            card.append(element("h3", "notification-title", note.title), element("p", "notification-message", note.message), element("p", "notification-meta", labelDate(note.created_at)));
            const actions = element("div", "notification-actions");
            if (!note.read_at) { const read = element("button", "task-button", "Mark as read"); read.type = "button"; read.dataset.notificationRead = note.id; read.addEventListener("click", () => readNotification(note.id)); actions.append(read); }
            if (note.task_id) {
                const open = element("button", "task-button", "View task"); open.type = "button"; open.dataset.notificationOpen = note.id;
                open.addEventListener("click", async () => {
                    const current = epoch;
                    if (!note.read_at) await readNotification(note.id);
                    if (current !== epoch) return;
                    notificationDialog.close();
                    for (const id of ["tasks-filter-status", "tasks-filter-priority", "tasks-filter-source"]) $(id).value = "all";
                    $("tasks-search").value = "";
                    if (!window.MannSathiWorkspace.show("tasks")) return;
                    await load(); if (current !== epoch) return;
                    const target = [...$("tasks-list").children].find(item => item.dataset.taskId === note.task_id);
                    if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: "center", behavior: "smooth" }); }
                    else showToast("This task is no longer available.");
                });
                actions.append(open);
            }
            card.append(actions); item.append(card); $("notifications-list").append(item);
        }
    }
    async function refreshNotifications() {
        if (!context || notificationLoading) return;
        const current = epoch; notificationLoading = true;
        try {
            if (isTeacher()) await refreshRoster();
            if (current !== epoch || !context) return;
            const result = await service.notifications();
            if (current !== epoch) return;
            if (!Array.isArray(result.notifications) || !Number.isInteger(result.unread_count)) throw new Error("Could not load your notifications.");
            notifications = result.notifications;
            const newWork = seen && notifications.some(note => !note.read_at && !seen.has(note.id));
            seen = new Set(notifications.map(note => note.id)); renderNotifications(result.unread_count);
            if (newWork) { showToast("Your teacher has assigned new work."); if (!panel.hidden && !dialog.open) await load(); }
        } catch (error) {
            if (current !== epoch) return;
            $("notifications-status").textContent = error.message;
            if (error.status === 401 || error.status === 403) resetPrivate();
        } finally { if (current === epoch) notificationLoading = false; }
    }
    async function readNotification(id) {
        if (notificationBusy) return;
        const current = epoch; notificationBusy = true;
        try { await service.read(id); if (current === epoch) await refreshNotifications(); }
        catch (error) { if (current === epoch) $("notifications-status").textContent = error.message; }
        finally { notificationBusy = false; }
    }
    $("notifications-button").addEventListener("click", () => {
        if (!context) return;
        notificationDialog.showModal(); $("notifications-button").setAttribute("aria-expanded", "true"); refreshNotifications();
    });
    notificationDialog.addEventListener("close", () => $("notifications-button").setAttribute("aria-expanded", "false"));
    $("notifications-mark-all").addEventListener("click", async () => {
        if (notificationBusy) return;
        const current = epoch; notificationBusy = true; $("notifications-mark-all").disabled = true;
        try {
            const ids = notifications.filter(note => !note.read_at).map(note => note.id);
            for (let i = 0; i < ids.length && current === epoch; i += 4) await Promise.all(ids.slice(i, i + 4).map(id => service.read(id)));
            if (current === epoch) await refreshNotifications();
        } catch (error) { if (current === epoch) $("notifications-status").textContent = error.message; }
        finally { notificationBusy = false; if (current === epoch) $("notifications-mark-all").disabled = !notifications.some(note => !note.read_at); }
    });
    document.querySelectorAll("[data-task-close]").forEach(button => button.addEventListener("click", () => { if (!saving) button.closest("dialog").close(); }));
    [dialog, $("task-delete-dialog")].forEach(item => {
        item.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
        item.addEventListener("click", event => { if (saving && event.target === item) event.stopImmediatePropagation(); }, true);
    });
    $("open-tasks").addEventListener("click", () => { if (window.MannSathiWorkspace.show("tasks")) load(); });
    $("tasks-create").addEventListener("click", () => openTask());
    ["tasks-refresh", "tasks-retry"].forEach(id => $(id).addEventListener("click", () => { if (context) load(); else initialize(); }));
    ["tasks-filter-status", "tasks-filter-priority", "tasks-filter-source", "tasks-sort"].forEach(id => $(id).addEventListener("change", render));
    $("tasks-search").addEventListener("input", render);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && !saving && !dialog.open) initialize(); });
    setInterval(() => { if (!document.hidden && context) refreshNotifications(); }, 30000);
    window.MannSathiTasks = Object.freeze({ refresh: initialize, get context() { return context; } });
    resetPrivate();
    if (window.supabaseReady) window.supabaseReady.then(client => {
        let lastUser = null;
        client.auth.onAuthStateChange((event, session) => {
            const next = session?.user?.id || null;
            if (next !== lastUser || event === "SIGNED_OUT") {
                lastUser = next;
                const name = session?.user?.user_metadata?.full_name;
                const fullName = (typeof name === "string" && name.trim()) || session?.user?.email?.split("@")[0];
                resetPrivate(next ? { user_id: next, full_name: fullName } : null);
                setTimeout(initialize, 0);
            }
        });
    }).catch(() => {});
})();
