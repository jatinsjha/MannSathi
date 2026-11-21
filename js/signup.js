
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
function showMessage(text, isError = false) {
    message.textContent = text;
    message.classList.toggle("error", isError);
}

// Signup form
signupForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    const fullName = fullNameInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    showMessage("");

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
    signupButton.textContent = "Creating account...";

    try {
        // Wait for Supabase initialization
        const supabaseClient = await window.supabaseReady;

        // Create account
        const { data, error } = await supabaseClient.auth.signUp({
            email: email,
            password: password,
            options: {
                data: {
                    full_name: fullName
                },
                emailRedirectTo: window.location.origin + "/index.html"
            }
        });

        if (error) {
            throw error;
        }

        if (data.session) {
            showMessage("Account created successfully! Opening MannSathi...");

            window.location.href = "app.html";
        } else {
            showMessage(
                "Account created! Please check your email and verify your account before signing in."
            );

            signupForm.reset();
        }

    } catch (error) {
        console.error("Signup error:", error);

        showMessage(
            error.message || "Signup failed. Please try again.",
            true
        );

    } finally {
        signupButton.disabled = false;
        signupButton.innerHTML = 'Create account <span>→</span>';
    }
});

// Continue as guest
document.getElementById("guest-login").addEventListener("click", function () {
    window.location.href = "app.html?guest=true";
});
