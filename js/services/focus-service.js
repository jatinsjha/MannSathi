(function () {
    "use strict";
    const request = (action, method = "GET", body, query = {}) => window.MannSathiAPI.request("/api/focus", { method, query: { action, ...query }, ...(body !== undefined ? { body } : {}) });
    window.MannSathiFocusService = Object.freeze({
        subjects: () => request("subjects"), state: () => request("state"),
        summary: time_zone => request("summary", "GET", undefined, { time_zone }),
        createSubject: body => request("subject", "POST", body),
        editSubject: (id, body) => request("subject", "PATCH", body, { id }),
        savePreferences: body => request("prefs", "PATCH", body),
        start: body => request("start", "POST", body),
        transition: (id, action) => request(action, "PATCH", {}, { id })
    });
})();
