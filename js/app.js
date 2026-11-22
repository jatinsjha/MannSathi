/* ============================================================
   MannSathi — App JS
   ============================================================ */

// ── Theme (dark / light mode) ─────────────────────────────────
function initTheme() {
    const saved = localStorage.getItem("mannsathi_theme") || "light";
    document.documentElement.setAttribute("data-theme", saved);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("mannsathi_theme", next);
}

initTheme();

// ── DOM ───────────────────────────────────────────────────────
const form            = document.getElementById("chat-form");
const input           = document.getElementById("message-input");
const messages        = document.getElementById("messages");
const welcome         = document.getElementById("welcome");
const sendButton      = document.getElementById("send-button");
const toast           = document.getElementById("toast");
const sidebar         = document.getElementById("sidebar");
const backdrop        = document.getElementById("sidebar-backdrop");
const chatHistoryEl   = document.getElementById("chat-history");
const sidebarUsername = document.getElementById("sidebar-username");
const userAvatarEl    = document.getElementById("user-avatar");

// ── State ─────────────────────────────────────────────────────
const conversation = [];
let currentChatId  = null;
let userInitial    = "S";

// ── LocalStorage ──────────────────────────────────────────────
const KEY = "mannsathi_chats";

function loadChats() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch { return []; }
}

function saveChats(chats) {
    try { localStorage.setItem(KEY, JSON.stringify(chats)); }
    catch { /* storage full */ }
}

function chatTitle(msgs) {
    const first = msgs.find(m => m.role === "user");
    if (!first) return "New conversation";
    const t = first.text.trim().replace(/\s+/g, " ");
    return t.length > 38 ? t.slice(0, 38) + "…" : t;
}

function saveCurrentChat() {
    if (!conversation.length) return;
    const chats = loadChats();
    const title  = chatTitle(conversation);

    if (currentChatId) {
        const idx = chats.findIndex(c => c.id === currentChatId);
        if (idx !== -1) {
            chats[idx].messages = [...conversation];
            chats[idx].title    = title;
        }
    } else {
        currentChatId = Date.now();
        chats.unshift({ id: currentChatId, title, messages: [...conversation], createdAt: new Date().toISOString() });
        if (chats.length > 50) chats.splice(50);
    }

    saveChats(chats);
    renderHistory();
}

function deleteChat(id) {
    saveChats(loadChats().filter(c => c.id !== id));
    if (currentChatId === id) clearConversation(false);
    renderHistory();
    showToast("Conversation deleted");
}

function loadChat(id) {
    saveCurrentChat();
    const chat = loadChats().find(c => c.id === id);
    if (!chat) return;

    currentChatId = id;
    messages.replaceChildren();
    welcome.hidden = true;
    conversation.length = 0;

    chat.messages.forEach(m => {
        conversation.push(m);
        renderMessage(m.role, m.text);
    });

    renderHistory();
    closeSidebar();
    input.focus();
}

// ── History rendering ─────────────────────────────────────────

function relativeDate(iso) {
    if (!iso) return "";
    const d   = new Date(iso);
    const now = new Date();
    const ms  = now - d;
    if (ms < 86400000 && d.getDate() === now.getDate()) return "Today";
    if (ms < 172800000) return "Yesterday";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderHistory() {
    chatHistoryEl.replaceChildren();
    const chats = loadChats();

    if (!chats.length) {
        const empty = document.createElement("div");
        empty.className = "chat-history-empty";
        empty.textContent = "No conversations yet.\nStart one with the button above.";
        chatHistoryEl.appendChild(empty);
        return;
    }

    // Group into Today / Yesterday / Older
    const groups = {};
    chats.forEach(chat => {
        const label = relativeDate(chat.createdAt) || "Earlier";
        if (!groups[label]) groups[label] = [];
        groups[label].push(chat);
    });

    Object.entries(groups).forEach(([label, groupChats]) => {
        const header = document.createElement("div");
        header.className = "chat-history-group-label";
        header.textContent = label;
        chatHistoryEl.appendChild(header);

        groupChats.forEach(chat => {
            const item = document.createElement("div");
            item.className = "chat-item" + (chat.id === currentChatId ? " active" : "");
            item.setAttribute("role", "listitem");

            item.innerHTML = `
                <svg class="chat-item-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <div class="chat-item-info">
                    <div class="chat-item-title">${escHtml(chat.title)}</div>
                </div>
                <span class="chat-item-dot"></span>
                <button class="chat-item-delete" title="Delete" aria-label="Delete conversation">×</button>
            `;

            item.querySelector(".chat-item-delete").addEventListener("click", e => {
                e.stopPropagation();
                deleteChat(chat.id);
            });

            item.addEventListener("click", () => loadChat(chat.id));
            chatHistoryEl.appendChild(item);
        });
    });
}

// ── User session ──────────────────────────────────────────────

(async function initUser() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("guest") === "true") {
        setUser("Guest");
        return;
    }
    try {
        if (!window.supabaseReady) return;
        const { data: { user } } = await (await window.supabaseReady).auth.getUser();
        if (user) {
            const name = user.user_metadata?.full_name || user.email?.split("@")[0] || "Student";
            setUser(name);
        }
    } catch { /* guest / no session */ }
})();

function setUser(name) {
    userInitial = name.charAt(0).toUpperCase();
    if (sidebarUsername) sidebarUsername.textContent = name;
    if (userAvatarEl)    userAvatarEl.textContent = userInitial;
    // Keep hidden topbar element synced (JS references it elsewhere)
    const tu = document.getElementById("topbar-username");
    if (tu) tu.textContent = name;
}

// ── Toast ─────────────────────────────────────────────────────

let _toastTimer;
function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

// ── Helpers ───────────────────────────────────────────────────

function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Minimal markdown-like formatting for assistant replies */
function formatReply(raw) {
    let html = escHtml(raw);

    // Bold **text**
    html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    // Italic *text*
    html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    // Inline code `code`
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

    // Split into blocks by double newline
    return html.split(/\n{2,}/).map(block => {
        const lines = block.trim().split("\n");

        // Numbered list
        if (/^\d+\.\s/.test(lines[0])) {
            const items = lines.map(l => `<li>${l.replace(/^\d+\.\s*/, "")}</li>`).join("");
            return `<ol>${items}</ol>`;
        }
        // Bullet list
        if (/^[-*]\s/.test(lines[0])) {
            const items = lines.map(l => `<li>${l.replace(/^[-*]\s*/, "")}</li>`).join("");
            return `<ul>${items}</ul>`;
        }
        // Paragraph
        return `<p>${lines.join("<br>")}</p>`;
    }).join("");
}

// ── Message rendering ─────────────────────────────────────────

function renderMessage(role, text) {
    welcome.hidden = true;

    const wrap = document.createElement("div");
    wrap.className = `message ${role}`;

    if (role === "user") {
        wrap.innerHTML = `
            <div class="msg-avatar">${escHtml(userInitial)}</div>
            <div class="msg-content">
                <div class="msg-meta">
                    <span class="msg-name">You</span>
                    <span class="msg-edit-btn" aria-hidden="true">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    </span>
                </div>
                <div class="msg-bubble">${escHtml(text)}</div>
            </div>
        `;
    } else {
        // Assistant
        const bodyHtml = formatReply(text);
        wrap.innerHTML = `
            <div class="msg-avatar">
                <img src="images/logo.png" alt="MannSathi">
            </div>
            <div class="msg-content">
                <div class="msg-label">
                    <div class="msg-label-dot"><img src="images/logo.png" alt=""></div>
                    MANNSATHI
                    <span>✦</span>
                </div>
                <div class="msg-body">${bodyHtml}</div>
                <div class="msg-actions">
                    <button class="msg-action-btn btn-like" title="Helpful" aria-label="Helpful">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"></path>
                            <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
                        </svg>
                    </button>
                    <div class="msg-action-sep"></div>
                    <button class="msg-action-btn btn-copy" title="Copy" aria-label="Copy response">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        Copy
                    </button>
                    <button class="msg-action-btn btn-share" title="Share" aria-label="Share">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="18" cy="5" r="3"></circle>
                            <circle cx="6" cy="12" r="3"></circle>
                            <circle cx="18" cy="19" r="3"></circle>
                            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
                        </svg>
                    </button>
                    <button class="msg-action-regen" title="Regenerate" aria-label="Regenerate response">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="23 4 23 10 17 10"></polyline>
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                        </svg>
                        Regenerate
                    </button>
                </div>
            </div>
        `;

        // Copy button logic
        const copyBtn = wrap.querySelector(".btn-copy");
        if (copyBtn) {
            copyBtn.addEventListener("click", async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    copyBtn.innerHTML = `
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg> Copied!
                    `;
                    setTimeout(() => {
                        copyBtn.innerHTML = `
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg> Copy
                        `;
                    }, 2000);
                } catch { showToast("Couldn't copy to clipboard"); }
            });
        }
    }

    messages.appendChild(wrap);
    wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return wrap;
}

function showTypingIndicator() {
    const wrap = document.createElement("div");
    wrap.className = "message assistant";
    wrap.id = "typing-indicator";

    wrap.innerHTML = `
        <div class="msg-avatar">
            <img src="images/logo.png" alt="MannSathi">
        </div>
        <div class="msg-content">
            <div class="msg-label">
                <div class="msg-label-dot"><img src="images/logo.png" alt=""></div>
                MANNSATHI
            </div>
            <div class="msg-body">
                <div class="typing-wrap">
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                </div>
            </div>
        </div>
    `;

    messages.appendChild(wrap);
    wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── Textarea auto-resize ──────────────────────────────────────

function resizeInput() {
    input.style.height = "auto";
    if (input.value.trim().length > 0) {
        input.style.height = Math.min(input.scrollHeight, 96) + "px";
    }
    const cc = document.getElementById("char-count");
    if (cc) cc.textContent = `${input.value.length} / 4000`;
}

// ── Send ──────────────────────────────────────────────────────

async function send(rawText) {
    const text = rawText.trim();
    if (!text || sendButton.disabled) return;
    if (text.length > 4000) { showToast("Please keep your message under 4,000 characters."); return; }

    renderMessage("user", text);
    conversation.push({ role: "user", text });
    input.value = "";
    resizeInput();

    sendButton.disabled = true;
    sendButton.classList.add("loading");
    showTypingIndicator();

    try {
        const res  = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: conversation.slice(-12) })
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || "Something went wrong.");
        if (!data.reply?.trim()) throw new Error("Empty response from MannSathi.");

        conversation.push({ role: "assistant", text: data.reply });
        document.getElementById("typing-indicator")?.remove();
        renderMessage("assistant", data.reply);
        saveCurrentChat();

    } catch (err) {
        document.getElementById("typing-indicator")?.remove();
        renderMessage("assistant", err.message || "I'm having trouble connecting. Please try again.");
        conversation.pop();
    } finally {
        sendButton.disabled = false;
        sendButton.classList.remove("loading");
        input.focus();
    }
}

// ── Clear/New ─────────────────────────────────────────────────

function clearConversation(save = true) {
    if (save) saveCurrentChat();
    currentChatId = null;
    conversation.length = 0;
    messages.replaceChildren();
    welcome.hidden = false;
    input.value = "";
    resizeInput();
    closeSidebar();
    renderHistory();
    input.focus();
}

// ── Sidebar drawer ────────────────────────────────────────────

function openSidebar()  {
    sidebar.classList.add("open");
    backdrop.classList.add("show");
}
function closeSidebar() {
    sidebar.classList.remove("open");
    backdrop.classList.remove("show");
}

document.getElementById("mobile-menu")?.addEventListener("click", () => {
    sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
});

backdrop?.addEventListener("click", closeSidebar);

// ── Event wiring ──────────────────────────────────────────────

document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
document.getElementById("mobile-theme-toggle")?.addEventListener("click", toggleTheme);

document.getElementById("sidebar-search-btn")?.addEventListener("click", () => {
    input.focus();
    input.placeholder = "Type to ask or search...";
});

form.addEventListener("submit", e => { e.preventDefault(); send(input.value); });

input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});

input.addEventListener("input", resizeInput);

document.querySelectorAll("[data-prompt]").forEach(btn => {
    btn.addEventListener("click", () => send(btn.dataset.prompt));
});

document.getElementById("new-chat").addEventListener("click", () => clearConversation(true));
document.getElementById("clear-chat").addEventListener("click", () => clearConversation(false));

document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeSidebar();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        clearConversation(true);
    }
});

// ── Init ──────────────────────────────────────────────────────
renderHistory();
