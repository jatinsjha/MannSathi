(function () {
    "use strict";
    const request = (action, method = "GET", body, id) => window.MannSathiAPI.request("/api/tasks", { method, query: { action, ...(id ? { id } : {}) }, ...(body !== undefined ? { body } : {}) });
    window.MannSathiTaskService = Object.freeze({
        context: () => request("context"),
        list: () => request("list"),
        create: body => request("create", "POST", body),
        edit: (id, body) => request("edit", "PATCH", body, id),
        status: (id, status) => request("status", "PATCH", { status }, id),
        remove: id => request("delete", "DELETE", undefined, id),
        notifications: () => request("notifications"),
        read: id => request("read", "PATCH", {}, id)
    });
})();
