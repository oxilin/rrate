// Schedule builder: every conflict-free combination of the chosen courses, ranked by your
// preferences. Pure functions (no browser APIs). Uses RRLink for lecture/discussion/lab pairing.
var RRBuild = (() => {
  const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const LETTER = { monday: "M", tuesday: "T", wednesday: "W", thursday: "R", friday: "F", saturday: "S", sunday: "U" };
  const toMin = hhmm => (hhmm ? parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2), 10) : null);

  // [{ day, start, end }] for one section (sections with no set time return []).
  function meetings(section) {
    const out = [];
    for (const mf of section.meetingsFaculty || []) {
      const mt = mf.meetingTime || {};
      const start = toMin(mt.beginTime), end = toMin(mt.endTime);
      if (start == null || end == null) continue;
      for (const d of DAYS) if (mt[d]) out.push({ day: d, start, end });
    }
    return out;
  }

  const overlaps = (a, b) => a.day === b.day && a.start < b.end && b.start < a.end;

  // prefs (all optional):
  //   openOnly: skip sections with no real open seats   realOpen: fn(section) -> seats
  //   daysOff: ["friday"]   earliest: minutes (e.g. 540 = 9:00)   latest: minutes
  //   mondayEarliest: minutes   fridayLatest: minutes
  //   avoidOdds: fn(section) -> "bad" | ... (skip "bad"/"full" when set)
  function allowedPackage(pkg, prefs) {
    for (const s of pkg.sections) {
      if (prefs.openOnly && prefs.realOpen && !(prefs.realOpen(s) > 0)) return false;
      if (prefs.avoidOdds) {
        const lv = prefs.avoidOdds(s);
        if (lv === "bad" || lv === "full") return false;
      }
      for (const m of meetings(s)) {
        if (prefs.daysOff && prefs.daysOff.includes(m.day)) return false;
        if (prefs.earliest != null && m.start < prefs.earliest) return false;
        if (prefs.latest != null && m.end > prefs.latest) return false;
        if (m.day === "monday" && prefs.mondayEarliest != null && m.start < prefs.mondayEarliest) return false;
        if (m.day === "friday" && prefs.fridayLatest != null && m.end > prefs.fridayLatest) return false;
      }
    }
    return true;
  }

  // Lower is better. Weighs: days on campus, gaps between classes, Friday finish, early starts.
  function score(blocks, prefs) {
    const w = Object.assign({ day: 60, gap: 1, friday: 1, early: 1 }, prefs.weights || {});
    const byDay = new Map();
    for (const b of blocks) {
      if (!byDay.has(b.day)) byDay.set(b.day, []);
      byDay.get(b.day).push(b);
    }
    let gaps = 0, early = 0, fridayEnd = 0;
    for (const [day, list] of byDay) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) gaps += Math.max(0, list[i].start - list[i - 1].end);
      early += Math.max(0, 600 - list[0].start); // minutes before 10:00
      if (day === "friday") fridayEnd = Math.max(...list.map(b => b.end));
    }
    const fridayPenalty = fridayEnd ? Math.max(0, fridayEnd - 720) : 0; // minutes past noon
    return {
      total: w.day * byDay.size + w.gap * gaps + w.friday * fridayPenalty + w.early * early,
      days: byDay.size, gaps, fridayEnd, early
    };
  }

  // courses: [{ key: "CS 100", packages: [{ sections }] }]
  // fixed: [{ day, start, end, label }] busy time that can't move (e.g. current registration)
  // -> { results: [{ packages: [...], score }], total, truncated, emptyCourses: [keys] }
  function search(courses, fixed, prefs, limits) {
    prefs = prefs || {};
    const maxKeep = (limits && limits.keep) || 40;
    const maxVisit = (limits && limits.visit) || 300000;
    const filtered = courses.map(c => ({
      key: c.key,
      packages: c.packages.filter(p => allowedPackage(p, prefs))
        .map(p => ({ ...p, blocks: p.sections.flatMap(meetings) }))
        .filter(p => !p.blocks.some(b => (fixed || []).some(f => overlaps(b, f))))
    }));
    const emptyCourses = filtered.filter(c => !c.packages.length).map(c => c.key);
    if (emptyCourses.length) return { results: [], total: 0, truncated: false, emptyCourses };

    // Most constrained course first keeps the search small.
    const order = [...filtered].sort((a, b) => a.packages.length - b.packages.length);
    const results = [];
    let total = 0, visits = 0, truncated = false;
    const chosen = [];
    const busy = [...(fixed || [])];

    (function dfs(i) {
      if (truncated) return;
      if (i === order.length) {
        total++;
        const blocks = chosen.flatMap(p => p.blocks).concat(fixed || []);
        results.push({ packages: [...chosen], score: score(blocks, prefs) });
        if (results.length > maxKeep * 4) {
          results.sort((a, b) => a.score.total - b.score.total);
          results.length = maxKeep;
        }
        return;
      }
      for (const p of order[i].packages) {
        if (++visits > maxVisit) { truncated = true; return; }
        if (p.blocks.some(b => busy.some(x => overlaps(b, x)))) continue;
        chosen.push(p);
        busy.push(...p.blocks);
        dfs(i + 1);
        busy.length -= p.blocks.length;
        chosen.pop();
      }
    })(0);

    results.sort((a, b) => a.score.total - b.score.total);
    results.length = Math.min(results.length, maxKeep);
    return { results, total, truncated, emptyCourses: [] };
  }

  return { search, meetings, score, DAYS, LETTER };
})();
