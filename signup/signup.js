
const signupForm = document.getElementById("signup-form");

const fullNameInput = document.getElementById("full-name");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const confirmPasswordInput = document.getElementById("confirm-password");

const message = document.getElementById("form-message");
const signupButton = signupForm.querySelector(".login-button");

// Show or hide passwords
document.querySelectorAll(".toggle-password").forEach(function (button) {
    button.addEventListener("click", function () {
        const target = document.getElementById(button.dataset.target);

        const isPassword = target.type === "password";

        target.type = isPassword ? "text" : "password";
        button.textContent = isPassword ? "Hide" : "Show";

        button.setAttribute(
            "aria-label",
            isPassword ? "Hide password" : "Show password"
        );
    });
});

// Display messages
function showMessage(text, isError) {
    message.textContent = text;
    message.classList.toggle("error", isError);
}

// Signup form
signupForm.addEventListener("submit", function (event) {
    event.preventDefault();

    const fullName = fullNameInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    message.textContent = "";
    message.classList.remove("error");

    if (!fullName || !email || !password || !confirmPassword) {
        showMessage("Please fill in all fields.", true);
        return;
    }

    if (password.length < 8) {
        showMessage("Password must contain at least 8 characters.", true);
        return;
    }

    if (password !== confirmPassword) {
        showMessage("Passwords do not match.", true);
        return;
    }

    signupButton.disabled = true;
    signupButton.innerHTML = "Please wait...";

    // Supabase registration will be connected later.
    setTimeout(function () {
        showMessage(
            "Signup UI is working! Supabase registration is not connected yet.",
            false
        );

        signupButton.disabled = false;
        signupButton.innerHTML = 'Create account <span>→</span>';
    }, 700);
});
// Continue as guest
document.getElementById("guest-login").addEventListener("click", function () {
    window.location.href = "index.html?guest=true";
});