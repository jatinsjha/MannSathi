/* Shared view navigation keeps workspace panels mutually exclusive. */
(function () {
    "use strict";
    let current = "dashboard";
    const panels = { dashboard: "dashboard-panel", chat: "chat-area", calendar: "calendar-panel", tasks: "tasks-panel", focus: "focus-panel", admin: "admin-panel" };
    function show(view) {
        if (!panels[view] || (typeof canNavigate === "function" && !canNavigate())) return false;
        for (const [name, id] of Object.entries(panels)) {
            const panel = document.getElementById(id), button = document.getElementById("open-" + name);
            if (panel) panel.hidden = name !== view;
            if (button) { if (name === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); }
        }
        document.querySelector(".composer-wrap").hidden = view !== "chat";
        document.getElementById("conversation-title").hidden = view !== "chat";
        const skip = document.querySelector(".skip-link");
        skip.href = "#" + ({ dashboard: "dashboard-heading", chat: "message-input", calendar: "calendar-create", tasks: "tasks-create", focus: "focus-start", admin: "admin-heading" })[view];
        skip.textContent = "Skip to " + view;
        current = view;
        if (typeof closeSidebar === "function") closeSidebar();
        window.dispatchEvent(new CustomEvent("mannsathi:view", { detail: view }));
        return true;
    }
    window.MannSathiWorkspace = Object.freeze({ show, get current() { return current; } });
    const card = document.querySelector(".app-card"), toggle = document.getElementById("sidebar-toggle");
    function collapseSidebar(collapsed) {
        card.classList.toggle("sidebar-collapsed", collapsed);
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
        toggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    }
    try { collapseSidebar(localStorage.getItem("mannsathi-sidebar-collapsed") === "true"); } catch { collapseSidebar(false); }
    toggle.addEventListener("click", () => {
        const collapsed = !card.classList.contains("sidebar-collapsed");
        collapseSidebar(collapsed);
        try { localStorage.setItem("mannsathi-sidebar-collapsed", String(collapsed)); } catch { /* Still works when browser storage is disabled. */ }
    });
    document.getElementById("open-dashboard").addEventListener("click", () => show("dashboard"));
})();
