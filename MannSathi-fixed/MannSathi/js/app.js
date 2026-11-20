
const form = document.getElementById("chat-form");
const input = document.getElementById("message-input");
const messages = document.getElementById("messages");
const welcome = document.getElementById("welcome");
const sendButton = document.getElementById("send-button");
const charCount = document.getElementById("char-count");
const toast = document.getElementById("toast");
const sidebar = document.getElementById("sidebar");

const conversation = [];

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");

  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

function addMessage(role, text) {
  welcome.hidden = true;

  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "You" : "M";

  const body = document.createElement("div");
  body.className = "message-body";

  // Use textContent to display text safely.
  body.textContent = text;

  wrapper.append(avatar, body);
  messages.appendChild(wrapper);

  wrapper.scrollIntoView({
    behavior: "smooth",
    block: "nearest"
  });

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
    const dot = document.createElement("span");
    dots.appendChild(dot);
  }

  body.appendChild(dots);
  wrapper.append(avatar, body);
  messages.appendChild(wrapper);

  wrapper.scrollIntoView({
    behavior: "smooth",
    block: "nearest"
  });
}

function updateInput() {
  input.style.height = "auto";

  input.style.height =
    Math.min(input.scrollHeight, 160) + "px";

  charCount.textContent =
    `${input.value.length} / 4000`;
}

async function sendMessage(rawText) {
  const text = rawText.trim();

  if (!text || sendButton.disabled) {
    return;
  }

  if (text.length > 4000) {
    showToast("Please keep your message under 4,000 characters.");
    return;
  }

  addMessage("user", text);

  conversation.push({
    role: "user",
    text: text
  });

  input.value = "";
  updateInput();

  sendButton.disabled = true;
  showTyping();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: conversation.slice(-12)
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Something went wrong. Please try again."
      );
    }

    if (typeof data.reply !== "string" || !data.reply.trim()) {
      throw new Error("MannSathi returned an empty response.");
    }

    conversation.push({
      role: "assistant",
      text: data.reply
    });

    document
      .getElementById("typing-indicator")
      ?.remove();

    addMessage("assistant", data.reply);

  } catch (error) {
    document
      .getElementById("typing-indicator")
      ?.remove();

    addMessage(
      "assistant",
      error.message ||
        "I'm having trouble connecting right now. Please try again."
    );

    // Remove the unanswered user turn from API history.
    conversation.pop();

  } finally {
    sendButton.disabled = false;
    input.focus();
  }
}

// Send messages using the form.
form.addEventListener("submit", function (event) {
  event.preventDefault();
  sendMessage(input.value);
});

// Enter sends; Shift + Enter creates a new line.
input.addEventListener("keydown", function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", updateInput);

// Suggested prompt cards.
document.querySelectorAll("[data-prompt]").forEach(function (button) {
  button.addEventListener("click", function () {
    sendMessage(button.dataset.prompt);
  });
});

// Clear the current conversation.
function clearConversation() {
  conversation.length = 0;

  messages.replaceChildren();
  welcome.hidden = false;

  input.value = "";
  updateInput();

  sidebar.classList.remove("open");
  input.focus();
}

document
  .getElementById("new-chat")
  .addEventListener("click", clearConversation);

document
  .getElementById("clear-chat")
  .addEventListener("click", clearConversation);

// Mobile sidebar.
document
  .getElementById("mobile-menu")
  .addEventListener("click", function () {
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
