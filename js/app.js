
/* ============================================================
   MannSathi — App JavaScript
   ============================================================ */

// ── DOM references ────────────────────────────────────────────

const form       = document.getElementById("chat-form");
const input      = document.getElementById("message-input");
const messages   = document.getElementById("messages");
const welcome    = document.getElementById("welcome");
const sendButton = document.getElementById("send-button");
const charCount  = document.getElementById("char-count");
const toast      = document.getElementById("toast");
const sidebar    = document.getElementById("sidebar");
const chatHistoryEl = document.getElementById("chat-history");
const topbarUsername = document.getElementById("topbar-username");

// ── Chat state ────────────────────────────────────────────────

const conversation = [];    // current in-progress messages
let currentChatId  = null;  // ID of the active saved chat

// ── LocalStorage chat history ─────────────────────────────────

const STORAGE_KEY = "mannsathi_chats";

function loadChats() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch (_) {
        return [];
    }
}

function saveChats(chats) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
}

function saveCurrentChat() {
    if (conversation.length === 0) return;

    const chats = loadChats();
    const title = (conversation[0]?.text || "Untitled chat").slice(0, 40);

    if (currentChatId) {
        // Update existing
        const idx = chats.findIndex(c => c.id === currentChatId);
        if (idx !== -1) {
            chats[idx].messages = [...conversation];
            chats[idx].title    = title;
        }
    } else {
        // Create new entry
        currentChatId = Date.now();
        chats.unshift({
            id:        currentChatId,
            title:     title,
            messages:  [...conversation],
            createdAt: new Date().toISOString()
        });
        // Keep only the latest 30 chats
        if (chats.length > 30) chats.splice(30);
    }

    saveChats(chats);
    renderChatHistory();
}

function deleteChat(id) {
    const chats = loadChats().filter(c => c.id !== id);
    saveChats(chats);
    if (currentChatId === id) {
        currentChatId = null;
        clearConversation(false);
    }
    renderChatHistory();
}

function loadChat(id) {
    // Save current work first
    saveCurrentChat();

    const chats = loadChats();
    const chat  = chats.find(c => c.id === id);
    if (!chat) return;

    currentChatId = id;

    // Clear view and reload messages
    messages.replaceChildren();
    welcome.hidden = true;
    conversation.length = 0;

    chat.messages.forEach(msg => {
        conversation.push(msg);
        addMessage(msg.role, msg.text);
    });

    renderChatHistory();
    sidebar.classList.remove("open");
    input.focus();
}

// ── Chat history sidebar ──────────────────────────────────────

function formatDate(isoString) {
    if (!isoString) return "";
    const d    = new Date(isoString);
    const now  = new Date();
    const diff = now - d;
    if (diff < 86400000)  return "Today";
    if (diff < 172800000) return "Yesterday";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderChatHistory() {
    const chats = loadChats();
    chatHistoryEl.replaceChildren();

    if (chats.length === 0) {
        const empty = document.createElement("div");
        empty.className = "chat-history-empty";
        empty.textContent = "No recent chats";
        chatHistoryEl.appendChild(empty);
        return;
    }

    chats.forEach(chat => {
        const item = document.createElement("div");
        item.className = "chat-item" + (chat.id === currentChatId ? " active" : "");
        item.dataset.id = chat.id;

        const info = document.createElement("div");
        info.className = "chat-item-info";

        const title = document.createElement("div");
        title.className = "chat-item-title";
        title.textContent = chat.title || "Untitled chat";

        const date = document.createElement("div");
        date.className = "chat-item-date";
        date.textContent = formatDate(chat.createdAt);

        info.append(title, date);

        const del = document.createElement("button");
        del.className = "chat-item-delete";
        del.textContent = "×";
        del.title = "Delete chat";
        del.setAttribute("aria-label", "Delete chat");
        del.addEventListener("click", function (e) {
            e.stopPropagation();
            deleteChat(chat.id);
        });

        item.append(info, del);
        item.addEventListener("click", function () {
            loadChat(chat.id);
        });

        chatHistoryEl.appendChild(item);
    });
}

// ── Username display ──────────────────────────────────────────

(async function initUser() {
    try {
        if (!window.supabaseReady) return;
        const supabaseClient = await window.supabaseReady;
        const { data: { user } } = await supabaseClient.auth.getUser();
        if (user) {
            const name = user.user_metadata?.full_name
                || user.email?.split("@")[0]
                || "You";
            if (topbarUsername) {
                topbarUsername.textContent = name;
            }
        }
    } catch (_) {
        // Supabase not available or guest — silently skip
    }
})();

// ── Toast ─────────────────────────────────────────────────────

function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
}

// ── Message rendering ─────────────────────────────────────────

function addMessage(role, text) {
    welcome.hidden = true;

    const wrapper = document.createElement("div");
    wrapper.className = `message ${role}`;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = role === "user" ? "You" : "M";

    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = text;

    wrapper.append(avatar, body);
    messages.appendChild(wrapper);

    wrapper.scrollIntoView({ behavior: "smooth", block: "nearest" });

    return wrapper;
}

function showTyping() {
    const wrapper = document.createElement("div");
    wrapper.className = "message assistant";
    wrapper.id = "typing-indicator";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "M";

    const body = document.createElement("div");
    body.className = "message-body";

    const dots = document.createElement("div");
    dots.className = "typing";

    for (let i = 0; i < 3; i++) {
        dots.appendChild(document.createElement("span"));
    }

    body.appendChild(dots);
    wrapper.append(avatar, body);
    messages.appendChild(wrapper);

    wrapper.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── Input auto-resize ─────────────────────────────────────────

function updateInput() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
    charCount.textContent = `${input.value.length} / 4000`;
}

// ── Send message ──────────────────────────────────────────────

async function sendMessage(rawText) {
    const text = rawText.trim();
    if (!text || sendButton.disabled) return;

    if (text.length > 4000) {
        showToast("Please keep your message under 4,000 characters.");
        return;
    }

    addMessage("user", text);
    conversation.push({ role: "user", text });

    input.value = "";
    updateInput();

    sendButton.disabled = true;
    showTyping();

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: conversation.slice(-12) })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Something went wrong. Please try again.");
        }

        if (typeof data.reply !== "string" || !data.reply.trim()) {
            throw new Error("MannSathi returned an empty response.");
        }

        conversation.push({ role: "assistant", text: data.reply });

        document.getElementById("typing-indicator")?.remove();
        addMessage("assistant", data.reply);

        // Auto-save after each assistant reply
        saveCurrentChat();

    } catch (error) {
        document.getElementById("typing-indicator")?.remove();

        addMessage(
            "assistant",
            error.message || "I'm having trouble connecting right now. Please try again."
        );

        // Remove the unanswered user turn from API history
        conversation.pop();

    } finally {
        sendButton.disabled = false;
        input.focus();
    }
}

// ── Clear / New conversation ──────────────────────────────────

function clearConversation(save = true) {
    if (save) saveCurrentChat();

    currentChatId = null;
    conversation.length = 0;

    messages.replaceChildren();
    welcome.hidden = false;

    input.value = "";
    updateInput();

    sidebar.classList.remove("open");
    renderChatHistory();
    input.focus();
}

// ── Event wiring ──────────────────────────────────────────────

form.addEventListener("submit", function (event) {
    event.preventDefault();
    sendMessage(input.value);
});

input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
    }
});

input.addEventListener("input", updateInput);

document.querySelectorAll("[data-prompt]").forEach(function (button) {
    button.addEventListener("click", function () {
        sendMessage(button.dataset.prompt);
    });
});

document.getElementById("new-chat").addEventListener("click", function () {
    clearConversation(true);
});

document.getElementById("clear-chat").addEventListener("click", function () {
    clearConversation(false);
});

// Mobile sidebar
document.getElementById("mobile-menu").addEventListener("click", function () {
    sidebar.classList.toggle("open");
});

document.addEventListener("click", function (event) {
    if (
        window.innerWidth <= 800 &&
        sidebar.classList.contains("open") &&
        !sidebar.contains(event.target) &&
        !event.target.closest("#mobile-menu")
    ) {
        sidebar.classList.remove("open");
    }
});

// ── Init ─────────────────────────────────────────────────────

renderChatHistory();
