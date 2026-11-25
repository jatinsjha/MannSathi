/* Shared view navigation keeps workspace panels mutually exclusive. */
(function () {
    "use strict";
    let current = "chat";
    const panels = { chat: "chat-area", calendar: "calendar-panel", tasks: "tasks-panel", focus: "focus-panel" };
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
        skip.href = "#" + ({ chat: "message-input", calendar: "calendar-create", tasks: "tasks-create", focus: "focus-start" })[view];
        skip.textContent = "Skip to " + view;
        current = view;
        if (typeof closeSidebar === "function") closeSidebar();
        window.dispatchEvent(new CustomEvent("mannsathi:view", { detail: view }));
        return true;
    }
    window.MannSathiWorkspace = Object.freeze({ show, get current() { return current; } });
})();
