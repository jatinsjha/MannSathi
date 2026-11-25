/* Local animal artwork, chosen once per account in this browser. */
(function (root) {
    "use strict";
    const avatars = Object.freeze([
        { id: "cat", name: "Cat", src: "images/avatars/cat.svg" },
        { id: "dog", name: "Dog", src: "images/avatars/dog.svg" },
        { id: "fox", name: "Fox", src: "images/avatars/fox.svg" },
        { id: "panda", name: "Panda", src: "images/avatars/panda.svg" },
        { id: "bunny", name: "Bunny", src: "images/avatars/bunny.svg" },
        { id: "bear", name: "Bear", src: "images/avatars/bear.svg" },
        { id: "frog", name: "Frog", src: "images/avatars/frog.svg" }
    ].map(Object.freeze));
    const choices = new Map();
    const accountKey = userId => "mannsathi.avatar." + encodeURIComponent(String(userId || "guest"));
    function randomIndex() {
        if (root.crypto && typeof root.crypto.getRandomValues === "function") {
            const random = new Uint32Array(1);
            root.crypto.getRandomValues(random);
            return Math.floor(random[0] / 4294967296 * avatars.length);
        }
        return Math.floor(Math.random() * avatars.length);
    }
    function get(userId) {
        const key = accountKey(userId);
        if (choices.has(key)) return choices.get(key);
        let saved;
        try { saved = root.localStorage.getItem(key); } catch (_) { /* Storage may be disabled. */ }
        const avatar = avatars.find(item => item.id === saved) || avatars[randomIndex()];
        choices.set(key, avatar);
        try { root.localStorage.setItem(key, avatar.id); } catch (_) { /* Keep the in-memory choice. */ }
        return avatar;
    }
    function paint(element, userId, options = {}) {
        if (!element) return null;
        const avatar = get(userId);
        const img = element.ownerDocument.createElement("img");
        img.src = avatar.src;
        img.alt = options.alt === undefined ? avatar.name + " avatar" : options.alt;
        img.className = "avatar-art";
        img.width = 80;
        img.height = 80;
        img.draggable = false;
        element.replaceChildren(img);
        element.dataset.avatar = avatar.id;
        return avatar;
    }
    const api = Object.freeze({ all: avatars, get, paint });
    root.MannSathiAvatars = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
