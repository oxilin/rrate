// Registration side: a panel listing your unmet Degree Works requirements.
// Click one to see every section offered this term that satisfies it,
// with time conflicts against your current schedule, seats and RMP scores.
(() => {
  const BASE = "/StudentRegistrationSsb/ssb";
  const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const DAY_LETTER = { sunday: "Su", monday: "M", tuesday: "T", wednesday: "W", thursday: "R", friday: "F", saturday: "Sa" };
  // Banner caches results per search session ID, so every search gets a fresh one.
  const newSessionId = () => Math.random().toString(36).slice(2, 7) + Date.now();
  const searchLog = [];
  const lastErrors = [];
  let pageTerm = null;
  let lastSearchSample = null;

  // ---------- Banner API helpers ----------
  let queue = Promise.resolve();
  function serial(fn) {
    // Banner keeps search state in your session, so searches must run one at a time.
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  }

  // Firefox content scripts need absolute URLs; content.fetch sends the request as the page itself
  // (same cookies and origin as the registration page).
  const pageFetch = (path, opts) => {
    const url = new URL(path, location.origin).href;
    return (typeof content !== "undefined" && content.fetch) ? content.fetch(url, opts) : fetch(url, opts);
  };

  // Banner rejects API calls without the page's anti-forgery token.
  const syncToken = () => document.querySelector('meta[name="synchronizerToken"]')?.content || "";
  const apiHeaders = () => ({
    "X-Requested-With": "XMLHttpRequest",
    "X-Synchronizer-Token": syncToken(),
    Accept: "application/json, text/javascript, */*; q=0.01"
  });

  async function bannerPost(path, data) {
    const res = await pageFetch(BASE + path, {
      method: "POST",
      credentials: "include",
      headers: { ...apiHeaders(), "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams(data)
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.text();
  }

  async function bannerGet(path) {
    const res = await pageFetch(BASE + path, { credentials: "include", headers: apiHeaders() });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
  }

  async function getTerms() {
    return bannerGet(`/classSearch/getTerms?searchTerm=&offset=1&max=15&_=${Date.now()}`);
  }

  const searchCache = new Map();
  function searchSections(term, params) {
    const key = term + JSON.stringify(params);
    if (searchCache.has(key)) return searchCache.get(key);
    const p = serial(async () => {
      // The registration page already has the term set in your session, so we only
      // clear the previous search (same as the page's "Search Again" button).
      try { await bannerPost("/classSearch/resetDataForm", {}); } catch (err) { lastErrors.push("reset: " + err); }
      const sid = newSessionId();
      const data = [];
      let json = {};
      for (let offset = 0; offset < 3000; offset += 500) {
        const q = new URLSearchParams({
          txt_term: term, startDatepicker: "", endDatepicker: "", uniqueSessionId: sid,
          pageOffset: String(offset), pageMaxSize: "500", sortColumn: "subjectDescription", sortDirection: "asc", ...params
        });
        json = await bannerGet(`/searchResults/searchResults?${q}`);
        const page = json.data || [];
        data.push(...page);
        if (!page.length || !json.totalCount || data.length >= json.totalCount) break;
      }
      if (!lastSearchSample && data[0]) lastSearchSample = data[0];
      searchLog.push({
        params, totalCount: json.totalCount, returned: data.length,
        courses: [...new Set(data.map(s => s.subject + " " + s.courseNumber))].slice(0, 8)
      });
      if (searchLog.length > 30) searchLog.shift();
      return data;
    });
    searchCache.set(key, p);
    p.catch(() => searchCache.delete(key));
    return p;
  }

  // Your registered classes, as weekly time blocks: [{day, start, end, label}]
  async function getMySchedule(term) {
    try {
      // Same call the registration page makes (blank termFilter = the term you're registering for).
      const events = await bannerGet(`/classRegistration/getRegistrationEvents?termFilter=`);
      if (events && events[0] && events[0].term) pageTerm = events[0].term;
      return (events || []).filter(ev => !term || !ev.term || ev.term === term).map(ev => {
        const s = new Date(ev.start), e = new Date(ev.end);
        return {
          day: DAYS[s.getDay()],
          start: s.getHours() * 60 + s.getMinutes(),
          end: e.getHours() * 60 + e.getMinutes(),
          label: ev.subject ? `${ev.subject} ${ev.courseNumber}` : (ev.title || "registered class"),
          subject: ev.subject, courseNumber: ev.courseNumber
        };
      });
    } catch (err) {
      lastErrors.push("schedule: " + err);
      return null;
    }
  }

  // ---------- Seats ----------
  // Banner's seatsAvailable includes seats held for reserved groups, and for cross-listed
  // courses ignores the shared pool. This is what a regular student can actually take
  // (same formula as tracker/tracker.py).
  function realOpen(s) {
    let n = s.seatsAvailable || 0;
    if (s.reservedSeatSummary) n = s.reservedSeatSummary.seatsAvailableUnreserved || 0;
    if (s.crossList) n = Math.min(n, s.crossListAvailable || 0);
    return Math.max(n, 0);
  }

  function seatNote(s) {
    const open = realOpen(s), listed = s.seatsAvailable || 0;
    if (open === listed || listed <= 0) return null;
    const rs = s.reservedSeatSummary;
    const afterReserved = rs ? (rs.seatsAvailableUnreserved || 0) : listed;
    if (s.crossList && (s.crossListAvailable || 0) < afterReserved)
      return `Banner says ${listed}, but the pool shared with a cross-listed course has ${Math.max(s.crossListAvailable || 0, 0)} left`;
    if (rs) return `Banner says ${listed}, but ${rs.seatsAvailableReserved || 0} are reserved for a specific group`;
    return `Banner says ${listed}`;
  }

  // Fill-up history from the seat tracker, loaded once per term through the background script.
  const fillCache = new Map();
  function getFill(term) {
    if (!fillCache.has(term)) {
      const p = browser.runtime.sendMessage({ type: "fillData", term }).catch(err => ({ error: String(err) }));
      fillCache.set(term, p);
    }
    return fillCache.get(term);
  }

  const fmtDate = t => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  function sparkline(h) {
    const W = 64, H = 16;
    const pts = [...h, [Date.now() / 1000, h[h.length - 1][1]]];
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
    const max = Math.max(1, ...pts.map(p => p[1]));
    const x = t => ((t - t0) / (t1 - t0 || 1)) * W, y = v => H - 1 - (v / max) * (H - 2);
    let d = `M0 ${y(pts[0][1]).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i][0]).toFixed(1)} V${y(pts[i][1]).toFixed(1)}`;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", W); svg.setAttribute("height", H); svg.setAttribute("class", "rr-spark");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
    const title = document.createElementNS(ns, "title");
    title.textContent = "Open seats since " + fmtDate(t0) + ": " + h.map(p => `${fmtDate(p[0])} ${p[1]}`).join(", ");
    svg.append(title);
    return svg;
  }

  // One short line about how this section has filled, e.g. "filled Nov 20 · reopened 2×".
  // liveOpen is what Banner says right now; the tracker's data can be up to 2 hours old,
  // so "full"-type notes are only shown when the section is still full.
  function fillLine(f, liveOpen) {
    if (!f) return null;
    const bits = [];
    const nowOpen = liveOpen == null ? f.o : liveOpen;
    if (nowOpen > 0 && f.h) {
      const dayAgo = Date.now() / 1000 - 86400;
      const before = [...f.h].reverse().find(p => p[0] <= dayAgo);
      if (before && before[1] > nowOpen) bits.push(`−${before[1] - nowOpen} in last day`);
    }
    if (nowOpen === 0) {
      if (f.f) bits.push(`filled ${fmtDate(f.f)}`);
      if (f.fb) bits.push("full since tracking began");
      if (f.lo && !f.f) bits.push(`last open ${fmtDate(f.lo)}`);
    }
    if (f.r) bits.push(`reopened ${f.r}×`);
    if (!bits.length && !f.h) return null;
    return el("div", { class: "rr-fill" }, f.h ? sparkline(f.h) : null, bits.length ? " " + bits.join(" · ") : null);
  }

  // ---------- Section helpers ----------
  const TYPE_ORDER = ["Lecture", "Discussion", "Workshop", "Laboratory", "Studio", "Seminar", "Activity"];
  const typeName = s => (s.scheduleTypeDescription || "Other").trim() || "Other";
  const typeRank = t => { const i = TYPE_ORDER.indexOf(t); return i < 0 ? TYPE_ORDER.length : i; };
  const plural = (t, n) => {
    const label = t === "Laboratory" ? "Lab" : t;
    return `${n} ${n === 1 ? label : label.replace(/y$/, "ie") + "s"}`;
  };
  const titleCase = t => t.toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase())
    .replace(/\b(And|Or|Of|The|In|For|To|With|A|An)\b/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase())
    .replace(/\b(Ii|Iii|Iv)\b/g, w => w.toUpperCase());
  const toMin = hhmm => (hhmm ? parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2), 10) : null);
  const fmtTime = m => {
    const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0");
    return `${((h + 11) % 12) + 1}:${mm}${h < 12 ? "a" : "p"}`;
  };

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

  function meetingText(section) {
    const groups = new Map();
    for (const m of meetings(section)) {
      const k = `${m.start}-${m.end}`;
      if (!groups.has(k)) groups.set(k, { ...m, days: "" });
      groups.get(k).days += DAY_LETTER[m.day];
    }
    if (!groups.size) return "TBA / online";
    return [...groups.values()].map(g => `${g.days} ${fmtTime(g.start)}–${fmtTime(g.end)}`).join(", ");
  }

  function conflicts(section, mine) {
    if (!mine) return section.status && section.status.timeConflict ? ["your schedule"] : null;
    const hits = [];
    for (const m of meetings(section))
      for (const c of mine)
        if (c.day === m.day && m.start < c.end && c.start < m.end) hits.push(c.label);
    return [...new Set(hits)];
  }

  function matchesOption(section, opt) {
    if (opt.subject && opt.subject !== "@" && section.subject !== opt.subject) return false;
    if (opt.number && opt.number !== "@") {
      const num = section.courseNumber;
      if (opt.numberEnd) {
        if (num < opt.number || num > opt.numberEnd) return false;
      } else if (opt.number.includes("@")) {
        const re = new RegExp("^" + opt.number.replace(/@/g, ".*") + "$", "i");
        if (!re.test(num)) return false;
      } else if (num !== opt.number) return false;
    }
    // Banner's search results usually leave sectionAttributes empty, so only filter on
    // attributes when Banner actually sent them (the search itself already filtered by attribute).
    if (opt.attrs.length && Array.isArray(section.sectionAttributes) && section.sectionAttributes.length) {
      const codes = section.sectionAttributes.map(a => a.code);
      if (!opt.attrs.some(a => codes.includes(a))) return false;
    }
    return true;
  }

  // "BIOL ----" in Degree Works is a placeholder for transfer credit, not a real course.
  const isPlaceholder = opt => /-/.test(opt.number || "");

  async function sectionsForRequirement(term, req) {
    const all = [];
    let rawCount = 0;
    const opts = req.options.filter(o => !isPlaceholder(o));

    // Attribute-based options (e.g. Sci-A = BEBS): one search per attribute.
    for (const opt of opts.filter(o => o.attrs.length)) {
      for (const attr of opt.attrs) {
        const params = { txt_attribute: attr };
        if (opt.subject && opt.subject !== "@") params.txt_subject = opt.subject;
        const found = await searchSections(term, params);
        rawCount += found.length;
        all.push(...found.filter(s => matchesOption(s, opt)));
      }
    }

    // Course options, grouped by subject. A subject with several options or a wildcard
    // (like 48 tech electives, or CS 179@) is searched once as a whole subject.
    const bySubject = new Map();
    for (const opt of opts.filter(o => !o.attrs.length && o.subject && o.subject !== "@")) {
      if (!bySubject.has(opt.subject)) bySubject.set(opt.subject, []);
      bySubject.get(opt.subject).push(opt);
    }
    for (const [subject, list] of bySubject) {
      const wide = list.length >= 3 || list.some(o => !o.number || o.number === "@" || o.number.includes("@") || o.numberEnd);
      if (wide) {
        const found = await searchSections(term, { txt_subject: subject });
        rawCount += found.length;
        all.push(...found.filter(s => list.some(o => matchesOption(s, o))));
        continue;
      }
      for (const opt of list) {
        let found = await searchSections(term, { txt_subjectcoursecombo: subject + opt.number });
        let matched = found.filter(s => matchesOption(s, opt));
        if (!matched.length) {
          // Fallback: separate subject + number fields.
          found = await searchSections(term, { txt_subject: subject, txt_courseNumber: opt.number });
          matched = found.filter(s => matchesOption(s, opt));
        }
        rawCount += found.length;
        all.push(...matched);
      }
    }

    const byCrn = new Map(all.map(s => [s.courseReferenceNumber, s]));
    const sections = [...byCrn.values()].sort((a, b) =>
      `${a.subject}${a.courseNumber}${a.scheduleTypeDescription}${a.sequenceNumber}`.localeCompare(
        `${b.subject}${b.courseNumber}${b.scheduleTypeDescription}${b.sequenceNumber}`));
    sections.rawCount = rawCount;
    return sections;
  }

  // ---------- UI ----------
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : String(k));
    return e;
  };

  const picked = new Map(); // CRN -> label, for "copy all CRNs"

  const fab = el("button", { class: "rr-fab", title: "Find classes for your unmet requirements" }, "Requirements");
  const panel = el("div", { class: "rr-panel rr-hidden" });
  document.body.append(fab, panel);
  fab.addEventListener("click", () => {
    panel.classList.toggle("rr-hidden");
    if (!panel.dataset.loaded) render();
  });

  async function render() {
    panel.dataset.loaded = "1";
    panel.replaceChildren(el("div", { class: "rr-muted" }, "Loading…"));

    const { dwRequirements, dwCapturedAt, dwError } = await browser.storage.local.get(["dwRequirements", "dwCapturedAt", "dwError"]);
    let terms = [];
    try { terms = await getTerms(); } catch (err) { lastErrors.push("terms: " + err); }

    const header = el("div", { class: "rr-head" },
      el("strong", {}, "Unmet requirements"),
      el("button", { class: "rr-x", onclick: () => panel.classList.add("rr-hidden") }, "×"));

    const termSel = el("select", { class: "rr-term" },
      terms.map(t => el("option", { value: t.code }, t.description)));
    // Default to the term your registration session is on (e.g. 202710 = Winter 2027).
    await getMySchedule(null);
    const firstOpen = terms.find(t => !/view only/i.test(t.description));
    if (pageTerm && terms.some(t => t.code === pageTerm)) termSel.value = pageTerm;
    else if (pageTerm) termSel.prepend(el("option", { value: pageTerm, selected: "" }, pageTerm));
    else if (firstOpen) termSel.value = firstOpen.code;

    const openOnly = el("input", { type: "checkbox", id: "rr-open" });
    const noConflict = el("input", { type: "checkbox", id: "rr-nc" });
    const controls = el("div", { class: "rr-controls" },
      termSel,
      el("label", {}, openOnly, " Open seats only"),
      el("label", {}, noConflict, " Hide conflicts"));

    const pickedBar = el("div", { class: "rr-picked" });
    function refreshPicked() {
      pickedBar.replaceChildren();
      if (!picked.size) return;
      pickedBar.append(
        el("span", {}, `Picked CRNs: ${[...picked.keys()].join(", ")} `),
        el("button", { onclick: () => { navigator.clipboard.writeText([...picked.keys()].join(" ")); flash(pickedBar, "Copied, paste into the Enter CRNs tab"); } }, "Copy"),
        el("button", { onclick: () => { picked.clear(); refreshPicked(); } }, "Clear"));
    }

    const list = el("div", { class: "rr-list" });
    const footer = el("div", { class: "rr-foot" },
      el("button", { onclick: copyDebug }, "Copy debug info"),
      el("span", { class: "rr-muted" }, dwCapturedAt ? ` Audit from ${new Date(dwCapturedAt).toLocaleString()}` : ""));

    panel.replaceChildren(header, controls, pickedBar, list, footer);

    if (!dwRequirements || !dwRequirements.length) {
      list.append(el("p", { class: "rr-muted" },
        dwError ? `Couldn't read your Degree Works audit (${dwError}). ` : "",
        "Open Degree Works (degreeworks.ucr.edu) in another tab and let it load once. Then come back and reopen this panel."));
      return;
    }

    let mine = null;
    const loadMine = async () => { mine = await getMySchedule(termSel.value); };
    await loadMine();
    termSel.addEventListener("change", async () => { await loadMine(); list.querySelectorAll(".rr-sections").forEach(s => s.remove()); });

    let lastBlock = "";
    for (const req of dwRequirements) {
      if (req.block !== lastBlock) {
        list.append(el("div", { class: "rr-block" }, req.block));
        lastBlock = req.block;
      }
      const optText = req.options.filter(o => !isPlaceholder(o)).map(o =>
        o.attrs.length ? `${o.subject && o.subject !== "@" ? o.subject + " " : ""}${o.number && o.number !== "@" ? o.number + (o.numberEnd ? "–" + o.numberEnd : "") + " " : ""}with attribute ${o.attrs.join("/")}`
          : `${o.subject} ${o.number}${o.numberEnd ? "–" + o.numberEnd : ""}`).join(", ");
      const registered = (mine || []).find(m => req.options.some(o => o.subject === m.subject && o.number === m.courseNumber));
      const row = el("div", { class: "rr-req" + (registered ? " rr-req-done" : "") },
        el("div", { class: "rr-req-title" },
          req.parent ? el("span", { class: "rr-muted" }, req.parent + " › ") : null,
          req.label,
          req.needed ? el("span", { class: "rr-muted" }, ` (${req.needed})`) : null,
          registered ? el("span", { class: "rr-badge-reg" }, `✓ registered: ${registered.subject} ${registered.courseNumber}`) : null),
        el("div", { class: "rr-req-opts" }, optText));
      row.addEventListener("click", () => toggle(row, req));
      list.append(row);
    }

    async function toggle(row, req) {
      const existing = row.nextElementSibling;
      if (existing && existing.classList.contains("rr-sections")) { existing.remove(); return; }
      const box = el("div", { class: "rr-sections" }, el("div", { class: "rr-muted" }, "Searching…"));
      row.after(box);
      try {
        const [sections, fill] = await Promise.all([sectionsForRequirement(termSel.value, req), getFill(termSel.value)]);
        box.replaceChildren(sectionTable(sections, fill));
      } catch (err) {
        lastErrors.push(`search ${req.label}: ${err}`);
        box.replaceChildren(el("div", { class: "rr-err" }, "Search failed: " + err.message));
      }
    }

    function sectionTable(sections, fill) {
      const fillOf = s => (fill && fill.s && fill.s[s.courseReferenceNumber]) || null;
      if (fill && fill.error) lastErrors.push("fill: " + fill.error);
      const rows = sections.filter(s => {
        if (openOnly.checked && !(realOpen(s) > 0)) return false;
        const c = conflicts(s, mine);
        if (noConflict.checked && c && c.length) return false;
        return true;
      });
      if (!rows.length) {
        if (sections.length) {
          const full = sections.every(s => !(realOpen(s) > 0));
          return el("div", { class: "rr-muted" }, full && openOnly.checked
            ? `All ${sections.length} sections are full. Uncheck "Open seats only" to see them and their waitlists.`
            : `All ${sections.length} sections are hidden by your filters.`);
        }
        return el("div", { class: "rr-err" }, sections.rawCount
          ? `Banner returned ${sections.rawCount} sections, but none matched this requirement. Click "Copy debug info" and send it to Claude.`
          : `No sections came back from Banner for this term. If you can find it in the normal search, click "Copy debug info" and send it to Claude.`);
      }

      // Group by course (the course that satisfies the requirement), then by section type,
      // each type in its own collapsible dropdown.
      const byCourse = new Map();
      for (const s of rows) {
        const key = `${s.subject} ${s.courseNumber}`;
        if (!byCourse.has(key)) byCourse.set(key, []);
        byCourse.get(key).push(s);
      }
      return el("div", { class: "rr-courses" }, [...byCourse].map(([course, list]) => {
        const byType = new Map();
        for (const s of list) {
          const t = typeName(s);
          if (!byType.has(t)) byType.set(t, []);
          byType.get(t).push(s);
        }
        const types = [...byType].sort((a, b) => typeRank(a[0]) - typeRank(b[0]) || a[0].localeCompare(b[0]));
        const openCount = l => l.filter(s => realOpen(s) > 0).length;
        return el("div", { class: "rr-course" },
          el("div", { class: "rr-course-title" }, course,
            el("span", { class: "rr-course-name" }, " · " + titleCase(list[0].courseTitle || ""))),
          types.map(([type, secs], i) => {
            const n = openCount(secs);
            const det = el("details", { class: "rr-type" },
              el("summary", {},
                el("span", { class: "rr-type-name" }, plural(type, secs.length)),
                el("span", { class: n ? "rr-ok" : "rr-full" }, n ? ` · ${n} open` : " · all full")),
              el("table", { class: "rr-table" },
                el("tr", {}, ["Section", "When", "Seats", "Instructor", ""].map(h => el("th", {}, h))),
                // Open sections first, full ones at the bottom (each group keeps section order).
                [...secs].sort((a, b) => (realOpen(b) > 0) - (realOpen(a) > 0)).map(s => sectionRow(s))));
            if (i === 0 || types.length <= 2) det.open = true;
            return det;
          }));
      }));

      function sectionRow(s) {
        const c = conflicts(s, mine);
        const prof = (s.faculty || []).find(f => f.primaryIndicator) || (s.faculty || [])[0];
        const open = realOpen(s), note = seatNote(s);
        const seats = [
          open > 0
            ? el("span", { class: "rr-ok" }, `${open}/${s.maximumEnrollment}`)
            : el("span", { class: "rr-full" }, `Full · WL ${s.waitCount ?? "?"}/${s.waitCapacity ?? "?"}`),
          note ? el("div", { class: "rr-note", title: note }, open > 0 ? "fewer than listed ⓘ" : "not open to you ⓘ") : null,
          fillLine(fillOf(s), open)
        ];
        const crn = s.courseReferenceNumber;
        const pickBtn = el("button", { class: "rr-pick" }, picked.has(crn) ? "✓" : "+");
        pickBtn.addEventListener("click", () => {
          if (picked.has(crn)) picked.delete(crn); else picked.set(crn, `${s.subject} ${s.courseNumber}`);
          pickBtn.textContent = picked.has(crn) ? "✓" : "+";
          refreshPicked();
        });
        return el("tr", { class: c && c.length ? "rr-conflict" : "" },
          el("td", {}, `${s.sequenceNumber}`, el("div", { class: "rr-muted" }, `CRN ${crn}`),
            s.linkIdentifier ? el("div", { class: "rr-muted", title: "Linked sections: a lecture (L…) must be paired with one discussion/lab (D…/B…)" }, `link ${s.linkIdentifier}`) : null),
          el("td", {}, meetingText(s),
            c && c.length ? el("div", { class: "rr-err" }, "Conflicts: " + c.join(", ")) : null),
          el("td", {}, seats),
          // data-property="instructor" + a.email lets the RMP badge script pick this up automatically.
          el("td", { "data-property": "instructor" }, prof ? el("a", { class: "email" }, prof.displayName) : "TBA"),
          el("td", {}, pickBtn));
      }
    }

    if (mine === null) list.prepend(el("div", { class: "rr-err" }, "Couldn't load your current schedule, so conflicts aren't being checked."));
  }

  function flash(node, text) {
    const t = el("span", { class: "rr-flash" }, " " + text);
    node.append(t);
    setTimeout(() => t.remove(), 2500);
  }

  async function copyDebug() {
    const { dwDebug, dwRequirements, dwError } = await browser.storage.local.get(["dwDebug", "dwRequirements", "dwError"]);
    const info = {
      version: browser.runtime.getManifest().version,
      page: location.pathname,
      errors: lastErrors,
      dwError,
      parsedRequirements: dwRequirements,
      auditStructure: dwDebug,
      recentSearches: searchLog,
      sampleSection: lastSearchSample
    };
    await navigator.clipboard.writeText(JSON.stringify(info, null, 2));
    alert("Debug info copied. Paste it to Claude.");
  }
})();
