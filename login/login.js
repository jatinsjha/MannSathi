
const loginForm = document.getElementById("login-form");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const togglePassword = document.getElementById("toggle-password");
const message = document.getElementById("form-message");
const loginButton = document.querySelector(".login-button");

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

// Demo login form
loginForm.addEventListener("submit", function (event) {
    event.preventDefault();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    message.textContent = "";
    message.classList.remove("error");

    if (!email || !password) {
        showMessage("Please fill in all fields.", true);
        return;
    }

    if (password.length < 6) {
        showMessage("Password must be at least 6 characters.", true);
        return;
    }

    // Authentication will be connected using Supabase later.
    loginButton.disabled = true;
    loginButton.innerHTML = "Please wait...";

    setTimeout(function () {
        showMessage(
            "Login UI is working! Supabase authentication is not connected yet.",
            false
        );

        loginButton.disabled = false;
        loginButton.innerHTML = 'Sign in <span>→</span>';
    }, 700);
});

// Display messages
function showMessage(text, isError) {
    message.textContent = text;
    message.classList.toggle("error", isError);
}

// Forgot password placeholder
document.getElementById("forgot-password").addEventListener("click", function (event) {
    event.preventDefault();

    showMessage(
        "Password recovery will be available after Supabase integration.",
        false
    );
});
