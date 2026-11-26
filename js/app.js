/* MannSathi conversation workspace. Uses the existing chat API and browser history. */
const form = document.getElementById("chat-form");
const input = document.getElementById("message-input");
const messages = document.getElementById("messages");
const welcome = document.getElementById("welcome");
const sendButton = document.getElementById("send-button");
const toast = document.getElementById("toast");
const sidebar = document.getElementById("sidebar");
const backdrop = document.getElementById("sidebar-backdrop");
const chatHistoryEl = document.getElementById("chat-history");
const sidebarUsername = document.getElementById("sidebar-username");
const accountTrigger = document.getElementById("user-profile-card");
const accountMenu = document.getElementById("account-menu");
const accountControl = accountTrigger.parentElement;
const mobileMenuButton = document.getElementById("mobile-menu");
const searchInput = document.getElementById("conversation-search");
const historySearch = document.getElementById("history-search");
const titleEl = document.getElementById("conversation-title");
const guestChat = new URLSearchParams(location.search).get("guest") === "true";
let chatOwner = guestChat ? "guest" : null;
let chatGeneration = 0;
let sessionChats = [];
let access = "checking", accessCheck = 0, disclosed = false, activeChatController = null;
let signingOut = false;
const archivedIds = new Set();
const conversation = [];
let currentChatId = null;
let userInitial = "S";
let avatarUserId = "guest";
let isBusy = false;
let toastTimer;
let breathingTimer;
let accountName = null, accountRole = null;

function archiveKey() { return chatOwner && !guestChat ? "mannsathi.chats." + chatOwner : null; }
function archiveRows(key) {
    const rows = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(rows)) throw new Error("Unreadable earlier chats");
    return rows;
}
function chatTitle(createdAt) {
    const date = new Date(createdAt);
    return Number.isFinite(date.getTime()) ? "Conversation · " + date.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : "Conversation";
}
function archiveControl() {
    const key = archiveKey(), open = document.getElementById("open-earlier-chats");
    try { open.hidden = !key || !localStorage.getItem(key); }
    catch { open.hidden = !key; }
}
function eraseStored(key) {
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) throw new Error("Device storage did not clear");
}
function openEarlierChats() {
    const key = archiveKey();
    if (!key) return;
    try {
        for (const row of archiveRows(key)) {
            if (!row || !Array.isArray(row.messages) || !["number","string"].includes(typeof row.id) || sessionChats.some(c => c.id === row.id)) continue;
            const history = row.messages.filter(m => m && ["user","assistant"].includes(m.role) && typeof m.text === "string");
            sessionChats.push({id:row.id, createdAt:row.createdAt, title:chatTitle(row.createdAt), messages:history});
            archivedIds.add(row.id);
        }
    } catch { showToast("Earlier chats could not be read from this device."); return; }
    document.getElementById("settings-dialog").close();
    renderHistory();
    if (window.innerWidth <= 760) openSidebar();
    chatHistoryEl.querySelector("button")?.focus();
}
window.addEventListener("storage", event => {
    const key = archiveKey();
    if (!key || (event.key !== null && event.key !== key)) return;
    let remaining;
    try { remaining = new Set(archiveRows(key).map(row => row?.id)); }
    catch { remaining = new Set(); }
    const erased = new Set([...archivedIds].filter(id => !remaining.has(id)));
    for (const id of erased) archivedIds.delete(id);
    sessionChats = sessionChats.filter(row => !erased.has(row.id));
    if (erased.has(currentChatId)) { invalidateReply(); resetConversation(); }
    else renderHistory();
    archiveControl();
});
function saveCurrentChat() {
    if (!conversation.length) return;
    const chats = sessionChats;
    const existing = chats.find(c => c.id === currentChatId);
    if (existing) {
        existing.messages = [...conversation];
    } else {
        currentChatId = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        chats.unshift({ id: currentChatId, title:chatTitle(createdAt), messages: [...conversation], createdAt });
        if (chats.length > 50) chats.splice(50);
    }
    titleEl.textContent = chats.find(c => c.id === currentChatId).title;
    renderHistory();
}
function canNavigate() {
    if (!isBusy) return true;
    showToast("Please wait for the reply to finish.");
    return false;
}
function deleteChat(id) {
    if (currentChatId === id) { invalidateReply(); resetConversation(); }
    if (archivedIds.has(id)) {
        try {
            const key = archiveKey(), remaining = archiveRows(key).filter(c => c?.id !== id);
            if (remaining.length) localStorage.setItem(key, JSON.stringify(remaining));
            else eraseStored(key);
            if (archiveRows(key).some(c => c?.id === id)) throw new Error("Copy remains");
        } catch { showToast("The earlier copy could not be removed from this device. Try again."); return; }
        archivedIds.delete(id);
        archiveControl();
    }
    sessionChats = sessionChats.filter(c => c.id !== id);
    renderHistory();
    showToast("Chat deleted.");
}
function loadChat(id) {
    if (!canNavigate()) return;
    window.MannSathiWorkspace?.show("chat");
    saveCurrentChat();
    const chat = sessionChats.find(c => c.id === id);
    if (!chat) return;
    currentChatId = id;
    messages.replaceChildren();
    conversation.length = 0;
    chat.messages.forEach(m => {
        if (typeof m.text === "string" && ["user", "assistant"].includes(m.role)) {
            conversation.push(m);
            renderMessage(m.role, m.text);
        }
    });
    welcome.hidden = conversation.length > 0;
    titleEl.textContent = chat.title;
    renderHistory();
    closeSidebar();
    input.focus({ preventScroll: true });
}
function relativeDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Earlier";
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function renderHistory() {
    chatHistoryEl.replaceChildren();
    const allChats = sessionChats;
    document.getElementById("clear-chat").hidden = !allChats.length;
    const query = searchInput.value.trim().toLowerCase();
    const chats = allChats.filter(c => !query || c.title.toLowerCase().includes(query) || c.messages.some(m => typeof m.text === "string" && m.text.toLowerCase().includes(query)));
    if (!chats.length) {
        const empty = document.createElement("div");
        empty.className = "chat-history-empty";
        empty.textContent = query ? "No matching chats." : "No chats yet.";
        chatHistoryEl.appendChild(empty);
        return;
    }
    const groups = {};
    chats.forEach(chat => {
        const label = relativeDate(chat.createdAt);
        (groups[label] ||= []).push(chat);
    });
    Object.entries(groups).forEach(([label, chats]) => {
        const heading = document.createElement("div");
        heading.className = "chat-history-group-label";
        heading.textContent = label;
        chatHistoryEl.appendChild(heading);
        chats.forEach(chat => {
            const item = document.createElement("div");
            item.className = "chat-item" + (chat.id === currentChatId ? " active" : "");
            item.setAttribute("role", "listitem");
            item.innerHTML = `<svg class="chat-item-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 11a8 8 0 0 1-8 8H4l1.5-4A8 8 0 1 1 20 11Z"/></svg><div class="chat-item-info"><button type="button" class="chat-item-open"></button></div><button type="button" class="chat-item-delete" title="Delete conversation" aria-label="Delete conversation">×</button>`;
            const open = item.querySelector(".chat-item-open");
            open.textContent = chat.title;
            open.title = chat.title;
            if (chat.id === currentChatId) open.setAttribute("aria-current", "true");
            open.addEventListener("click", () => loadChat(chat.id));
            item.querySelector(".chat-item-delete").addEventListener("click", () => deleteChat(chat.id));
            chatHistoryEl.appendChild(item);
        });
    });
}
function setUser(name, guest = false, userId = avatarUserId) {
    userInitial = name.charAt(0).toUpperCase();
    sidebarUsername.textContent = name;
    document.getElementById("account-menu-name").textContent = name;
    accountTrigger.setAttribute("aria-label", "Account menu for " + name);
    avatarUserId = guest ? "guest" : userId;
    for (const id of ["user-avatar", "account-menu-avatar"]) {
        const avatar = document.getElementById(id);
        avatar.textContent = userInitial;
        window.MannSathiAvatars?.paint(avatar, avatarUserId, { alt: "" });
    }
    document.querySelectorAll(".message.user .msg-avatar").forEach(element => window.MannSathiAvatars?.paint(element, avatarUserId));
    const roleLabels = { student: "Student account", teacher: "Teacher account" };
    const accountType = guest ? "Guest mode" : roleLabels[accountRole] || "Personal account";
    document.getElementById("account-type").textContent = accountType;
    document.getElementById("account-menu-type").textContent = accountType;
    accountMenu.querySelector('[data-open-settings="profile"]').hidden = guest || accountRole !== "student";
    document.getElementById("signout-label").textContent = guest ? "Back to sign in" : "Sign out";
}
window.addEventListener("mannsathi:profile", event => {
    if (new URLSearchParams(location.search).get("guest") === "true") return;
    if (typeof event.detail?.full_name !== "string" || !["student", "teacher"].includes(event.detail?.role)) return;
    accountName = event.detail.full_name; accountRole = event.detail.role;
    setUser(accountName);
});
window.addEventListener("mannsathi:session-reset", event => {
    closeAccountMenu(accountMenu.contains(document.activeElement));
    const identity = new URLSearchParams(location.search).get("guest") === "true" ? null : event.detail;
    accountName = identity?.full_name || null;
    accountRole = null;
    if (identity?.user_id) setUser(accountName || "Member", false, identity.user_id);
    else setUser("Guest", true);
});
window.addEventListener("mannsathi:context", event => {
    if (!event.detail?.user_id) return;
    accountRole = event.detail.role;
    setUser(accountName || (accountRole === "teacher" ? "Teacher" : "Student"), false, event.detail.user_id);
});
function showToast(text) {
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}
function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function formatReply(raw) {
    let html = escHtml(raw);
    html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    return html.split(/\n{2,}/).map(block => {
        const lines = block.trim().split("\n");
        if (lines.every(l => /^\d+\.\s/.test(l))) return "<ol>" + lines.map(l => "<li>" + l.replace(/^\d+\.\s*/, "") + "</li>").join("") + "</ol>";
        if (lines.every(l => /^[-*]\s/.test(l))) return "<ul>" + lines.map(l => "<li>" + l.replace(/^[-*]\s*/, "") + "</li>").join("") + "</ul>";
        return "<p>" + lines.join("<br>") + "</p>";
    }).join("");
}
const actionIcon = (name) => {
    const paths = {
        copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
        like: '<path d="M7 10v11H3V10h4Zm0 0 5-8a3 3 0 0 1 2 3v4h5a2 2 0 0 1 2 2l-2 10H7"/>',
        share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m9 11 6-4M9 13l6 4"/>',
        regen: '<path d="M20 7v5h-5m4-5a8 8 0 1 0 1 10"/>'
    };
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + "</svg>";
};
function scrollToMessage(wrap) {
    const area = document.getElementById("chat-area");
    requestAnimationFrame(() => area.scrollTo({ top: area.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }));
}
function renderMessage(role, text, error = false, retryAttempt = null, retryAllowed = true) {
    welcome.hidden = true;
    const wrap = document.createElement("div");
    wrap.className = "message " + role + (error ? " error" : "");
    if (role === "user") {
        wrap.innerHTML = `<div class="msg-avatar">${escHtml(userInitial)}</div><div class="msg-content"><div class="msg-meta">You</div><div class="msg-bubble">${escHtml(text)}</div></div>`;
        window.MannSathiAvatars?.paint(wrap.querySelector(".msg-avatar"), avatarUserId);
    } else {
        wrap.innerHTML = `<div class="msg-avatar"><img src="images/mannsathi-icon.svg" alt="" width="32" height="32"></div><div class="msg-content"><div class="msg-label">${error ? "AI chat unavailable" : "MannSathi"}</div><div class="msg-body">${formatReply(text)}</div></div>`;
        if (error && retryAllowed) {
            const retry = document.createElement("button");
            retry.type = "button";
            retry.className = "retry-button";
            retry.textContent = "Try again";
            retry.addEventListener("click", () => { if (!isBusy) requestReply(retryAttempt); });
            wrap.querySelector(".msg-content").appendChild(retry);
        } else if (!error) {
            const actions = document.createElement("div");
            actions.className = "msg-actions";
            actions.innerHTML = `<button type="button" class="msg-action-btn btn-like" aria-label="Mark response as helpful" aria-pressed="false" title="Helpful">${actionIcon("like")}</button><div class="msg-action-sep"></div><button type="button" class="msg-action-btn btn-copy" aria-label="Copy response">${actionIcon("copy")} Copy</button><button type="button" class="msg-action-btn btn-share" aria-label="Share response" title="Share response">${actionIcon("share")}</button><button type="button" class="msg-action-regen" aria-label="Regenerate response">${actionIcon("regen")} Regenerate</button>`;
            wrap.querySelector(".msg-content").appendChild(actions);
            actions.querySelector(".btn-copy").addEventListener("click", async () => {
                try { await navigator.clipboard.writeText(text); showToast("Response copied."); }
                catch { showToast("Couldn't copy. Select the text to copy it."); }
            });
            actions.querySelector(".btn-like").addEventListener("click", e => {
                const button = e.currentTarget;
                const liked = button.getAttribute("aria-pressed") !== "true";
                button.setAttribute("aria-pressed", String(liked));
                showToast(liked ? "Marked as helpful." : "Helpful mark removed.");
            });
            actions.querySelector(".btn-share").addEventListener("click", async () => {
                try {
                    if (navigator.share) await navigator.share({ title: "MannSathi response", text });
                    else { await navigator.clipboard.writeText(text); showToast("Response copied."); }
                } catch (err) { if (err.name !== "AbortError") showToast("Couldn't share. Try copying the response."); }
            });
            actions.querySelector(".msg-action-regen").addEventListener("click", () => {
                if (!canNavigate()) return;
                if (wrap !== messages.lastElementChild || conversation.at(-1)?.role !== "assistant") {
                    showToast("Only the latest reply can be regenerated.");
                    return;
                }
                confirmProvider(() => {
                    const prior = conversation.pop();
                    wrap.remove();
                    saveCurrentChat();
                    requestReply({ retry_of: prior.request_id });
                });
            });
        }
    }
    messages.appendChild(wrap);
    scrollToMessage(wrap);
    return wrap;
}
function showTypingIndicator() {
    const wrap = document.createElement("div");
    wrap.className = "message assistant";
    wrap.id = "typing-indicator";
    wrap.setAttribute("aria-label", "MannSathi is thinking");
    wrap.innerHTML = '<div class="msg-avatar"><img src="images/mannsathi-icon.svg" alt="" width="32" height="32"></div><div class="msg-content"><div class="msg-label">MannSathi</div><div class="typing-wrap" aria-hidden="true"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>';
    messages.appendChild(wrap);
    scrollToMessage(wrap);
}
function resizeInput() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
    document.getElementById("char-count").textContent = input.value.length + " / 4000";
    document.querySelector(".composer-wrap").classList.toggle("has-text", !!input.value.length);
}
async function requestReply(attempt = null) {
    if (isBusy || !conversation.length || !chatOwner || access !== "eligible" || signingOut) return;
    const generation = chatGeneration;
    isBusy = true;
    sendButton.disabled = true;
    sendButton.classList.add("loading");
    form.setAttribute("aria-busy", "true");
    messages.querySelectorAll(".message.error").forEach(el => el.remove());
    showTypingIndicator();
    const request = { request_id: attempt?.request_id || crypto.randomUUID(), retry_of: attempt?.retry_of };
    activeChatController = new AbortController();
    try {
        const data = await window.MannSathiAPI.request("/api/chat", {
            method: "POST", expectedUserId: chatOwner, signal: activeChatController.signal,
            body: { ...request, messages: conversation.slice(-12).map(({ role, text }) => ({ role, text })) }
        });
        if (generation !== chatGeneration) return;
        if (!data.reply?.trim()) throw new Error("MannSathi could not return a reply.");
        conversation.push({ role: "assistant", text: data.reply, request_id: request.request_id });
        document.getElementById("typing-indicator")?.remove();
        renderMessage("assistant", data.reply);
        saveCurrentChat();
    } catch (error) {
        if (generation !== chatGeneration) return;
        document.getElementById("typing-indicator")?.remove();
        // A lost response reuses its ID. A confirmed attempt gets a linked, user-initiated retry.
        const retry = error.data?.retryable_attempt && error.data.request_id === request.request_id
            ? { retry_of: request.request_id } : request;
        const denied = error.data?.code === "ai_unavailable" || error.status === 401;
        if (denied) displayAccess(error.status === 401 ? "signedout" : error.status === 503 ? "unavailable" : "denied");
        renderMessage("assistant", error.message || "Couldn't connect. Please try again.", true, retry, !denied);
        saveCurrentChat();
    } finally {
        if (generation === chatGeneration) {
            endReply();
            if (accountMenu.hidden && !document.querySelector("dialog[open]") && window.innerWidth > 760) input.focus({ preventScroll: true });
        }
    }
}
function endReply() {
    activeChatController = null;
    isBusy = false;
    sendButton.disabled = false;
    sendButton.classList.remove("loading");
    form.removeAttribute("aria-busy");
}
function invalidateReply() {
    chatGeneration++;
    activeChatController?.abort();
    endReply();
    const dialog = document.getElementById("gemini-disclosure");
    if (dialog.open) dialog.close("cancel");
}
function displayAccess(state) {
    access = state;
    const states = {checking:"Checking AI chat access…", denied:"AI chat is available to approved adult pilot participants.",
        signedout:"Sign in to check your access to AI chat.", unavailable:"AI chat access could not be confirmed. Please try again."};
    document.getElementById("chat-access").hidden = state === "eligible";
    document.getElementById("chat-access-message").textContent = states[state] || "";
    document.getElementById("chat-access-signin").hidden = !(guestChat || state === "signedout");
    const retry = document.getElementById("retry-chat-access");
    retry.hidden = guestChat || !["denied","unavailable"].includes(state);
    retry.textContent = chatOwner ? "Check again" : "Reload";
    form.hidden = state !== "eligible";
    document.querySelector(".prompt-grid").hidden = form.hidden;
}
async function checkAccess() {
    const id = ++accessCheck;
    if (guestChat || !chatOwner) { displayAccess(guestChat ? "denied" : "signedout"); return; }
    displayAccess("checking");
    try {
        const result = await window.MannSathiAPI.request("/api/chat", {expectedUserId:chatOwner});
        if (id !== accessCheck) return;
        if (typeof result?.available !== "boolean") throw new Error("Invalid availability");
        displayAccess(result.available ? "eligible" : "denied");
    } catch (error) {
        if (id === accessCheck) displayAccess(error.status === 401 ? "signedout" : "unavailable");
    }
}
function confirmProvider(onSend) {
    if (signingOut || access !== "eligible" || isBusy) return;
    if (disclosed) { onSend(); return; }
    const dialog = document.getElementById("gemini-disclosure"), generation = chatGeneration;
    if (dialog.open) return;
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
        if (generation !== chatGeneration) return;
        if (dialog.returnValue === "send" && access === "eligible" && !signingOut) {
            disclosed = true; onSend();
        } else { input.focus(); }
    }, {once:true});
    dialog.showModal();
}
function send(rawText) {
    const text = rawText.trim();
    if (!text || isBusy) return;
    if (!chatOwner || access !== "eligible" || signingOut) return;
    if (window.MannSathiWorkspace && !window.MannSathiWorkspace.show("chat")) return;
    if (text.length > 4000) { showToast("Keep your message under 4,000 characters."); return; }
    confirmProvider(() => {
        messages.querySelectorAll(".message.error").forEach(el => el.remove());
        renderMessage("user", text);
        conversation.push({ role: "user", text });
        input.value = "";
        resizeInput();
        saveCurrentChat();
        requestReply();
    });
}
function resetConversation() {
    currentChatId = null;
    conversation.length = 0;
    messages.replaceChildren();
    welcome.hidden = false;
    titleEl.textContent = "New chat";
    input.value = "";
    resizeInput();
    renderHistory();
    document.getElementById("chat-area").scrollTop = 0;
}
function clearConversation(save = true) {
    if (!canNavigate()) return;
    window.MannSathiWorkspace?.show("chat");
    if (save) saveCurrentChat();
    resetConversation();
    closeSidebar();
    if (window.innerWidth > 760) input.focus({ preventScroll: true });
}
function clearChatScreen() {
    invalidateReply();
    sessionChats = [];
    archivedIds.clear();
    disclosed = false;
    searchInput.value = "";
    resetConversation();
}
function changeChatAccount(session, initialEvent = false) {
    const next = session?.access_token && !session.user?.is_anonymous ? session.user?.id || null : null;
    if (chatOwner === next) {
        if (!next) displayAccess("signedout");
        else if (initialEvent && access !== "eligible") setTimeout(() => { if (chatOwner === next) checkAccess(); }, 0);
        return;
    }
    chatOwner = next;
    document.getElementById("clear-dialog").close();
    clearChatScreen();
    archiveControl();
    ++accessCheck;
    displayAccess(next ? "checking" : "signedout");
    if (next) setTimeout(() => { if (chatOwner === next) checkAccess(); }, 0);
}
function accountMenuItems() {
    return [...accountMenu.querySelectorAll('[role="menuitem"]:not([hidden])')];
}
function openAccountMenu(last = false) {
    accountMenu.hidden = false;
    accountTrigger.setAttribute("aria-expanded", "true");
    const items = accountMenuItems();
    (last ? items.at(-1) : items[0]).focus();
}
function closeAccountMenu(restoreFocus = false) {
    if (accountMenu.hidden) return;
    document.getElementById("help-menu").hidden = true;
    document.getElementById("account-help").setAttribute("aria-expanded", "false");
    accountTrigger.setAttribute("aria-expanded", "false");
    accountMenu.hidden = true;
    if (restoreFocus) accountTrigger.focus({ preventScroll: true });
}
accountTrigger.addEventListener("click", () => {
    if (accountMenu.hidden) openAccountMenu();
    else closeAccountMenu(true);
});
accountTrigger.addEventListener("keydown", event => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        openAccountMenu(event.key === "ArrowUp");
    }
});
accountMenu.addEventListener("keydown", event => {
    if (event.key === "Tab") {
        closeAccountMenu(true);
        return;
    }
    if (event.key === " " && event.target.matches("a")) {
        event.preventDefault();
        event.target.click();
        return;
    }
    const items = accountMenuItems(), index = items.indexOf(document.activeElement);
    const next = {
        ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length,
        Home: 0, End: items.length - 1
    }[event.key];
    if (next !== undefined) {
        event.preventDefault();
        items[next].focus();
    }
});
function dismissOutsideAccount(event) {
    if (!accountControl.contains(event.target)) closeAccountMenu();
}
document.addEventListener("click", dismissOutsideAccount);
document.addEventListener("focusin", dismissOutsideAccount);
function openSidebar() {
    sidebar.classList.add("open");
    backdrop.classList.add("show");
    mobileMenuButton.setAttribute("aria-expanded", "true");
    if (window.innerWidth <= 760) document.getElementById("main-panel").inert = true;
    document.getElementById("sidebar-close").focus();
    requestAnimationFrame(() => {
        if (sidebar.classList.contains("open") && !sidebar.contains(document.activeElement)) document.getElementById("sidebar-close").focus();
    });
}
function closeSidebar() {
    const wasOpen = sidebar.classList.contains("open");
    closeAccountMenu(accountMenu.contains(document.activeElement));
    sidebar.classList.remove("open");
    backdrop.classList.remove("show");
    document.getElementById("main-panel").inert = false;
    mobileMenuButton.setAttribute("aria-expanded", "false");
    if (wasOpen) mobileMenuButton.focus({ preventScroll: true });
}
function openDialog(id) {
    closeSidebar();
    const dialog = document.getElementById(id);
    dialog.showModal();
    if (id === "settings-dialog") dialog.addEventListener("close", () => {
        if (!document.querySelector("dialog[open]")) (window.innerWidth <= 760 ? mobileMenuButton : accountTrigger).focus({preventScroll:true});
    }, {once:true});
}
mobileMenuButton.addEventListener("click", openSidebar);
document.getElementById("sidebar-close").addEventListener("click", closeSidebar);
backdrop.addEventListener("click", closeSidebar);
document.getElementById("new-chat").addEventListener("click", () => clearConversation());
document.getElementById("space-home").addEventListener("click", () => window.MannSathiWorkspace?.show("dashboard"));
document.getElementById("sidebar-search-btn").addEventListener("click", e => {
    historySearch.hidden = !historySearch.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!historySearch.hidden));
    if (!historySearch.hidden) searchInput.focus();
    else { searchInput.value = ""; renderHistory(); }
});
searchInput.addEventListener("input", renderHistory);
document.querySelectorAll("[data-open-breathing]").forEach(b => b.addEventListener("click", () => openDialog("breathing-dialog")));
function showClearHistory() {
    document.getElementById("clear-chat-error").textContent = "";
    document.getElementById("erase-legacy-chats").checked = false;
    const option = document.getElementById("legacy-chat-option");
    try { option.hidden = localStorage.getItem("mannsathi_chats") === null; }
    catch { option.hidden = false; }
    openDialog("clear-dialog");
}
document.getElementById("open-earlier-chats").addEventListener("click",openEarlierChats);
document.getElementById("retry-chat-access").addEventListener("click",() => chatOwner ? checkAccess() : location.reload());
document.getElementById("clear-chat").addEventListener("click", showClearHistory);
document.getElementById("settings-clear-history").addEventListener("click", () => {
    document.getElementById("settings-dialog").close();
    showClearHistory();
});
document.getElementById("confirm-clear-history").addEventListener("click", () => {
    clearChatScreen();
    try {
        const key = archiveKey();
        if (key) eraseStored(key);
        if (document.getElementById("erase-legacy-chats").checked) eraseStored("mannsathi_chats");
    } catch {
        document.getElementById("clear-chat-error").textContent = "This tab was cleared. Some device storage could not be erased. Retry before leaving this device.";
        return;
    }
    archiveControl();
    document.getElementById("clear-dialog").close();
    showToast("Chat history cleared.");
});
document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("click", e => {
    if (e.target !== dialog || dialog.id === "chat-signout-dialog") return;
    const bounds = dialog.getBoundingClientRect();
    if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) dialog.close();
}));
document.querySelectorAll("[data-prompt]").forEach(button => button.addEventListener("click", () => {
    if (access !== "eligible" || isBusy) return;
    input.value = button.dataset.prompt;
    resizeInput();
    input.focus();
}));
form.addEventListener("submit", e => { e.preventDefault(); send(input.value); });
input.addEventListener("input", resizeInput);
input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !accountMenu.hidden) {
        e.preventDefault();
        closeAccountMenu(true);
        return;
    }
    if (e.key === "Escape") closeSidebar();
    if (sidebar.classList.contains("open") && e.key === "Tab") {
        const focusables = [...sidebar.querySelectorAll('button:not([disabled]), a[href], input')].filter(el => el.getClientRects().length);
        const first = focusables[0], last = focusables.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        clearConversation();
    }
});
window.matchMedia("(max-width: 760px)").addEventListener("change", () => closeSidebar());
const signoutDialog = document.getElementById("chat-signout-dialog");
async function confirmDeviceSignout() {
    const client = await window.supabaseReady;
    const {error} = await client.auth.signOut({scope:"local"});
    if (error) throw error;
    const check = await client.auth.getSession();
    if (check.error || check.data?.session !== null) throw new Error("Session still present");
}
async function signOutOfDevice() {
    const retry = document.getElementById("retry-chat-signout"), cancel = document.getElementById("cancel-chat-signout");
    signingOut = true;
    clearChatScreen();
    if (guestChat) { location.replace("index.html"); return; }
    closeSidebar();
    if (!signoutDialog.open) signoutDialog.showModal();
    retry.hidden = cancel.hidden = true;
    const feedback = document.getElementById("chat-signout-status");
    document.getElementById("chat-signout-title").textContent = "Signing out";
    feedback.textContent = "This tab’s conversations and draft have been cleared.";
    let timeout;
    try {
        await Promise.race([confirmDeviceSignout(), new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Sign-out confirmation timed out")), 15000);
        })]);
        location.replace("index.html");
    } catch {
        document.getElementById("chat-signout-title").textContent = "Sign-out could not be confirmed";
        feedback.textContent = "This tab’s chats were cleared. Your account may still be signed in on this device. Check your connection and retry before you leave.";
        retry.hidden = cancel.hidden = false;
        retry.focus();
    } finally { clearTimeout(timeout); }
}
document.getElementById("sidebar-signout").addEventListener("click", e => { e.preventDefault(); signOutOfDevice(); });
document.getElementById("retry-chat-signout").addEventListener("click",signOutOfDevice);
signoutDialog.addEventListener("cancel", e => e.preventDefault());
document.getElementById("cancel-chat-signout").addEventListener("click", () => {
    signingOut = false;
    signoutDialog.close();
    accountTrigger.focus();
});

const breathVisual = document.getElementById("breathing-visual");
const breathPhase = document.getElementById("breathing-phase");
const breathCount = document.getElementById("breathing-count");
const breathProgress = document.getElementById("breathing-progress");
const breathStart = document.getElementById("breathing-start");
function stopBreathing(completed = false) {
    clearInterval(breathingTimer);
    breathingTimer = null;
    breathVisual.className = "breathing-visual";
    breathPhase.textContent = completed ? "Complete" : "Ready";
    breathCount.textContent = "";
    breathStart.querySelector("span").textContent = completed ? "Start again" : "Start breathing";
    breathProgress.textContent = completed ? "4 breaths completed" : "Inhale 4s · Hold 4s · Exhale 6s";
}
breathStart.addEventListener("click", () => {
    if (breathingTimer) { stopBreathing(); return; }
    const startedAt = Date.now();
    let currentPhase = "";
    breathStart.querySelector("span").textContent = "Stop";
    function tick() {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        if (elapsed >= 56) { stopBreathing(true); return; }
        const position = elapsed % 14;
        const phase = position < 4 ? "inhale" : position < 8 ? "hold" : "exhale";
        if (phase !== currentPhase) {
            currentPhase = phase;
            breathVisual.className = "breathing-visual " + phase;
            breathPhase.textContent = phase === "inhale" ? "Breathe in" : phase === "hold" ? "Hold" : "Breathe out";
        }
        breathCount.textContent = String(position < 4 ? 4 - position : position < 8 ? 8 - position : 14 - position);
        breathProgress.textContent = "Breath " + (Math.floor(elapsed / 14) + 1) + " of 4";
    }
    tick();
    breathingTimer = setInterval(tick, 250);
});
document.getElementById("breathing-dialog").addEventListener("close", () => stopBreathing());
renderHistory();
resizeInput();
displayAccess(guestChat ? "denied" : "checking");
if (!guestChat && window.supabaseReady) window.supabaseReady.then(async client => {
    let changes = 0;
    client.auth.onAuthStateChange((event, session) => {
        changes++;
        changeChatAccount(event === "SIGNED_OUT" ? null : session, event === "INITIAL_SESSION");
    });
    async function syncChatAccount() {
        const previous = changes;
        const {data, error} = await client.auth.getSession();
        if (changes === previous) {
            if (error) displayAccess("unavailable");
            else changeChatAccount(data?.session);
        }
    }
    window.addEventListener("pagehide", event => {
        if (event.persisted) { changes++; changeChatAccount(null); }
    });
    window.addEventListener("pageshow", event => {
        if (event.persisted) syncChatAccount().catch(() => {});
    });
    await syncChatAccount();
}).catch(() => displayAccess("unavailable"));
if (guestChat) window.addEventListener("pagehide", clearChatScreen);
