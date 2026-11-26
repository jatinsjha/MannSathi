
/* ============================================================
   MannSathi — Login Page JavaScript
   ============================================================ */

const loginForm    = document.getElementById("login-form");
const emailInput   = document.getElementById("email");
const passwordInput = document.getElementById("password");
const message      = document.getElementById("form-message");
const loginButton  = loginForm.querySelector(".login-button");
const forgotPassword = document.getElementById("forgot-password");
const togglePassword = document.getElementById("toggle-password");
const expectedLoginRole = document.body.dataset.loginRole === "teacher" ? "teacher" : "student";
const roleLoginLink = document.getElementById("role-login-message-link");

// ── Helpers ─────────────────────────────────────────────────

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function showMessage(text, isError = false) {
    // Reset animation by cloning
    const clone = message.cloneNode(false);
    clone.textContent = text;
    clone.classList.toggle("error", isError);
    message.parentNode.replaceChild(clone, message);
    // Re-assign reference
    Object.defineProperty(window, "_msgEl", { value: clone, writable: true });
}

// Simpler showMessage — works without clone trick
function setMessage(text, isError = false) {
    message.textContent = text;
    message.className = "form-message" + (isError ? " error" : "");
    // Force reflow so animation restarts
    void message.offsetWidth;
    message.className = "form-message" + (isError ? " error" : "");
}

function setInputState(input, state) {
    input.classList.remove("input-error", "input-success");
    if (state === "error")   input.classList.add("input-error");
    if (state === "success") input.classList.add("input-success");
}

function setLoading(isLoading) {
    loginButton.disabled = isLoading;
    if (isLoading) {
        loginButton.classList.add("loading");
        loginButton.dataset.originalHtml = loginButton.innerHTML;
    } else {
        loginButton.classList.remove("loading");
        loginButton.innerHTML = loginButton.dataset.originalHtml || 'Sign in <span>→</span>';
    }
}

// The selected sign-in page never grants a role. The verified backend context
// reads college-managed permissions after Supabase has authenticated the user.
async function verifyLoginRole(supabaseClient, session) {
    if (!session?.access_token) throw new Error("Login failed. Please try again.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let context;
    try {
        const response = await fetch("/api/tasks?action=context", {
            headers: { Authorization: "Bearer " + session.access_token },
            cache: "no-store", signal: controller.signal
        });
        try { context = await response.json(); }
        catch { throw new Error("Could not verify your account access. Please try again shortly."); }
        if (!response.ok) throw new Error(context.error || "Could not verify your account access. Please try again shortly.");
        if (!["student", "teacher"].includes(context.role)) throw new Error("Could not verify your account access. Please try again shortly.");
    } catch (error) {
        if (error.name === "AbortError") throw new Error("Account verification timed out. Please try again.");
        throw error;
    } finally { clearTimeout(timeout); }
    if (context.role !== expectedLoginRole) {
        const { error } = await supabaseClient.auth.signOut();
        if (error) throw new Error("Could not close this session. Please sign out before switching accounts.");
        if (roleLoginLink) roleLoginLink.hidden = false;
        throw new Error(expectedLoginRole === "teacher"
            ? "This account does not have approved teacher access. Use student sign in, or contact your college."
            : "This is a teacher account. Please use teacher sign in.");
    }
    return context;
}

// ── Check if already logged in ───────────────────────────────

(async function checkSession() {
    if (new URLSearchParams(window.location.search).get("recovered") === "1") {
        setMessage("Password updated. Sign in with your new password.");
        return;
    }
    let foundSession = false;
    setLoading(true);
    try {
        const supabaseClient = await window.supabaseReady;
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error) throw error;
        if (session) {
            foundSession = true;
            await verifyLoginRole(supabaseClient, session);
            window.location.href = "app.html";
        }
    } catch (error) {
        // An unavailable client leaves the sign-in form usable. Existing
        // sessions must pass backend access verification before redirecting.
        if (foundSession) setMessage(error.message || "Could not verify your account access.", true);
    } finally { setLoading(false); }
})();

// ── Real-time email validation ───────────────────────────────

emailInput.addEventListener("input", function () {
    const val = emailInput.value.trim();
    if (!val) {
        setInputState(emailInput, null);
        return;
    }
    setInputState(emailInput, isValidEmail(val) ? "success" : "error");
});

emailInput.addEventListener("blur", function () {
    const val = emailInput.value.trim();
    if (val && !isValidEmail(val)) {
        setMessage("Please enter a valid email address.", true);
    }
});

// ── Password toggle ──────────────────────────────────────────

togglePassword.addEventListener("click", function () {
    const isPassword = passwordInput.type === "password";
    passwordInput.type = isPassword ? "text" : "password";
    togglePassword.textContent = isPassword ? "Hide" : "Show";
    togglePassword.setAttribute("aria-pressed", String(isPassword));
    togglePassword.setAttribute(
        "aria-label",
        isPassword ? "Hide password" : "Show password"
    );
});

// ── Login form submit ─────────────────────────────────────────

loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (loginButton.disabled) return;

    const email    = emailInput.value.trim();
    const password = passwordInput.value;

    setMessage("");
    if (roleLoginLink) roleLoginLink.hidden = true;

    if (!email || !password) {
        setMessage("Please enter your email and password.", true);
        if (!email) setInputState(emailInput, "error");
        if (!password) setInputState(passwordInput, "error");
        return;
    }

    if (!isValidEmail(email)) {
        setMessage("Please enter a valid email address.", true);
        setInputState(emailInput, "error");
        return;
    }

    setLoading(true);

    try {
        const supabaseClient = await window.supabaseReady;

        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email:    email,
            password: password
        });

        if (error) throw error;

        if (!data.session) {
            throw new Error("Login failed. Please try again.");
        }

        setMessage("Verifying your account access…");
        await verifyLoginRole(supabaseClient, data.session);
        setMessage("Login successful! Opening MannSathi...");
        setInputState(emailInput, "success");
        setInputState(passwordInput, "success");

        window.location.href = "app.html";

    } catch (error) {
        console.error("Login error:", error);
        setMessage(error.message || "Unable to sign in. Please try again.", true);
        setInputState(passwordInput, "error");

    } finally {
        setLoading(false);
    }
});

// ── Forgot password ───────────────────────────────────────────

let sendingReset = false;
forgotPassword.addEventListener("click", async function (event) {
    if (sendingReset) { event.preventDefault(); return; }
    const email = emailInput.value.trim();
    if (!email) return; // Follow the role-specific link to the recovery form.
    event.preventDefault();
    if (!isValidEmail(email)) {
        setMessage("Please enter a valid email address.", true);
        setInputState(emailInput, "error");
        return;
    }

    sendingReset = true;
    forgotPassword.setAttribute("aria-disabled", "true");

    try {
        setMessage("Sending password reset email...");

        const supabaseClient = await window.supabaseReady;

        const { error } = await supabaseClient.auth.resetPasswordForEmail(
            email,
            {
                redirectTo: window.location.origin + "/recover.html" + (expectedLoginRole === "teacher" ? "?role=teacher" : "")
            }
        );

        if (error && error.code !== "user_not_found") throw error;

        setMessage("If this email belongs to a MannSathi account, check your inbox for a reset link.");
        setInputState(emailInput, "success");

    } catch (error) {
        setMessage(error.status === 429 ? "Too many reset requests. Please try again later." : "Could not send the reset email. Please try again.", true);
    } finally {
        sendingReset = false;
        forgotPassword.setAttribute("aria-disabled", "false");
    }
});
