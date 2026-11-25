/* The backend verifies identity; the browser sends only the current access token. */
(function () {
    "use strict";
    const request = (method, query = {}, event) => window.MannSathiAPI.request("/api/calendar", {
        method, query, ...(event !== undefined ? { body: event } : {})
    });
    window.MannSathiCalendarService = Object.freeze({
        list: async (start, end, timeZone) => (await request("GET", { start, end, time_zone: timeZone })).events,
        create: async event => (await request("POST", {}, event)).event,
        update: async (id, event) => (await request("PATCH", { id }, event)).event,
        remove: id => request("DELETE", { id }),
        listExams: async (start, end, timeZone) => (await request("GET", { action: "exams", start, end, time_zone: timeZone })).events,
        createExam: async event => (await request("POST", { action: "exams" }, event)).event,
        updateExam: async (id, event) => (await request("PATCH", { action: "exams", id }, event)).event,
        removeExam: id => request("DELETE", { action: "exams", id })
    });
})();
