/* Capture the email callback before any external script or resource loads. */
(() => {
    "use strict";
    const query = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.slice(1));
    const teacher = query.get("role") === "teacher";
    const path = "/recover.html" + (teacher ? "?role=teacher" : "");
    const login = teacher ? "teacher-login.html" : "index.html";
    let callback = null;
    let hadLink = false;
    try {
        const read = name => {
            const all = [...query.getAll(name), ...hash.getAll(name)];
            if (all.length > 1 || (all[0]?.length || 0) > 8192) throw new Error();
            return all[0] || "";
        };
        hadLink = Boolean(location.hash || [...query.keys()].some(key => key !== "role"));
        const type = read("type"), tokenHash = read("token_hash"), access = read("access_token"), refresh = read("refresh_token");
        if (type === "recovery" && !read("error") && !read("error_code")) {
            if (tokenHash && !access && !refresh) callback = { tokenHash };
            else if (access && refresh && !tokenHash) callback = { access, refresh };
        }
    } catch { callback = null; }
    // The session and callback secrets stay in memory. Reloading requires a new link.
    if (hadLink || location.search) history.replaceState(null, "", path);
    for (const key of [...query.keys()]) query.delete(key);
    for (const key of [...hash.keys()]) hash.delete(key);

    function claims(token) {
        const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        return JSON.parse(atob(part));
    }

    async function recoverySession(client, link) {
        if (link.tokenHash) {
            const result = await client.auth.verifyOtp({ type: "recovery", token_hash: link.tokenHash });
            if (result.error) throw result.error;
            return result.data.session;
        }
        // The standard implicit Supabase recovery email yields a verified OTP session.
        // Verify the exact bearer before reading claims. A normal password login
        // or an unrelated refresh token cannot become this page's recovery session.
        const verified = await client.auth.getUser(link.access);
        if (verified.error || !verified.data.user || verified.data.user.is_anonymous) throw new Error();
        const original = claims(link.access);
        if (original.sub !== verified.data.user.id || !original.session_id || !(original.exp * 1000 > Date.now()) ||
            !original.amr?.some(entry => entry.method === "otp" || entry.method === "recovery")) throw new Error();
        const fresh = await client.auth.refreshSession({ refresh_token: link.refresh });
        if (fresh.error || !fresh.data.session || fresh.data.session.user.id !== original.sub ||
            claims(fresh.data.session.access_token).session_id !== original.session_id) throw new Error();
        return fresh.data.session;
    }

    document.addEventListener("DOMContentLoaded", () => {
        const $ = id => document.getElementById(id);
        const form = $("new-password-form"), request = $("request-recovery-form"), open = $("verify-recovery");
        const password = $("new-password"), confirm = $("confirm-new-password"), save = $("save-password");
        const detail = $("recovery-detail"), message = $("recovery-message"), signIn = $("return-to-login");
        signIn.href = login;
        signIn.textContent = teacher ? "Teacher sign in" : "Student sign in";
        const done = $("completed-login");
        done.href = login + "?recovered=1";
        let userId = null, expires = 0, busy = false;
        const challenge = $("recovery-mfa-form"), factorSelect = $("recovery-factor"), code = $("recovery-code");
        const factorHelp = $("recovery-factor-help");
        let verifiedFactors = [];
        function status(text, error = false) {
            message.textContent = text;
            message.classList.toggle("error", error);
        }
        function requestLink(invalid) {
            userId = null; expires = 0; callback = null;
            password.value = ""; confirm.value = "";
            verifiedFactors = []; code.value = ""; challenge.hidden = factorHelp.hidden = true;
            open.hidden = true; form.hidden = true; request.hidden = false;
            $("recovery-title").textContent = "Reset your password";
            detail.textContent = invalid ? "This reset link is invalid, expired or already used. Request a new link below." :
                "Enter your account email to request a new reset link.";
        }
        async function verify() {
            if (busy || !callback) return;
            busy = true; open.disabled = true;
            const link = callback;
            callback = null;
            detail.textContent = "Checking your recovery link…";
            try {
                const client = await window.supabaseReady;
                const session = await recoverySession(client, link);
                if (!session?.user?.id || session.user.is_anonymous || !(session.expires_at * 1000 > Date.now())) throw new Error();
                userId = session.user.id;
                expires = session.expires_at * 1000;
                detail.textContent = "Choose a password with at least 8 characters.";
                form.hidden = false; open.hidden = true;
                password.focus();
            } catch { requestLink(true); }
            finally { busy = false; }
        }
        open.addEventListener("click", verify);
        if (!callback) requestLink(hadLink);
        else if (callback.tokenHash) {
            detail.textContent = "Open your reset link to choose a new password.";
            open.hidden = false;
        } else verify();

        async function showFactors() {
            factorHelp.hidden = false;
            try {
                const client = await window.supabaseReady;
                const result = await client.auth.mfa.listFactors();
                if (result.error) throw result.error;
                verifiedFactors = (result.data?.totp || []).filter(f => f.status === "verified" && typeof f.id === "string");
                if (!verifiedFactors.length) {
                    status("This account requires a second factor. Contact support to recover your registered authenticator.", true);
                    return;
                }
                factorSelect.replaceChildren();
                verifiedFactors.forEach((factor, index) => {
                    const option = document.createElement("option");
                    option.value = factor.id; option.textContent = factor.friendly_name || "Authenticator " + (index + 1);
                    factorSelect.append(option);
                });
                factorSelect.value = verifiedFactors[0].id;
                $("recovery-factor-choice").hidden = verifiedFactors.length === 1;
                form.hidden = true; challenge.hidden = false; code.value = "";
                $("recovery-title").textContent = "Verify your authenticator";
                detail.textContent = "Enter the current code from your registered authenticator app.";
                status(""); code.focus();
            } catch {
                status("Could not load your authenticators. Try updating your password again or contact support.", true);
            }
        }
        challenge.addEventListener("submit", async event => {
            event.preventDefault();
            if (busy || challenge.hidden || !userId) return;
            if (expires <= Date.now()) { requestLink(true); status(""); return; }
            const factorId = factorSelect.value;
            if (!verifiedFactors.some(f => f.id === factorId) || !/^[0-9]{6}$/.test(code.value)) {
                status("Choose your registered authenticator and enter its six-digit code.", true); return;
            }
            busy = true; $("verify-factor").disabled = true; status("Verifying code…");
            try {
                const client = await window.supabaseReady;
                const identity = await client.auth.getUser();
                if (identity.error || identity.data?.user?.id !== userId) { requestLink(true); status(""); return; }
                const result = await client.auth.mfa.challengeAndVerify({ factorId, code: code.value });
                if (result.error) throw result.error;
                challenge.hidden = factorHelp.hidden = true; form.hidden = false; verifiedFactors = [];
                $("recovery-title").textContent = "Reset your password";
                detail.textContent = "Authenticator verified. Save your new password.";
                status(""); save.focus();
            } catch (error) {
                if (error.status === 401 || error.code === "session_not_found") { requestLink(true); status(""); }
                else status(error.status === 429 ? "Too many verification attempts. Please try again later." :
                    "Code verification failed. Try a fresh code from your authenticator.", true);
            } finally { code.value = ""; busy = false; $("verify-factor").disabled = false; }
        });
        $("reveal-password").addEventListener("click", event => {
            const show = password.type === "password";
            password.type = confirm.type = show ? "text" : "password";
            event.currentTarget.textContent = show ? "Hide" : "Show";
            event.currentTarget.setAttribute("aria-label", show ? "Hide passwords" : "Show passwords");
            event.currentTarget.setAttribute("aria-pressed", String(show));
        });
        request.addEventListener("submit", async event => {
            event.preventDefault();
            if (busy || request.hidden) return;
            const email = $("recovery-email").value.trim();
            if (!email || !$("recovery-email").checkValidity()) return;
            busy = true; $("send-recovery").disabled = true; status("Sending reset email…");
            try {
                const client = await window.supabaseReady;
                const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + path });
                if (error && error.code !== "user_not_found") throw error;
                status("If this email belongs to a MannSathi account, check your inbox for a reset link.");
            } catch (error) {
                status(error.status === 429 ? "Too many reset requests. Please try again later." : "Could not send the reset email. Please try again.", true);
            } finally { busy = false; $("send-recovery").disabled = false; }
        });
        form.addEventListener("submit", async event => {
            event.preventDefault();
            if (busy || form.hidden || !userId) return;
            if (expires <= Date.now()) { requestLink(true); status(""); return; }
            if (password.value.length < 8) { status("Use at least 8 characters.", true); password.focus(); return; }
            if (password.value !== confirm.value) { status("The passwords do not match.", true); confirm.focus(); return; }
            busy = true; save.disabled = true; status("Updating password…");
            try {
                const client = await window.supabaseReady;
                const identity = await client.auth.getUser();
                if (identity.error || identity.data?.user?.id !== userId) { requestLink(true); status(""); return; }
                const result = await client.auth.updateUser({ password: password.value });
                if (result.error) throw result.error;
                if (result.data?.user?.id !== userId) { requestLink(true); status("Could not confirm the change. Try signing in.", true); return; }
                userId = null; expires = 0; form.reset(); form.hidden = true; done.hidden = false;
                signIn.href = done.href;
                $("recovery-title").textContent = "Password updated";
                detail.textContent = "Sign in to MannSathi with your new password.";
                status(""); done.focus();
                await client.auth.signOut({ scope: "local" }).catch(() => {});
            } catch (error) {
                if (error.code === "insufficient_aal") {
                    await showFactors();
                } else if (error.status === 401 || error.status === 403 || error.code === "session_not_found") {
                    requestLink(true); status("");
                } else if (error.code === "same_password") {
                    status("Choose a password different from your current password.", true);
                } else if (error.code === "weak_password") {
                    status("Use a stronger password that meets your account’s password requirements.", true);
                } else {
                    status("Could not update the password. Please try again.", true);
                }
            } finally { busy = false; save.disabled = false; }
        });
        window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
    });
})();
