/* The backend verifies identity; the browser sends only the current access token. */
(function () {
    "use strict";
    class CalendarError extends Error {
        constructor(message, status = 0) { super(message); this.status = status; }
    }
    async function request(method, query = {}, event) {
        if (new URLSearchParams(location.search).get("guest") === "true") {
            throw new CalendarError("Sign in to use your personal calendar.", 401);
        }
        let client;
        try { client = await window.supabaseReady; }
        catch { throw new CalendarError("Sign-in is unavailable. Please try again shortly.", 503); }
        const { data, error } = await client.auth.getSession();
        if (error || !data?.session?.access_token) throw new CalendarError("Sign in to use your personal calendar.", 401);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch("/api/calendar?" + new URLSearchParams(query), {
                method, cache: "no-store", signal: controller.signal,
                headers: { Authorization: "Bearer " + data.session.access_token, ...(event ? { "Content-Type": "application/json" } : {}) },
                ...(event ? { body: JSON.stringify(event) } : {})
            });
            let body;
            try { body = await response.json(); }
            catch { throw new CalendarError("The calendar server returned an unreadable response.", response.status); }
            if (!response.ok) throw new CalendarError(body.error || "Could not save or load your calendar.", response.status);
            return body;
        } catch (error) {
            if (error instanceof CalendarError) throw error;
            throw new CalendarError(error.name === "AbortError" ? "The calendar request timed out. Refresh to check whether your change was saved." : "Could not reach your calendar. Check your connection and try again.");
        } finally { clearTimeout(timer); }
    }
    window.MannSathiCalendarService = Object.freeze({
        list: async (start, end, timeZone) => (await request("GET", { start, end, time_zone: timeZone })).events,
        create: async event => (await request("POST", {}, event)).event,
        update: async (id, event) => (await request("PATCH", { id }, event)).event,
        remove: id => request("DELETE", { id })
    });
})();
