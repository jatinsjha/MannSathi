
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
