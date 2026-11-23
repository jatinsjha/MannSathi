
/* ============================================================
   MannSathi — Signup Page JavaScript
   ============================================================ */

const signupForm           = document.getElementById("signup-form");
const fullNameInput        = document.getElementById("full-name");
const emailInput           = document.getElementById("email");
const passwordInput        = document.getElementById("password");
const confirmPasswordInput = document.getElementById("confirm-password");
const message              = document.getElementById("form-message");
const signupButton         = signupForm.querySelector(".login-button");

// ── Helpers ─────────────────────────────────────────────────

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function setMessage(text, isError = false) {
    message.textContent = text;
    message.className = "form-message" + (isError ? " error" : "");
    void message.offsetWidth; // force reflow for animation restart
    message.className = "form-message" + (isError ? " error" : "");
}

function setInputState(input, state) {
    input.classList.remove("input-error", "input-success");
    if (state === "error")   input.classList.add("input-error");
    if (state === "success") input.classList.add("input-success");
}

function setHint(input, text, type) {
    // Find or create a sibling hint element
    let hint = input.closest(".form-group")?.querySelector(".field-hint");
    if (!hint) {
        hint = document.createElement("div");
        hint.className = "field-hint";
        input.closest(".form-group")?.appendChild(hint);
    }
    hint.textContent = text;
    hint.className = "field-hint" + (type ? " " + type : "");
}

function setLoading(isLoading) {
    signupButton.disabled = isLoading;
    if (isLoading) {
        signupButton.classList.add("loading");
        signupButton.dataset.originalHtml = signupButton.innerHTML;
    } else {
        signupButton.classList.remove("loading");
        signupButton.innerHTML = signupButton.dataset.originalHtml
            || 'Create account <span>→</span>';
    }
}

// ── Password strength meter ───────────────────────────────────

function getStrength(pwd) {
    let score = 0;
    if (pwd.length >= 8)  score++;
    if (pwd.length >= 12) score++;
    if (/[A-Z]/.test(pwd)) score++;
    if (/[0-9]/.test(pwd)) score++;
    if (/[^A-Za-z0-9]/.test(pwd)) score++;
    if (score <= 1) return { level: "weak",   label: "Weak" };
    if (score <= 3) return { level: "medium", label: "Medium" };
    return { level: "strong", label: "Strong" };
}

function buildStrengthIndicator() {
    const wrapper = document.createElement("div");
    wrapper.className = "password-strength";
    wrapper.id = "strength-indicator";
    wrapper.innerHTML = `
      <div class="password-strength-bar">
        <div class="password-strength-fill"></div>
      </div>
      <div class="strength-label"></div>
    `;
    // Insert after password-wrapper
    const pwWrapper = passwordInput.closest(".password-wrapper") || passwordInput.parentElement;
    pwWrapper.after(wrapper);
    return wrapper;
}

const strengthIndicator = buildStrengthIndicator();

function updateStrength(pwd) {
    if (!pwd) {
        strengthIndicator.className = "password-strength";
        strengthIndicator.querySelector(".strength-label").textContent = "";
        return;
    }
    const { level, label } = getStrength(pwd);
    strengthIndicator.className = `password-strength strength-${level}`;
    strengthIndicator.querySelector(".strength-label").textContent = `Password strength: ${label}`;
}

// ── Password toggle ───────────────────────────────────────────

document.querySelectorAll(".toggle-password").forEach(function (button) {
    button.addEventListener("click", function () {
        const target = document.getElementById(button.dataset.target);
        const isPassword = target.type === "password";
        target.type = isPassword ? "text" : "password";
        button.textContent = isPassword ? "Hide" : "Show";
        button.setAttribute("aria-pressed", String(isPassword));
        button.setAttribute(
            "aria-label",
            isPassword ? "Hide password" : "Show password"
        );
    });
});

// ── Real-time validation ──────────────────────────────────────

fullNameInput.addEventListener("input", function () {
    const val = fullNameInput.value.trim();
    if (!val) {
        setInputState(fullNameInput, null);
        setHint(fullNameInput, "");
        return;
    }
    if (val.length < 2) {
        setInputState(fullNameInput, "error");
        setHint(fullNameInput, "Name is too short", "error");
    } else {
        setInputState(fullNameInput, "success");
        setHint(fullNameInput, "");
    }
});

emailInput.addEventListener("input", function () {
    const val = emailInput.value.trim();
    if (!val) {
        setInputState(emailInput, null);
        setHint(emailInput, "");
        return;
    }
    if (isValidEmail(val)) {
        setInputState(emailInput, "success");
        setHint(emailInput, "");
    } else {
        setInputState(emailInput, "error");
        setHint(emailInput, "Please enter a valid email", "error");
    }
});

passwordInput.addEventListener("input", function () {
    const val = passwordInput.value;
    updateStrength(val);

    if (!val) {
        setInputState(passwordInput, null);
        return;
    }
    if (val.length < 8) {
        setInputState(passwordInput, "error");
    } else {
        setInputState(passwordInput, "success");
    }

    // Also re-check confirm
    if (confirmPasswordInput.value) {
        checkPasswordMatch();
    }
});

function checkPasswordMatch() {
    const pwd     = passwordInput.value;
    const confirm = confirmPasswordInput.value;
    if (!confirm) {
        setInputState(confirmPasswordInput, null);
        setHint(confirmPasswordInput, "");
        return;
    }
    if (pwd === confirm) {
        setInputState(confirmPasswordInput, "success");
        setHint(confirmPasswordInput, "Passwords match ✓", "success");
    } else {
        setInputState(confirmPasswordInput, "error");
        setHint(confirmPasswordInput, "Passwords do not match", "error");
    }
}

confirmPasswordInput.addEventListener("input", checkPasswordMatch);

// ── Signup form submit ────────────────────────────────────────

signupForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    const fullName       = fullNameInput.value.trim();
    const email          = emailInput.value.trim();
    const password       = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    setMessage("");

    // Validation
    let valid = true;

    if (!fullName) {
        setInputState(fullNameInput, "error");
        valid = false;
    }

    if (!email || !isValidEmail(email)) {
        setInputState(emailInput, "error");
        valid = false;
    }

    if (!password || password.length < 8) {
        setInputState(passwordInput, "error");
        valid = false;
    }

    if (!confirmPassword || password !== confirmPassword) {
        setInputState(confirmPasswordInput, "error");
        valid = false;
    }

    if (!valid) {
        setMessage("Please fill in all fields correctly.", true);
        return;
    }

    setLoading(true);

    try {
        const supabaseClient = await window.supabaseReady;

        const { data, error } = await supabaseClient.auth.signUp({
            email:    email,
            password: password,
            options: {
                data: {
                    full_name: fullName
                },
                emailRedirectTo: window.location.origin + "/index.html"
            }
        });

        if (error) throw error;

        if (data.session) {
            setMessage("Account created successfully! Opening MannSathi...");
            window.location.href = "app.html";
        } else {
            setMessage(
                "Account created! Please check your email and verify your account before signing in."
            );
            signupForm.reset();
            updateStrength("");
            [fullNameInput, emailInput, passwordInput, confirmPasswordInput].forEach(
                el => setInputState(el, null)
            );
        }

    } catch (error) {
        console.error("Signup error:", error);
        setMessage(error.message || "Signup failed. Please try again.", true);

    } finally {
        setLoading(false);
    }
});

// ── Continue as guest ─────────────────────────────────────────

document.getElementById("guest-login").addEventListener("click", function () {
    window.location.href = "app.html?guest=true";
});
