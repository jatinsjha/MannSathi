/* Student-declared details request enrollment; only teachers approve membership. */
(function () {
    "use strict";
    const $ = id => document.getElementById(id), dialog = $("settings-dialog");
    if (!dialog) return;
    const service = window.MannSathiTaskService;
    let settings = null, email = null, epoch = 0, requestId = 0, saving = false, dirty = false;
    const guest = () => new URLSearchParams(location.search).get("guest") === "true";
    function clear() {
        epoch++; requestId++; settings = null; email = null; dirty = false;
        $("student-profile-form").reset(); $("student-profile-section").hidden = true;
        $("profile-access-note").hidden = false; $("profile-access-note").textContent = "Sign in with a student account to edit student details.";
        $("settings-account-email").textContent = "—"; $("settings-account-role").textContent = "Guest";
        $("settings-password-reset").disabled = true; $("profile-form-error").textContent = "";
        $("profile-membership-status").textContent = ""; $("settings-account-status").textContent = "";
    }
    function render() {
        const profile = settings.profile || {}, member = settings.membership;
        const student = settings.role === "student";
        $("student-profile-section").hidden = !student; $("profile-access-note").hidden = student;
        if (!student) $("profile-access-note").textContent = "Student details are available only in student accounts. Your teacher permissions are managed by your college.";
        $("profile-name").value = profile.full_name || ""; $("profile-roll").value = profile.roll_number || "";
        $("profile-class").replaceChildren();
        const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Select your class"; $("profile-class").append(placeholder);
        for (const batch of settings.classes || []) { const option = document.createElement("option"); option.value = batch.id; option.textContent = batch.label; $("profile-class").append(option); }
        $("profile-class").value = profile.class_code || member?.batch_id || "";
        $("profile-division").value = profile.division || member?.division || "";
        const status = $("profile-membership-status");
        status.className = "settings-membership-status" + (member?.status === "approved" ? " is-approved" : member?.status === "pending" ? " is-pending" : "");
        status.textContent = member ? `${member.status === "approved" ? "Approved" : member.status === "pending" ? "Pending — waiting for teacher approval" : "Enrollment rejected — contact your teacher"} · ${member.batch_id.toUpperCase()} · ${member.division ? "Division " + member.division : "Division not set"}` : "You are not enrolled in a class yet. Save your details to submit a request to your teacher.";
        $("settings-account-email").textContent = email || "Unavailable";
        $("settings-account-role").textContent = student ? "Student" : "Teacher";
        $("settings-password-reset").disabled = !email;
        $("profile-save").disabled = saving || !student || !settings.classes?.length;
        if (profile.full_name) window.dispatchEvent(new CustomEvent("mannsathi:profile", { detail: { full_name: profile.full_name, role: settings.role } }));
    }
    async function load() {
        if (guest()) { clear(); return; }
        if (saving || dirty && dialog.open) return;
        const current = epoch, request = ++requestId;
        $("profile-save").disabled = true; $("profile-form-error").textContent = "Loading account details…";
        try {
            const [result, auth] = await Promise.all([
                service.settings(),
                window.supabaseReady.then(client => client.auth.getUser())
            ]);
            if (current !== epoch || request !== requestId) return;
            if (!["student", "teacher"].includes(result.role) || !result.profile || !Array.isArray(result.classes)) throw new Error("Could not load your student settings.");
            settings = result; email = auth.error ? null : auth.data?.user?.email || null;
            if (dirty && dialog.open) { $("profile-save").disabled = settings.role !== "student"; $("profile-form-error").textContent = ""; return; }
            $("profile-form-error").textContent = ""; render();
        } catch (error) {
            if (current !== epoch || request !== requestId) return;
            $("profile-form-error").textContent = error.message;
            $("student-profile-section").hidden = true; $("profile-access-note").hidden = false;
            $("profile-access-note").textContent = error.status === 401 ? "Sign in to edit your details." : error.message;
            $("settings-account-status").textContent = error.message;
        }
    }
    function tab(name) {
        document.querySelectorAll("[data-settings-tab]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.settingsTab === name)));
        document.querySelectorAll("[data-settings-panel]").forEach(panel => { panel.hidden = panel.dataset.settingsPanel !== name; });
        if (name === "profile" || name === "account") load();
    }
    document.querySelectorAll("[data-settings-tab]").forEach(button => button.addEventListener("click", () => tab(button.dataset.settingsTab)));
    $("student-profile-form").addEventListener("submit", async event => {
        event.preventDefault(); if (saving || settings?.role !== "student") return;
        const body = { full_name: $("profile-name").value.trim(), roll_number: $("profile-roll").value.trim(), class_code: $("profile-class").value, division: $("profile-division").value };
        if (body.full_name.length < 2 || body.full_name.length > 100 || !body.roll_number || body.roll_number.length > 30 || !body.class_code || !["A", "B", "C"].includes(body.division)) { $("profile-form-error").textContent = "Enter your name, roll number, class and division A, B or C."; return; }
        if (!/^[A-Za-z0-9][A-Za-z0-9 /_-]{0,29}$/.test(body.roll_number)) { $("profile-form-error").textContent = "Roll numbers can contain letters, digits, spaces, /, _ and -."; return; }
        const current = epoch; saving = true; $("profile-save").disabled = true; $("profile-form-error").textContent = "Saving your details…";
        try {
            const result = await service.saveSettings(body);
            if (current !== epoch) return;
            settings = result; dirty = false; render(); $("profile-form-error").textContent = "";
            showToast(result.membership?.status === "approved" ? "Student details saved." : "Details saved. Your teacher can now review the enrollment request.");
            await window.MannSathiTasks.refresh();
        } catch (error) { if (current === epoch) $("profile-form-error").textContent = error.message; }
        finally { saving = false; if (current === epoch) $("profile-save").disabled = settings?.role !== "student"; }
    });
    $("settings-password-reset").addEventListener("click", async () => {
        if (!email || guest()) return;
        const current = epoch, targetEmail = email, role = settings?.role;
        $("settings-password-reset").disabled = true; $("settings-account-status").textContent = "Sending password reset email…";
        try {
            const client = await window.supabaseReady;
            if (current !== epoch) return;
            const result = await client.auth.resetPasswordForEmail(targetEmail, { redirectTo: location.origin + "/recover.html" + (role === "teacher" ? "?role=teacher" : "") });
            if (result.error) throw result.error;
            if (current === epoch) $("settings-account-status").textContent = "Password reset email sent. Check your inbox.";
        } catch (error) { if (current === epoch) $("settings-account-status").textContent = error.message || "Could not send the reset email."; }
        finally { if (current === epoch) $("settings-password-reset").disabled = !email; }
    });
    window.addEventListener("mannsathi:context", load);
    window.addEventListener("mannsathi:session-reset", clear);
    document.querySelectorAll("[data-open-settings]").forEach(button => button.addEventListener("click", () => {
        tab(button.dataset.openSettings);
        openDialog("settings-dialog");
    }));
    $("student-profile-form").addEventListener("input", () => { dirty = true; });
    $("student-profile-form").addEventListener("change", () => { dirty = true; });
    dialog.addEventListener("close", () => { dirty = false; });
    clear(); tab("appearance");
    if (window.MannSathiTasks.context) load();
})();
