
window.supabaseReady = (async function () {
    try {
        const path = window.location.pathname;
        const recovering = path.endsWith("/recover.html");
        if (!recovering) {
            // Older reset emails can still point to the original sign-in page.
            // Forward before the ordinary client has a chance to save that session.
            const fragment = new URLSearchParams(window.location.hash.slice(1));
            const query = new URLSearchParams(window.location.search);
            if (fragment.get("type") === "recovery" || query.get("type") === "recovery") {
                const destination = new URL("/recover.html", window.location.origin);
                if (path.endsWith("/teacher-login.html")) destination.searchParams.set("role", "teacher");
                for (const name of ["type", "access_token", "refresh_token", "token_hash", "error", "error_code"]) {
                    const value = fragment.get(name) || query.get(name);
                    if (value) fragment.set(name, value);
                }
                destination.hash = fragment.toString();
                window.location.replace(destination.href);
                return new Promise(() => {});
            }
        }
        const response = await fetch("/api/config");
        const config = await response.json();

        if (!response.ok) {
            throw new Error(config.error || "Could not load Supabase configuration.");
        }

        window.supabaseClient = window.supabase.createClient(
            config.supabaseUrl,
            config.supabaseKey,
            recovering ? { auth: {
                storageKey: "mannsathi-password-recovery",
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false
            } } : undefined
        );

        console.log("Supabase initialized successfully.");

        return window.supabaseClient;

    } catch (error) {
        console.error("Supabase initialization failed:", error);
        throw error;
    }
})();

// Guest browsing remains available if authentication cannot initialize.
// Keep the original promise rejected so forms can display their error state.
window.supabaseReady.catch(() => {});
