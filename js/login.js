
const loginForm = document.getElementById("login-form");

const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");

const message = document.getElementById("form-message");
const loginButton = loginForm.querySelector(".login-button");
const forgotPassword = document.getElementById("forgot-password");
const togglePassword = document.getElementById("toggle-password");

// Display messages
function showMessage(text, isError = false) {
    message.textContent = text;
    message.classList.toggle("error", isError);
}

// Show or hide password
togglePassword.addEventListener("click", function () {
    const isPassword = passwordInput.type === "password";

    passwordInput.type = isPassword ? "text" : "password";
    togglePassword.textContent = isPassword ? "Hide" : "Show";

    togglePassword.setAttribute(
        "aria-label",
        isPassword ? "Hide password" : "Show password"
    );
});

// Login form
loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    showMessage("");

    if (!email || !password) {
        showMessage("Please enter your email and password.", true);
        return;
    }

    loginButton.disabled = true;
    loginButton.textContent = "Signing in...";

    try {
        // Wait for Supabase initialization
        const supabaseClient = await window.supabaseReady;

        // Sign in user
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) {
            throw error;
        }

        if (!data.session) {
            throw new Error("Login failed. Please try again.");
        }

        showMessage("Login successful! Opening MannSathi...");

        window.location.href = "app.html";

    } catch (error) {
        console.error("Login error:", error);

        showMessage(
            error.message || "Unable to sign in. Please try again.",
            true
        );

    } finally {
        loginButton.disabled = false;
        loginButton.innerHTML = 'Sign in <span>→</span>';
    }
});

// Forgot password
forgotPassword.addEventListener("click", async function (event) {
    event.preventDefault();

    const email = emailInput.value.trim();

    if (!email) {
        showMessage("Please enter your email address first.", true);
        emailInput.focus();
        return;
    }

    try {
        showMessage("Sending password reset email...");

        const supabaseClient = await window.supabaseReady;

        const { error } = await supabaseClient.auth.resetPasswordForEmail(
            email,
            {
                redirectTo: window.location.origin + "/index.html"
            }
        );

        if (error) {
            throw error;
        }

        showMessage("Password reset link sent! Please check your email.");

    } catch (error) {
        console.error("Password reset error:", error);
        showMessage(error.message || "Could not send reset email.", true);
    }
});
