/* Shared authenticated HTTP transport; identity/permissions are verified by Python. */
(function () {
    "use strict";
    class ApiError extends Error {
        constructor(message, status = 0, data = null) { super(message); this.status = status; this.data = data; }
    }
    let identityVersion = 0, lastUser = null;
    if (window.supabaseReady) window.supabaseReady.then(client => {
        if (typeof client.auth.onAuthStateChange !== "function") return;
        client.auth.onAuthStateChange((event, session) => {
            const user = session?.user?.id || null;
            if (user !== lastUser || event === "SIGNED_OUT") { lastUser = user; identityVersion++; }
        });
    }).catch(() => {});
    async function bearerHeaders(identity, expectedUserId) {
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
        if (identity !== identityVersion || (expectedUserId !== undefined && session.user?.id !== expectedUserId)) {
            throw new ApiError("Your account changed. Refresh before saving or loading data.", 401);
        }
        return { Authorization: "Bearer " + session.access_token };
    }
    async function request(path, { method = "GET", query = {}, body, responseType = "json", expectedUserId } = {}) {
        const identity = identityVersion;
        const guest = new URLSearchParams(location.search).get("guest") === "true";
        const chat = path === "/api/chat";
        if (guest && !chat) throw new ApiError("Sign in to use your personal workspace.", 401);
        const auth = guest ? {} : await bearerHeaders(identity, expectedUserId);
        if (!guest && identity !== identityVersion) throw new ApiError("Your account changed during the request.", 401);
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), chat ? 90000 : 30000);
        try {
            const response = await fetch(path + "?" + new URLSearchParams(query), {
                method, cache: "no-store", signal: controller.signal,
                headers: { ...auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {})
            });
            if (response.ok && responseType === "csv") {
                if (!response.headers.get("Content-Type")?.startsWith("text/csv")) throw new ApiError("The server did not return a CSV file.");
                const file = await response.blob();
                if (identity !== identityVersion) throw new ApiError("Your account changed during the export.", 401);
                return file;
            }
            let data;
            try { data = await response.json(); } catch { throw new ApiError("The workspace server returned an unreadable response.", response.status); }
            if (identity !== identityVersion) throw new ApiError("Your account changed during the request.", 401);
            if (!response.ok) throw new ApiError(data.error || "Could not save or load your workspace.", response.status, data);
            return data;
        } catch (error) {
            if (error instanceof ApiError) throw error;
            if (chat) throw new ApiError("The chat connection was interrupted. Use Try again to check this request.");
            throw new ApiError(error.name === "AbortError" ? "This request timed out. Refresh to check whether your change was saved." : "Could not reach your workspace. Check your connection and try again.");
        } finally { clearTimeout(timer); }
    }
    window.MannSathiAPI = Object.freeze({ request, ApiError });
})();
