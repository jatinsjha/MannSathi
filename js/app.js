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
const userAvatarEl = document.getElementById("user-avatar");
const searchInput = document.getElementById("conversation-search");
const historySearch = document.getElementById("history-search");
const titleEl = document.getElementById("conversation-title");
const KEY = "mannsathi_chats";
const conversation = [];
let currentChatId = null;
let userInitial = "S";
let isBusy = false;
let toastTimer;
let breathingTimer;
let sidebarReturnFocus;

function loadChats() {
    try {
        const chats = JSON.parse(localStorage.getItem(KEY));
        return Array.isArray(chats) ? chats.filter(c => c && Array.isArray(c.messages) && typeof c.title === "string") : [];
    } catch { return []; }
}
function saveChats(chats) {
    try { localStorage.setItem(KEY, JSON.stringify(chats)); }
    catch { showToast("Couldn't save chat history in this browser."); }
}
function chatTitle(msgs) {
    const first = msgs.find(m => m.role === "user");
    if (!first) return "New chat";
    const title = first.text.trim().replace(/\s+/g, " ");
    return title.length > 38 ? title.slice(0, 38) + "…" : title;
}
function saveCurrentChat() {
    if (!conversation.length) return;
    const chats = loadChats();
    const title = chatTitle(conversation);
    const existing = chats.find(c => c.id === currentChatId);
    if (existing) {
        existing.messages = [...conversation];
        existing.title = title;
    } else {
        currentChatId = Date.now();
        chats.unshift({ id: currentChatId, title, messages: [...conversation], createdAt: new Date().toISOString() });
        if (chats.length > 50) chats.splice(50);
    }
    titleEl.textContent = title;
    saveChats(chats);
    renderHistory();
}
function canNavigate() {
    if (!isBusy) return true;
    showToast("Please wait for the reply to finish.");
    return false;
}
function deleteChat(id) {
    if (!canNavigate()) return;
    saveChats(loadChats().filter(c => c.id !== id));
    if (currentChatId === id) clearConversation(false);
    renderHistory();
    showToast("Chat deleted.");
}
function loadChat(id) {
    if (!canNavigate()) return;
    saveCurrentChat();
    const chat = loadChats().find(c => c.id === id);
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
    const allChats = loadChats();
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
function setUser(name, guest = false) {
    userInitial = name.charAt(0).toUpperCase();
    sidebarUsername.textContent = name;
    userAvatarEl.textContent = userInitial;
    document.getElementById("account-type").textContent = guest ? "Guest mode" : "Personal account";
    const signout = document.getElementById("sidebar-signout");
    signout.setAttribute("aria-label", guest ? "Back to sign in" : "Sign out");
    signout.title = guest ? "Back to sign in" : "Sign out";
}
(async function initUser() {
    const guest = new URLSearchParams(location.search).get("guest") === "true";
    if (guest) { setUser("Guest", true); return; }
    try {
        if (!window.supabaseReady) { setUser("Guest", true); return; }
        const { data: { user } } = await (await window.supabaseReady).auth.getUser();
        if (user) setUser(user.user_metadata?.full_name || user.email?.split("@")[0] || "Student");
        else setUser("Guest", true);
    } catch { setUser("Guest", true); }
})();
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
function renderMessage(role, text, error = false) {
    welcome.hidden = true;
    const wrap = document.createElement("div");
    wrap.className = "message " + role + (error ? " error" : "");
    if (role === "user") {
        wrap.innerHTML = `<div class="msg-avatar">${escHtml(userInitial)}</div><div class="msg-content"><div class="msg-meta">You</div><div class="msg-bubble">${escHtml(text)}</div></div>`;
    } else {
        wrap.innerHTML = `<div class="msg-avatar"><img src="images/logo.png" alt="" width="32" height="32"></div><div class="msg-content"><div class="msg-label">${error ? "Connection error" : "MannSathi"}</div><div class="msg-body">${formatReply(text)}</div></div>`;
        if (error) {
            const retry = document.createElement("button");
            retry.type = "button";
            retry.className = "retry-button";
            retry.textContent = "Try again";
            retry.addEventListener("click", () => { if (!isBusy) requestReply(); });
            wrap.querySelector(".msg-content").appendChild(retry);
        } else {
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
                conversation.pop();
                wrap.remove();
                saveCurrentChat();
                requestReply();
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
    wrap.innerHTML = '<div class="msg-avatar"><img src="images/logo.png" alt="" width="32" height="32"></div><div class="msg-content"><div class="msg-label">MannSathi</div><div class="typing-wrap" aria-hidden="true"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>';
    messages.appendChild(wrap);
    scrollToMessage(wrap);
}
function resizeInput() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
    document.getElementById("char-count").textContent = input.value.length + " / 4000";
    document.querySelector(".composer-wrap").classList.toggle("has-text", !!input.value.length);
}
async function requestReply() {
    if (isBusy || !conversation.length) return;
    isBusy = true;
    sendButton.disabled = true;
    sendButton.classList.add("loading");
    form.setAttribute("aria-busy", "true");
    messages.querySelectorAll(".message.error").forEach(el => el.remove());
    showTypingIndicator();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
        const response = await fetch("/api/chat", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: conversation.slice(-12) }),
            signal: controller.signal
        });
        const data = await response.json();
        if (!response.ok || !data.reply?.trim()) throw new Error("No reply");
        conversation.push({ role: "assistant", text: data.reply });
        document.getElementById("typing-indicator")?.remove();
        renderMessage("assistant", data.reply);
        saveCurrentChat();
    } catch {
        document.getElementById("typing-indicator")?.remove();
        renderMessage("assistant", "Couldn't connect. Please try again.", true);
        saveCurrentChat();
    } finally {
        clearTimeout(timeout);
        isBusy = false;
        sendButton.disabled = false;
        sendButton.classList.remove("loading");
        form.removeAttribute("aria-busy");
        if (!document.querySelector("dialog[open]") && window.innerWidth > 760) input.focus({ preventScroll: true });
    }
}
function send(rawText) {
    const text = rawText.trim();
    if (!text || isBusy) return;
    if (text.length > 4000) { showToast("Keep your message under 4,000 characters."); return; }
    messages.querySelectorAll(".message.error").forEach(el => el.remove());
    renderMessage("user", text);
    conversation.push({ role: "user", text });
    input.value = "";
    resizeInput();
    saveCurrentChat();
    requestReply();
}
function clearConversation(save = true) {
    if (!canNavigate()) return;
    if (save) saveCurrentChat();
    currentChatId = null;
    conversation.length = 0;
    messages.replaceChildren();
    welcome.hidden = false;
    titleEl.textContent = "New chat";
    input.value = "";
    resizeInput();
    closeSidebar();
    renderHistory();
    document.getElementById("chat-area").scrollTop = 0;
    if (window.innerWidth > 760) input.focus({ preventScroll: true });
}
function openSidebar() {
    sidebarReturnFocus = document.activeElement;
    sidebar.classList.add("open");
    backdrop.classList.add("show");
    document.getElementById("mobile-menu").setAttribute("aria-expanded", "true");
    if (window.innerWidth <= 760) document.getElementById("main-panel").inert = true;
    document.getElementById("sidebar-close").focus();
}
function closeSidebar() {
    const wasOpen = sidebar.classList.contains("open");
    sidebar.classList.remove("open");
    backdrop.classList.remove("show");
    document.getElementById("main-panel").inert = false;
    document.getElementById("mobile-menu").setAttribute("aria-expanded", "false");
    if (wasOpen) sidebarReturnFocus?.focus({ preventScroll: true });
}
function openDialog(id) {
    closeSidebar();
    document.getElementById(id).showModal();
}
document.getElementById("mobile-menu").addEventListener("click", openSidebar);
document.getElementById("sidebar-close").addEventListener("click", closeSidebar);
backdrop.addEventListener("click", closeSidebar);
document.getElementById("new-chat").addEventListener("click", () => clearConversation());
document.getElementById("space-home").addEventListener("click", () => clearConversation());
document.getElementById("sidebar-search-btn").addEventListener("click", e => {
    historySearch.hidden = !historySearch.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!historySearch.hidden));
    if (!historySearch.hidden) searchInput.focus();
    else { searchInput.value = ""; renderHistory(); }
});
searchInput.addEventListener("input", renderHistory);
document.getElementById("settings-button").addEventListener("click", () => openDialog("settings-dialog"));
document.querySelectorAll("[data-open-settings]").forEach(button => button.addEventListener("click", () => openDialog("settings-dialog")));
document.querySelectorAll("[data-open-breathing]").forEach(b => b.addEventListener("click", () => openDialog("breathing-dialog")));
document.getElementById("clear-chat").addEventListener("click", () => { if (canNavigate()) openDialog("clear-dialog"); });
document.getElementById("settings-clear-history").addEventListener("click", () => {
    if (!canNavigate()) return;
    document.getElementById("settings-dialog").close();
    openDialog("clear-dialog");
});
document.getElementById("confirm-clear-history").addEventListener("click", () => {
    if (!canNavigate()) return;
    saveChats([]);
    searchInput.value = "";
    clearConversation(false);
    document.getElementById("clear-dialog").close();
    showToast("Chat history cleared.");
});
document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("click", e => {
    if (e.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) dialog.close();
}));
document.querySelectorAll("[data-prompt]").forEach(button => button.addEventListener("click", () => send(button.dataset.prompt)));
form.addEventListener("submit", e => { e.preventDefault(); send(input.value); });
input.addEventListener("input", resizeInput);
input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
document.addEventListener("keydown", e => {
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
window.addEventListener("resize", () => { if (window.innerWidth > 760) closeSidebar(); });
document.getElementById("sidebar-signout").addEventListener("click", async e => {
    e.preventDefault();
    if (!canNavigate()) return;
    try { if (window.supabaseReady && new URLSearchParams(location.search).get("guest") !== "true") {
        const { error } = await (await window.supabaseReady).auth.signOut();
        if (error) { showToast("Couldn't sign out. Please try again."); return; }
    } } catch { /* The client is unavailable; return to the sign-in page. */ }
    location.href = "index.html";
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
