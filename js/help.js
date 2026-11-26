/* Public help topics and the workspace flyout share the same articles. */
(() => {
    "use strict";
    const $ = id => document.getElementById(id);
    const dialog = $("help-dialog"), menu = $("help-menu"), trigger = $("account-help");
    const publicPage = !dialog;
    const topics = new Set([...document.querySelectorAll(publicPage ? ".help-index [data-help-topic]" : "#help-menu [data-help-topic]")].map(a => a.dataset.helpTopic));
    const pendingRequests = new WeakMap();
    let articles, request = 0, returnFocus;

    function closeHelpMenu(focus = false) {
        menu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        if (focus) trigger.focus();
    }
    function showMenu() {
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        menu.querySelector("a").focus();
    }
    async function openTopic(id) {
        if (!topics.has(id)) return;
        const version = ++request;
        const heading = $("help-title"), content = $("help-content");
        heading.textContent = menu.querySelector('[data-help-topic="'+id+'"]').textContent.replace('Ctrl+/','').trim();
        dialog.classList.toggle("download-dialog", id === "download-apps");
        if (!dialog.open) {
            returnFocus = window.innerWidth <= 760 ? $("mobile-menu") : $("user-profile-card");
            openDialog("help-dialog");
        }
        heading.focus({preventScroll:true});
        content.textContent = "Loading…";
        try {
            if (!articles) articles = fetch("help.html", {credentials:"same-origin"}).then(async response => {
                if (!response.ok) throw Error();
                return new DOMParser().parseFromString(await response.text(), "text/html");
            }).catch(error => { articles = null; throw error; });
            const doc = await articles;
            if (version !== request || !dialog.open) return;
            const source = doc.getElementById(id);
            if (!source?.classList.contains("help-article")) throw Error();
            const children = [...source.children].filter(el => el.tagName !== "H2").map(el => document.importNode(el, true));
            content.replaceChildren(...children);
            for (const reset of content.querySelectorAll('a[href="recover.html"]')) {
                if (typeof accountRole !== "undefined" && accountRole === "teacher") reset.href = "recover.html?role=teacher";
                reset.target = "_blank";
                reset.rel = "noopener";
                reset.setAttribute("aria-label", "Reset my password (opens in a new tab)");
            }
            const controls = content.querySelector("[data-chat-controls]");
            if (controls) controls.hidden = false;
            dialog.scrollTop = 0;
        } catch {
            if (version !== request || !dialog.open) return;
            const link = document.createElement("a"); link.href = "help.html#"+id; link.target = "_blank"; link.rel = "noopener";
            link.textContent = "Open the help page in a new tab";
            content.replaceChildren("Help could not load. ",link);
        }
    }
    function selectPublic(focus = false) {
        const id = location.hash.slice(1);
        const selected = topics.has(id) ? id : "help-center";
        document.querySelectorAll(".help-body > section").forEach(section => { section.hidden = section.id !== selected; });
        document.querySelectorAll(".help-index a").forEach(a => {
            if (a.dataset.helpTopic === selected) a.setAttribute("aria-current","page"); else a.removeAttribute("aria-current");
        });
        const title = $(selected).querySelector("h2");
        document.title = title.textContent+" | MannSathi";
        if (focus) title.focus({preventScroll:true});
    }
    if (publicPage) {
        selectPublic(); window.addEventListener("hashchange",() => selectPublic(true));
    } else {
        trigger.addEventListener("click", () => menu.hidden ? showMenu() : closeHelpMenu(true));
        trigger.addEventListener("keydown", e => { if (e.key === "ArrowRight") {e.preventDefault(); showMenu();} });
        $("account-menu").addEventListener("focusin", e => { if (e.target !== trigger && !menu.hidden) closeHelpMenu(); });
        menu.addEventListener("click", e => { if (e.target.closest("[data-help-back]")) closeHelpMenu(true); });
        menu.addEventListener("keydown", e => {
            const items = [...menu.querySelectorAll('[role="menuitem"]')].filter(item => item.getClientRects().length);
            const i = items.indexOf(document.activeElement);
            if (e.key === "Escape" || e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); closeHelpMenu(true); }
            else if (e.key === "Tab") { closeAccountMenu(true); }
            else if (e.key === " " && e.target.matches("a")) {e.preventDefault(); e.target.click();}
            else if (["ArrowUp","ArrowDown","Home","End"].includes(e.key)) {
                e.preventDefault(); e.stopPropagation();
                const next = e.key === "Home" ? 0 : e.key === "End" ? items.length-1 : (i+items.length+(e.key === "ArrowUp" ? -1 : 1)) % items.length;
                items[next].focus();
            }
        });
        document.addEventListener("click", e => {
            const a = e.target.closest("[data-help-topic]");
            if (a && (menu.contains(a) || dialog.contains(a))) {e.preventDefault(); openTopic(a.dataset.helpTopic);}
            if (e.target.closest("[data-chat-controls]")) {
                dialog.close(); document.querySelector('[data-open-settings="appearance"]').click();
                $("settings-clear-history").focus();
            }
        });
        document.addEventListener("keydown", e => {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "/" && !e.repeat && !document.querySelector("dialog[open]:not(#help-dialog)")) {
                e.preventDefault(); openTopic("keyboard-shortcuts");
            }
        });
        dialog.addEventListener("close", () => {
            if (dialog.open) return;
            ++request; $("help-content").replaceChildren();
            if (!document.querySelector("dialog[open]")) returnFocus?.focus({preventScroll:true});
        });
    }
    document.addEventListener("submit", async e => {
        const form = e.target;
        if (!form.matches("form[data-support-kind]")) return;
        e.preventDefault();
        const button = form.querySelector("[type=submit]"), status = form.querySelector("[role=status]");
        if (button.disabled || !form.reportValidity()) return;
        const details = form.elements.detail.value.trim(), email = form.elements.email.value.trim();
        if (details.length < 10) {status.textContent="Add at least 10 characters of detail."; form.elements.detail.focus(); return;}
        const previous = pendingRequests.get(form);
        const submission = previous?.detail === details && previous.email === email
            ? previous
            : {kind: form.dataset.supportKind, detail: details, email, request_id: crypto.randomUUID()};
        pendingRequests.set(form, submission);
        button.disabled = true;
        status.textContent = "Sending…";
        try {
            const response = await fetch("/api/support", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(submission),
                signal: AbortSignal.timeout(20000)
            });
            const result = await response.json();
            if (!response.ok || result.reference !== submission.request_id) throw Error(result.error || "The request could not be confirmed.");
            form.reset();
            pendingRequests.delete(form);
            status.textContent="Received. Keep this reference for follow-up: "+result.reference;
        } catch (error) {
            status.textContent=(error.name === "TimeoutError" ? "The request timed out." : error.message || "Could not confirm delivery.")+" Retry or email mannsathi.official@gmail.com.";
        } finally {button.disabled=false;}
    });
})();
