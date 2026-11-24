(function () {
    "use strict";
    const request = (action, method = "GET", body, id) => window.MannSathiAPI.request("/api/tasks", { method, query: { action, ...(id ? { id } : {}) }, ...(body !== undefined ? { body } : {}) });
    window.MannSathiTaskService = Object.freeze({
        context: () => request("context"),
        settings: () => request("settings"),
        saveSettings: body => request("settings", "PATCH", body),
        enrollments: () => request("enrollments"),
        approveEnrollment: (studentId, batchId, approve, expectedDivision) => request("enrollment", "PATCH", { student_id: studentId, batch_id: batchId, approve, expected_division: expectedDivision ?? null }),
        list: () => request("list"),
        create: body => request("create", "POST", body),
        edit: (id, body) => request("edit", "PATCH", body, id),
        status: (id, status) => request("status", "PATCH", { status }, id),
        remove: id => request("delete", "DELETE", undefined, id),
        notifications: () => request("notifications"),
        read: id => request("read", "PATCH", {}, id)
    });
})();
