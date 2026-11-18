// "Will this section still have a seat when my registration opens?" Pure functions.
//
// Uses the tracker's history for the section (fill.json entry: o = open now,
// h = [[unixSeconds, open, waitlist], ...]) to estimate how fast seats are going,
// then projects whether any are left at your registration time.
// This is a straight-line estimate. Seats usually go fastest right when a new pass opens,
// so the tooltip always says what the estimate is based on.
var RROdds = (() => {
  const HOUR = 3600;
  const fmt = t => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // Seats lost per hour over the last `windowH` hours of history (null if not enough history).
  function rate(h, now, windowH) {
    if (!h || h.length < 2) return null;
    const from = now - windowH * HOUR;
    let start = null;
    for (const p of h) if (p[0] <= from) start = p; // last point at/before window start
    if (!start) start = h[0];
    const end = h[h.length - 1];
    const span = Math.max(now, end[0]) - start[0];
    if (span < 12 * HOUR) return null; // too little history to say anything
    return Math.max(0, start[1] - end[1]) / (span / HOUR);
  }

  // entry: fill.json entry or null. liveOpen: real open seats right now (from Banner).
  // regTime: your registration time in ms (or null). now: seconds.
  // -> { level: "now" | "good" | "risky" | "bad" | "full" | "unknown", text, tip }
  function estimate(entry, liveOpen, regTime, now) {
    now = now || Date.now() / 1000;
    const open = liveOpen != null ? liveOpen : entry ? entry.o : null;
    if (open == null) return { level: "unknown", text: "", tip: "" };
    if (!regTime) return { level: "unknown", text: "", tip: "Set your registration time in Settings to see odds." };
    const reg = regTime / 1000;
    if (reg <= now) {
      return open > 0
        ? { level: "now", text: "open now", tip: "Your registration time has passed, so you can add it now." }
        : { level: "full", text: "full now", tip: "Your registration time has passed and it's full." };
    }
    if (open <= 0) {
      const reopens = entry && entry.r ? ` It has reopened ${entry.r}× since tracking began.` : "";
      return { level: "full", text: "full now", tip: `Full right now.${reopens}` };
    }
    const hoursLeft = (reg - now) / HOUR;
    const r = entry ? (rate(entry.h, now, 72) ?? rate(entry.h, now, 24 * 14)) : null;
    if (r == null) {
      return { level: "unknown", text: "not enough history",
        tip: `${open} open now. The tracker needs at least 12 hours of history for this section to estimate how fast it fills.` };
    }
    if (r === 0) {
      return { level: "good", text: "likely open at your time",
        tip: `${open} open, and no seats were taken recently. Note: seats usually go fastest right when a new pass opens.` };
    }
    const hoursToFill = open / r;
    const fillAt = now + hoursToFill * HOUR;
    const ratio = hoursToFill / hoursLeft;
    const basis = `${open} open, losing about ${(r * 24).toFixed(1)} seats/day → projected to fill around ${fmt(fillAt)}. Your time: ${fmt(reg)}. Straight-line estimate; seats usually go fastest right when a new pass opens.`;
    if (ratio >= 2) return { level: "good", text: "likely open at your time", tip: basis };
    if (ratio >= 1) return { level: "risky", text: "might fill before your time", tip: basis };
    return { level: "bad", text: "likely full by your time", tip: basis };
  }

  return { estimate, rate };
})();
