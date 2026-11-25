/* Server time + a monotonic clock; redraw intervals never measure study time. */
(function () {
    "use strict";
    function create(performanceNow = () => performance.now()) {
        let serverMs = Date.now(), anchor = performanceNow();
        return Object.freeze({
            sync(iso) { const value = Date.parse(iso); if (!Number.isFinite(value)) throw new Error("Invalid server time"); serverMs = value; anchor = performanceNow(); },
            now: () => serverMs + performanceNow() - anchor,
            remaining(session) {
                if (!session) return 0;
                if (session.status !== "running") return Math.max(0, Number(session.remaining_seconds) || 0);
                const deadline = Date.parse(session.deadline_at);
                return Number.isFinite(deadline) ? Math.max(0, Math.min(session.planned_seconds, (deadline - (serverMs + performanceNow() - anchor)) / 1000)) : 0;
            }
        });
    }
    function format(seconds) { const whole = Math.ceil(Math.max(0, seconds)); return String(Math.floor(whole / 60)).padStart(2, "0") + ":" + String(whole % 60).padStart(2, "0"); }
    window.MannSathiFocusClock = Object.freeze({ create, format });
})();
