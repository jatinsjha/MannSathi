(function () {
    const key = "mannsathi_theme";
    function apply(theme) {
        const next = theme === "light" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#efedf3" : "#080b14");
        document.querySelectorAll("[data-theme-toggle]").forEach(button => {
            button.setAttribute("aria-label", next === "dark" ? "Switch to light theme" : "Switch to dark theme");
            button.title = next === "dark" ? "Switch to light theme" : "Switch to dark theme";
        });
        document.querySelectorAll("[data-theme-choice]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.themeChoice === next)));
        try { localStorage.setItem(key, next); } catch { /* Theme still works without storage. */ }
    }
    let saved;
    try { saved = localStorage.getItem(key); } catch { /* Default to dark. */ }
    apply(saved);
    window.MannSathiTheme = { apply, toggle: () => apply(document.documentElement.dataset.theme === "dark" ? "light" : "dark") };
    document.addEventListener("DOMContentLoaded", () => {
        document.querySelectorAll("[data-theme-toggle]").forEach(button => button.addEventListener("click", window.MannSathiTheme.toggle));
        document.querySelectorAll("[data-theme-choice]").forEach(button => button.addEventListener("click", () => apply(button.dataset.themeChoice)));
        apply(document.documentElement.dataset.theme);
    });
})();
