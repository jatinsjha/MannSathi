/* Shared authenticated HTTP transport; identity/permissions are verified by Python. */
(function () {
    "use strict";
    class ApiError extends Error {
        constructor(message, status = 0) { super(message); this.status = status; }
    }
    let identityVersion = 0, lastUser = null;
    if (window.supabaseReady) window.supabaseReady.then(client => {
        if (typeof client.auth.onAuthStateChange !== "function") return;
        client.auth.onAuthStateChange((event, session) => {
            const user = session?.user?.id || null;
            if (user !== lastUser || event === "SIGNED_OUT") { lastUser = user; identityVersion++; }
        });
    }).catch(() => {});
    async function request(path, { method = "GET", query = {}, body } = {}) {
        const identity = identityVersion;
        if (new URLSearchParams(location.search).get("guest") === "true") throw new ApiError("Sign in to use your personal workspace.", 401);
        let client;
        try { client = await window.supabaseReady; }
        catch { throw new ApiError("Sign-in is unavailable. Please try again shortly.", 503); }
        let session;
        try {
            const result = await client.auth.getSession();
            if (result.error) throw result.error;
            session = result.data?.session;
        } catch { throw new ApiError("Please sign in again to use your workspace.", 401); }
        if (!session?.access_token) throw new ApiError("Sign in to use your personal workspace.", 401);
        if (identity !== identityVersion) throw new ApiError("Your account changed. Refresh before saving or loading data.", 401);
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(path + "?" + new URLSearchParams(query), {
                method, cache: "no-store", signal: controller.signal,
                headers: { Authorization: "Bearer " + session.access_token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {})
            });
            let data;
            try { data = await response.json(); } catch { throw new ApiError("The workspace server returned an unreadable response.", response.status); }
            if (!response.ok) throw new ApiError(data.error || "Could not save or load your workspace.", response.status);
            return data;
        } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(error.name === "AbortError" ? "This request timed out. Refresh to check whether your change was saved." : "Could not reach your workspace. Check your connection and try again.");
        } finally { clearTimeout(timer); }
    }
    window.MannSathiAPI = Object.freeze({ request, ApiError });
})();
