
window.supabaseReady = (async function () {
    try {
        const response = await fetch("/api/config");
        const config = await response.json();

        if (!response.ok) {
            throw new Error(config.error || "Could not load Supabase configuration.");
        }

        window.supabaseClient = window.supabase.createClient(
            config.supabaseUrl,
            config.supabaseKey
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
