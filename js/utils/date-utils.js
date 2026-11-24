/* Calendar dates stay local; timed events travel to the API as UTC instants. */
(function (root) {
    "use strict";
    const pad = n => String(n).padStart(2, "0");
    function dateKey(value = new Date()) {
        return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    }
    function parseDate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new Error("Choose a valid date.");
        const result = new Date(value + "T00:00:00");
        if (!Number.isFinite(result.getTime()) || dateKey(result) !== value) throw new Error("Choose a valid date.");
        return result;
    }
    function addDays(value, count) {
        const result = parseDate(typeof value === "string" ? value : dateKey(value));
        result.setDate(result.getDate() + count);
        return dateKey(result);
    }
    function shiftMonth(value, count) {
        const result = parseDate(value);
        const day = result.getDate();
        result.setDate(1);
        result.setMonth(result.getMonth() + count);
        const last = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
        result.setDate(Math.min(day, last));
        return dateKey(result);
    }
    function range(value, view) {
        let start = parseDate(value);
        if (view === "month") start.setDate(1);
        if (view !== "day") start.setDate(start.getDate() - (start.getDay() + 6) % 7);
        const key = dateKey(start);
        return { start: key, end: addDays(key, view === "month" ? 42 : view === "week" ? 7 : 1) };
    }
    function localInput(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return "";
        return `${dateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
    function toInstant(value) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || "")) throw new Error("Choose a valid date and time.");
        const result = new Date(value);
        if (!Number.isFinite(result.getTime()) || localInput(result) !== value) {
            throw new Error("This local time does not exist. Choose another time (check the daylight-saving change).");
        }
        return result.toISOString();
    }
    function bounds(event) {
        return event.all_day
            ? [parseDate(event.start_date).getTime(), parseDate(event.end_date).getTime()]
            : [new Date(event.starts_at).getTime(), new Date(event.ends_at).getTime()];
    }
    function onDay(event, key) {
        if (event.all_day) return event.start_date <= key && event.end_date > key;
        const [start, end] = bounds(event);
        return start < parseDate(addDays(key, 1)).getTime() && end > parseDate(key).getTime();
    }
    function overlaps(a, b) {
        const [as, ae] = bounds(a), [bs, be] = bounds(b);
        return as < be && bs < ae;
    }
    function sortEvents(events) {
        return [...events].sort((a, b) => Number(b.all_day) - Number(a.all_day) || bounds(a)[0] - bounds(b)[0] || a.id.localeCompare(b.id));
    }
    const api = { dateKey, parseDate, addDays, shiftMonth, range, localInput, toInstant, bounds, onDay, overlaps, sortEvents };
    root.MannSathiDates = Object.freeze(api);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
