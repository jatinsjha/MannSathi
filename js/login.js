
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

// ── Check if already logged in ───────────────────────────────

(async function checkSession() {
    try {
        const supabaseClient = await window.supabaseReady;
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            window.location.href = "app.html";
        }
    } catch (_) {
        // Not logged in or Supabase unavailable — stay on page
    }
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
    // Eye icon: 👁 / 🙈 unicode trick via text node
    togglePassword.textContent = isPassword ? "🙈" : "👁";
    togglePassword.setAttribute(
        "aria-label",
        isPassword ? "Hide password" : "Show password"
    );
});

// ── Login form submit ─────────────────────────────────────────

loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    const email    = emailInput.value.trim();
    const password = passwordInput.value;

    setMessage("");

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

forgotPassword.addEventListener("click", async function (event) {
    event.preventDefault();

    const email = emailInput.value.trim();

    if (!email) {
        setMessage("Please enter your email address first.", true);
        setInputState(emailInput, "error");
        emailInput.focus();
        return;
    }

    if (!isValidEmail(email)) {
        setMessage("Please enter a valid email address.", true);
        setInputState(emailInput, "error");
        return;
    }

    forgotPassword.style.pointerEvents = "none";
    forgotPassword.style.opacity = "0.6";

    try {
        setMessage("Sending password reset email...");

        const supabaseClient = await window.supabaseReady;

        const { error } = await supabaseClient.auth.resetPasswordForEmail(
            email,
            {
                redirectTo: window.location.origin + "/index.html"
            }
        );

        if (error) throw error;

        setMessage("Password reset link sent! Please check your email.");
        setInputState(emailInput, "success");

    } catch (error) {
        console.error("Password reset error:", error);
        setMessage(error.message || "Could not send reset email.", true);
    } finally {
        forgotPassword.style.pointerEvents = "";
        forgotPassword.style.opacity = "";
    }
});
