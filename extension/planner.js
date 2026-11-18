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

  // ---------- Prerequisites ----------
  // Banner writes prerequisites with full subject names ("Computer Science 011"), so map
  // names to codes using the subject lists of this term and a few earlier ones.
  const subjectCache = new Map();
  function getSubjects(term, allTerms) {
    if (subjectCache.has(term)) return subjectCache.get(term);
    const p = (async () => {
      const codes = [term, ...(allTerms || []).map(t => t.code).filter(c => c !== term).slice(0, 4)];
      const map = {};
      for (const code of codes.reverse()) { // newer terms win
        try {
          const list = await bannerGet(`/classSearch/get_subject?searchTerm=&term=${code}&offset=1&max=500&_=${Date.now()}`);
          for (const x of list || []) map[RRPrereq.nameKey(x.description)] = x.code;
        } catch (err) { lastErrors.push(`subjects ${code}: ${err}`); }
      }
      return map;
    })();
    subjectCache.set(term, p);
    return p;
  }

  // At most 3 lookups (prereqs/restrictions/coreqs) in flight at once, so opening a big
  // requirement doesn't fire dozens of Banner requests in parallel.
  let lookupsActive = 0;
  const lookupQueue = [];
  function limited(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        lookupsActive++;
        fn().then(resolve, reject).finally(() => { lookupsActive--; if (lookupQueue.length) lookupQueue.shift()(); });
      };
      lookupsActive < 3 ? go() : lookupQueue.push(go);
    });
  }

  const PRQ_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const prqMemo = new Map();
  function getPrereqs(term, section) {
    const key = `prq:${term}:${section.subject} ${section.courseNumber}`;
    if (prqMemo.has(key)) return prqMemo.get(key);
    const p = (async () => {
      const cached = (await browser.storage.local.get(key))[key];
      if (cached && Date.now() - cached.t < PRQ_TTL_MS) return cached.v;
      const html = await limited(() => bannerPost("/searchResults/getSectionPrerequisites",
        { term, courseReferenceNumber: section.courseReferenceNumber }));
      const v = RRPrereq.parse(html);
      await browser.storage.local.set({ [key]: { t: Date.now(), v } });
      return v;
    })();
    prqMemo.set(key, p);
    p.catch(() => prqMemo.delete(key));
    return p;
  }

  // Restrictions and corequisites: one lookup per course, cached for a week like prerequisites.
  const lookupMemo = new Map();
  function cachedLookup(kind, path, parseFn, term, section) {
    const key = `${kind}:${term}:${section.subject} ${section.courseNumber}`;
    if (lookupMemo.has(key)) return lookupMemo.get(key);
    const p = (async () => {
      const cached = (await browser.storage.local.get(key))[key];
      if (cached && Date.now() - cached.t < PRQ_TTL_MS) return cached.v;
      const html = await limited(() => bannerPost(path, { term, courseReferenceNumber: section.courseReferenceNumber }));
      const v = parseFn(html);
      await browser.storage.local.set({ [key]: { t: Date.now(), v } });
      return v;
    })();
    lookupMemo.set(key, p);
    p.catch(() => lookupMemo.delete(key));
    return p;
  }

  // getCorequisites returns a small table: Subject (full name) | Course Number | Title
  function parseCoreqs(html) {
    const out = [];
    const strip = t => t.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const rowRe = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = rowRe.exec(String(html || "")))) {
      const subjectName = strip(m[1]), number = strip(m[2]).toUpperCase(), title = strip(m[3]);
      if (subjectName && number && !/^subject$/i.test(subjectName)) out.push({ subjectName, number, title });
    }
    return out;
  }
  const getRestrictions = (term, s) => cachedLookup("rst", "/searchResults/getRestrictions", RRRestrict.parse, term, s);
  const getCoreqs = (term, s) => cachedLookup("coq", "/searchResults/getCorequisites", parseCoreqs, term, s);

  // ---------- Settings (registration time, class standing, major) ----------
  async function loadSettings() {
    const { rrSettings, dwStudent } = await browser.storage.local.get(["rrSettings", "dwStudent"]);
    const st = Object.assign({ regTime: "", standing: "", majors: "", prefs: {} }, rrSettings || {});
    if (!st.standing && dwStudent && dwStudent.standing) st.standing = dwStudent.standing;
    if (!st.majors && dwStudent && dwStudent.majors && dwStudent.majors.length) st.majors = dwStudent.majors.join(", ");
    return st;
  }
  const regTimeMs = st => (st && st.regTime ? new Date(st.regTime).getTime() : null);
  const studentOf = st => ({ standing: st.standing, majors: st.majors ? st.majors.split(",").map(x => x.trim()).filter(Boolean) : [] });

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

  // Every section of one course ("CS 100") this term.
  async function courseSections(term, key) {
    const [subject, number] = key.split(/\s+/);
    const match = list => list.filter(s => s.subject === subject && s.courseNumber === number);
    let m = match(await searchSections(term, { txt_subjectcoursecombo: subject + number }));
    if (!m.length) m = match(await searchSections(term, { txt_subject: subject, txt_courseNumber: number }));
    return m;
  }

  // The actual Banner sections you're registered for (for the calendar export and the builder).
  // Matches by CRN when the registration events include one, otherwise by meeting time.
  async function registeredSections(term) {
    let events;
    try { events = await bannerGet(`/classRegistration/getRegistrationEvents?termFilter=`); }
    catch (err) { lastErrors.push("registered: " + err); return null; }
    events = (events || []).filter(ev => !term || !ev.term || ev.term === term);
    const byCourse = new Map();
    for (const ev of events) {
      if (!ev.subject || !ev.courseNumber) continue;
      const k = `${ev.subject} ${ev.courseNumber}`;
      if (!byCourse.has(k)) byCourse.set(k, []);
      byCourse.get(k).push(ev);
    }
    const out = new Map();
    for (const [k, evs] of byCourse) {
      let secs = [];
      try { secs = await courseSections(term, k); } catch (err) { lastErrors.push(`registered ${k}: ${err}`); }
      for (const ev of evs) {
        const crn = ev.crn || ev.courseReferenceNumber;
        let s = crn && secs.find(x => x.courseReferenceNumber === String(crn));
        if (!s) {
          const a = new Date(ev.start), b = new Date(ev.end);
          const day = DAYS[a.getDay()], st = a.getHours() * 60 + a.getMinutes(), en = b.getHours() * 60 + b.getMinutes();
          s = secs.find(x => meetings(x).some(m => m.day === day && m.start === st && m.end === en));
        }
        if (s) out.set(s.courseReferenceNumber, s);
      }
    }
    return [...out.values()];
  }

  function downloadIcs(sections, name) {
    const blob = new Blob([RRIcs.build(sections, name)], { type: "text/calendar" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".ics";
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
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

  // Meeting-day pattern of a section, e.g. { key: "MW", label: "Mon / Wed" }.
  const DAY_NAME = { M: "Mon", T: "Tue", W: "Wed", R: "Thu", F: "Fri", Sa: "Sat", Su: "Sun" };
  const DAY_SEQ = ["M", "T", "W", "R", "F", "Sa", "Su"];
  function dayPattern(section) {
    const letters = [...new Set(meetings(section).map(m => DAY_LETTER[m.day]))].sort((a, b) => DAY_SEQ.indexOf(a) - DAY_SEQ.indexOf(b));
    if (!letters.length) return { key: "", label: "TBA / online", letters };
    return { key: letters.join(""), label: letters.map(l => DAY_NAME[l]).join(" / "), letters };
  }
  // Mon/Wed/Fri-only patterns first, then Tue/Thu-only, then mixed, weekends, and TBA last.
  function comparePattern(a, b) {
    const family = p => !p.letters.length ? 4
      : p.letters.every(l => "MWF".includes(l) && l.length === 1) ? 0
      : p.letters.every(l => l === "T" || l === "R") ? 1
      : p.letters.some(l => l === "Sa" || l === "Su") ? 3 : 2;
    return family(a) - family(b)
      || b.letters.length - a.letters.length
      || DAY_SEQ.indexOf(a.letters[0]) - DAY_SEQ.indexOf(b.letters[0])
      || a.key.localeCompare(b.key);
  }
  const firstStart = s => Math.min(...meetings(s).map(m => m.start), 24 * 60);
  // "9:30a–10:50a" (and a second line if a section has more than one meeting time)
  function timeText(section) {
    const seen = new Set();
    for (const m of meetings(section)) seen.add(`${fmtTime(m.start)}–${fmtTime(m.end)}`);
    return seen.size ? [...seen].join(", ") : "TBA";
  }
  function locationText(section) {
    const mt = ((section.meetingsFaculty || [])[0] || {}).meetingTime || {};
    return [mt.building, mt.room].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" ");
  }

  function conflicts(section, mine) {
    if (!mine) return section.status && section.status.timeConflict ? ["your schedule"] : null;
    const hits = [];
    for (const m of meetings(section))
      for (const c of mine)
        // Your own registration in the same course isn't a conflict (switching sections drops it).
        if (c.day === m.day && m.start < c.end && c.start < m.end &&
            !(c.subject === section.subject && c.courseNumber === section.courseNumber)) hits.push(c.label);
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
    const e = typeof tag === "string" ? document.createElement(tag) : tag;
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : String(k));
    return e;
  };

  const picked = new Map(); // CRN -> label, for "copy all CRNs"

  const fab = el("button", { class: "rr-fab", title: "Requirements, schedule builder and settings" }, "R'Rate");
  const panel = el("div", { class: "rr-panel rr-hidden" });
  document.body.append(fab, panel);
  let rendering = null;
  const ensureRendered = () => (rendering = rendering || render());
  fab.addEventListener("click", () => {
    panel.classList.toggle("rr-hidden");
    ensureRendered();
  });

  // ---------- Banner class search -> "R'Rate view" ----------
  // A tiny page script reports the URL of each Banner search; we add a button next to
  // "Search Again" that re-runs that search with every result and shows it in the panel.
  let lastSearch = null;
  let openSearchView = null; // set by render()
  try {
    const hook = document.createElement("script");
    hook.src = browser.runtime.getURL("search-hook.js");
    (document.head || document.documentElement).appendChild(hook);
    hook.remove();
  } catch (_) {}
  window.addEventListener("message", e => {
    if (e.source !== window || !e.data || e.data.source !== "rrate-search") return;
    if (/pageOffset=0(&|$)/.test(e.data.url) || !lastSearch) lastSearch = { url: e.data.url, total: e.data.total };
    placeSearchButton();
  });
  function placeSearchButton() {
    const anchor = document.getElementById("search-again");
    if (!anchor || !lastSearch) return;
    let btn = document.getElementById("rr-search-view");
    if (!btn) {
      btn = el("button", { id: "rr-search-view", type: "button", class: "rr-search-view-btn",
        title: "Show every result of this search in R'Rate: grouped by course, lecture/discussion/lab and meeting days" });
      btn.addEventListener("click", async () => {
        await ensureRendered();
        if (openSearchView && lastSearch) openSearchView(lastSearch);
      });
      anchor.prepend(btn);
    }
    btn.textContent = lastSearch.total ? `R'Rate view · all ${lastSearch.total}` : "R'Rate view";
  }

  async function render() {
    panel.dataset.loaded = "1";
    panel.replaceChildren(el("div", { class: "rr-muted" }, "Loading…"));

    const { dwRequirements, dwCapturedAt, dwError, dwClasses } = await browser.storage.local.get(["dwRequirements", "dwCapturedAt", "dwError", "dwClasses"]);
    let settings = await loadSettings();
    let terms = [];
    try { terms = await getTerms(); } catch (err) { lastErrors.push("terms: " + err); }

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
    const hidePrq = el("input", { type: "checkbox", id: "rr-prq" });
    hidePrq.addEventListener("change", () => panel.classList.toggle("rr-hide-noprq", hidePrq.checked));
    const controls = el("div", { class: "rr-controls" },
      el("label", {}, openOnly, " Open seats only"),
      el("label", {}, noConflict, " Hide conflicts"),
      el("label", { title: "Hide courses whose prerequisites you're missing" }, hidePrq, " Hide courses I can't take"));

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
    const exportBtn = el("button", { title: "Download your registered classes as a calendar file (Google/Apple Calendar, Outlook)" }, "Export my schedule (.ics)");
    exportBtn.addEventListener("click", async () => {
      exportBtn.disabled = true;
      try {
        const secs = await registeredSections(termSel.value);
        if (!secs || !secs.length) { alert("Couldn't find your registered classes for this term."); return; }
        const termName = termSel.selectedOptions[0] ? termSel.selectedOptions[0].textContent.replace(/\s*\(.*\)/, "") : termSel.value;
        downloadIcs(secs, `UCR ${termName}`);
      } finally { exportBtn.disabled = false; }
    });
    const footer = el("div", { class: "rr-foot" },
      exportBtn,
      el("button", { onclick: copyDebug }, "Copy debug info"),
      el("span", { class: "rr-muted" }, dwCapturedAt ? ` Audit from ${new Date(dwCapturedAt).toLocaleString()}` : ""));

    // ---------- Tabs ----------
    const searchList = el("div", { class: "rr-list" });
    const views = {
      req: el("div", { class: "rr-view" }, pickedBar, list),
      search: el("div", { class: "rr-view rr-hidden" }, searchList),
      build: el("div", { class: "rr-view rr-hidden" }),
      set: el("div", { class: "rr-view rr-hidden" })
    };
    const tabs = el("div", { class: "rr-tabs" });
    const showTab = name => {
      for (const [k, v] of Object.entries(views)) v.classList.toggle("rr-hidden", k !== name);
      tabs.querySelectorAll("button").forEach(b => b.classList.toggle("rr-tab-on", b.dataset.tab === name));
      controls.classList.toggle("rr-hidden", !(name === "req" || name === "search"));
      panel.classList.toggle("rr-wide", name === "search");
    };
    for (const [k, label] of [["req", "Requirements"], ["search", "Search results"], ["build", "Schedule builder"], ["set", "Settings"]])
      tabs.append(el("button", { "data-tab": k, class: k === "search" ? "rr-hidden" : "", onclick: () => showTab(k) }, label));
    const header = el("div", { class: "rr-head" },
      el("strong", {}, "R'Rate"), tabs, termSel,
      el("button", { class: "rr-x", onclick: () => panel.classList.add("rr-hidden") }, "×"));
    panel.replaceChildren(header, controls, views.req, views.search, views.build, views.set, footer);
    showTab("req");

    // Search results view: the current Banner search, all pages, in R'Rate's layout.
    let searchData = null;
    const drawSearch = () => {
      if (!searchData) return;
      const { sections, fill, total, label } = searchData;
      searchList.replaceChildren(
        el("div", { class: "rr-search-head" }, el("strong", {}, label), el("span", { class: "rr-muted" }, ` · ${sections.length}${total && total !== sections.length ? " of " + total : ""} sections`)),
        sectionTable(sections, fill, { openGroups: true }));
    };
    [openOnly, noConflict].forEach(c => c.addEventListener("change", drawSearch));
    openSearchView = async ({ url }) => {
      panel.classList.remove("rr-hidden");
      tabs.querySelector('[data-tab="search"]').classList.remove("rr-hidden");
      showTab("search");
      searchList.replaceChildren(el("div", { class: "rr-muted rr-pad" }, "Loading every result…"));
      try {
        const u = new URL(url, location.origin);
        const q = Object.fromEntries(u.searchParams);
        if (q.txt_term && termSel.value !== q.txt_term) {
          if (![...termSel.options].some(o => o.value === q.txt_term)) termSel.append(el("option", { value: q.txt_term }, q.txt_term));
          termSel.value = q.txt_term;
          await loadMine();
        }
        const sections = await serial(async () => {
          const out = [];
          let total = Infinity;
          for (let offset = 0; offset < total && offset < 5000; offset += 500) {
            const json = await bannerGet(`/searchResults/searchResults?${new URLSearchParams({ ...q, pageOffset: String(offset), pageMaxSize: "500" })}`);
            const page = json.data || [];
            out.push(...page);
            total = json.totalCount || 0;
            if (!page.length) break;
          }
          out.total = total;
          return out;
        });
        const labelBits = [q.txt_subjectcoursecombo, q.txt_subject, q.txt_courseNumber, q.txt_courseTitle, q.txt_keywordlike].filter(Boolean);
        searchData = { sections, total: sections.total, fill: await getFill(termSel.value), label: labelBits.length ? `Search: ${labelBits.join(" ")}` : "Search results" };
        drawSearch();
      } catch (err) {
        lastErrors.push("search view: " + err);
        searchList.replaceChildren(el("div", { class: "rr-err rr-pad" }, "Couldn't load the search results: " + err.message));
      }
    };

    let mine = null;
    let registeredCrns = new Set();
    const loadMine = async () => {
      mine = await getMySchedule(termSel.value);
      try {
        const evs = await bannerGet(`/classRegistration/getRegistrationEvents?termFilter=`);
        registeredCrns = new Set((evs || []).map(ev => String(ev.crn || ev.courseReferenceNumber || "")).filter(Boolean));
      } catch (_) { registeredCrns = new Set(); }
    };
    await loadMine();
    termSel.addEventListener("change", async () => { await loadMine(); list.querySelectorAll(".rr-sections").forEach(s => s.remove()); });

    // Courses in the schedule builder, kept between visits.
    const builder = {
      list: (await browser.storage.local.get("rrBuilder")).rrBuilder || [],
      has(k) { return this.list.includes(k); },
      add(k) { if (!this.has(k)) { this.list.push(k); this.save(); this.onChange(); } },
      remove(k) { this.list = this.list.filter(x => x !== k); this.save(); this.onChange(); },
      save() { browser.storage.local.set({ rrBuilder: this.list }); },
      onChange() {}
    };

    buildSettingsView();
    buildBuilderView();

    if (!dwRequirements || !dwRequirements.length) {
      list.append(el("p", { class: "rr-muted" },
        dwError ? `Couldn't read your Degree Works audit (${dwError}). ` : "",
        "Open Degree Works (degreeworks.ucr.edu) in another tab and let it load once. Then come back and reopen this panel. ",
        "The Schedule builder tab works without it."));
      return;
    }

    // Each Degree Works block (e.g. "Breadth for Bourns College of Engineering") is a
    // collapsible dropdown, closed to start.
    const blocks = new Map();
    for (const req of dwRequirements) {
      const name = req.block || "Other requirements";
      if (!blocks.has(name)) {
        const body = el("div", { class: "rr-block-body" });
        const count = dwRequirements.filter(r => (r.block || "Other requirements") === name).length;
        list.append(el("details", { class: "rr-blockwrap" },
          el("summary", { class: "rr-block" }, name, el("span", { class: "rr-block-count" }, ` · ${count} unmet`)),
          body));
        blocks.set(name, body);
      }
      const blockBody = blocks.get(name);
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
      blockBody.append(row);
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

    async function prereqBadge(section, badge, courseBox, onMissing) {
      const term = termSel.value;
      const set = (cls, text, tip) => {
        badge.className = "rr-prq " + cls;
        badge.textContent = text;
        if (tip) badge.title = tip;
      };
      try {
        if (!Array.isArray(dwClasses)) {
          set("rr-prq-check", "⚠ reopen Degree Works to check prereqs",
            "This R'Rate version also saves the classes you've taken. Open Degree Works once, then reopen this panel.");
          return;
        }
        const [parsed, subjects] = await Promise.all([getPrereqs(term, section), getSubjects(term, terms)]);
        const r = RRPrereq.check(parsed, dwClasses, subjects, term);
        const e = RRPrereq.explain(r);
        const note = r.note ? `\nCatalog note: ${r.note}` : "";
        const lines = [
          e.met.length ? "Have: " + e.met.join(", ") : "",
          e.pending.length ? "In progress: " + e.pending.join(", ") : "",
          e.missing.length ? "Missing: " + e.missing.join("; ") : "",
          e.check.length ? "Can't check automatically: " + e.check.join("; ") : ""
        ].filter(Boolean).join("\n") + note;
        if (r.status === "none") set("rr-prq-none", "no prereqs listed", note.trim() || undefined);
        else if (r.status === "yes") set("rr-prq-yes", "✓ prereqs met", lines);
        else if (r.status === "pending") set("rr-prq-pending", `⏳ prereqs met if you pass ${e.pending.join(", ")}`, lines);
        else if (r.status === "no") {
          const short = t => t.replace(/ \([^)]*or better\)/g, "");
          set("rr-prq-no", `✗ missing ${e.missing.map(short).join("; ")}`, lines);
          courseBox.classList.add("rr-course-noprq");
          if (onMissing) onMissing();
        } else set("rr-prq-check", e.check.some(t => /placement/i.test(t))
            ? "⚠ check prereqs (placement score counts)" : "⚠ check prereqs (hover for details)", lines || r.note);
      } catch (err) {
        lastErrors.push(`prereqs ${section.subject} ${section.courseNumber}: ${err}`);
        set("rr-prq-check", "⚠ couldn't load prereqs", String(err));
      }
    }

    async function restrictionBadge(section, badge, courseBox, onBlocked) {
      try {
        const r = RRRestrict.check(await getRestrictions(termSel.value, section), studentOf(settings));
        if (r.status === "none") { badge.remove(); return; }
        badge.className = "rr-prq " + (r.status === "yes" ? "rr-prq-yes" : r.status === "no" ? "rr-prq-no" : "rr-prq-check");
        badge.textContent = (r.status === "yes" ? "✓ " : r.status === "no" ? "✗ " : "⚠ ") + r.text;
        badge.title = r.tip + (r.status === "check" ? "\nSet your class standing and major in Settings so this can be checked." : "");
        if (r.status === "no") { courseBox.classList.add("rr-course-noprq"); if (onBlocked) onBlocked(); }
      } catch (err) {
        lastErrors.push(`restrictions ${section.subject} ${section.courseNumber}: ${err}`);
        badge.remove();
      }
    }

    async function coreqNote(section, box) {
      try {
        const [co, subjects] = await Promise.all([getCoreqs(termSel.value, section), getSubjects(termSel.value, terms)]);
        if (!co.length) return;
        const names = co.map(c => `${subjects[RRPrereq.nameKey(c.subjectName)] || c.subjectName} ${c.number}`);
        box.textContent = `Also register for ${names.join(" + ")} at the same time (corequisite)`;
        box.title = co.map(c => `${c.subjectName} ${c.number}: ${titleCase(c.title)}`).join("\n");
      } catch (err) { lastErrors.push(`coreqs ${section.subject} ${section.courseNumber}: ${err}`); }
    }

    function oddsLine(s, fillEntry, open) {
      const reg = regTimeMs(settings);
      if (!reg) return null;
      const od = RROdds.estimate(fillEntry, open, reg);
      if (!od.text || od.level === "full") return null; // the seat column already says it's full
      return el("div", { class: "rr-odds rr-odds-" + od.level, title: od.tip }, od.text);
    }

    function sectionTable(sections, fill, opts = {}) {
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
      const allByCourse = new Map();
      for (const s of sections) {
        const key = `${s.subject} ${s.courseNumber}`;
        if (!allByCourse.has(key)) allByCourse.set(key, []);
        allByCourse.get(key).push(s);
      }
      const byCourse = new Map();
      for (const s of rows) {
        const key = `${s.subject} ${s.courseNumber}`;
        if (!byCourse.has(key)) byCourse.set(key, []);
        byCourse.get(key).push(s);
      }
      // Two dropdowns: courses you can take (prereqs met, in progress, or to check by hand)
      // and courses you're missing prerequisites for. Every course starts in the first one
      // and moves down once its prerequisite check comes back missing.
      const canBody = el("div", { class: "rr-prq-group-body" });
      const cantBody = el("div", { class: "rr-prq-group-body" });
      const canSum = el("span"), cantSum = el("span");
      const canGrp = el("details", { class: "rr-prq-group rr-prq-group-ok" }, el("summary", {}, canSum), canBody);
      const cantGrp = el("details", { class: "rr-prq-group rr-prq-group-no" }, el("summary", {}, cantSum), cantBody);
      const refreshGroups = () => {
        const a = canBody.children.length, b = cantBody.children.length;
        canSum.textContent = `✓ Courses you can take · ${a}`;
        cantSum.textContent = `✗ Missing prerequisites or restricted · ${b}`;
        canGrp.classList.toggle("rr-empty", !a);
        cantGrp.classList.toggle("rr-empty", !b);
      };
      const courseBoxes = [...byCourse].map(([course, list]) => {
        const byType = new Map();
        for (const s of list) {
          const t = typeName(s);
          if (!byType.has(t)) byType.set(t, []);
          byType.get(t).push(s);
        }
        const types = [...byType].sort((a, b) => typeRank(a[0]) - typeRank(b[0]) || a[0].localeCompare(b[0]));
        const openCount = l => l.filter(s => realOpen(s) > 0).length;
        const badge = el("span", { class: "rr-prq rr-prq-wait" }, "checking prereqs…");
        const rbadge = el("span", { class: "rr-prq rr-prq-wait" });
        const coreq = el("div", { class: "rr-coreq" });
        const courseBox = el("div", { class: "rr-course" });
        const moveDown = () => { cantBody.append(courseBox); refreshGroups(); };
        prereqBadge(list[0], badge, courseBox, moveDown);
        restrictionBadge(list[0], rbadge, courseBox, moveDown);
        coreqNote(list[0], coreq);
        const addBtn = el("button", { class: "rr-addb", title: "Add this course to the Schedule builder tab" }, builder.has(course) ? "✓ in builder" : "+ builder");
        addBtn.addEventListener("click", () => { builder.add(course); addBtn.textContent = "✓ in builder"; });
        return el(courseBox, {},
          el("div", { class: "rr-course-title" }, course,
            el("span", { class: "rr-course-name" }, " · " + titleCase(list[0].courseTitle || "")), " ", badge, rbadge, addBtn),
          coreq,
          types.map(([type, secs]) => {
            const n = openCount(secs);
            const det = el("details", { class: "rr-type" },
              el("summary", {},
                el("span", { class: "rr-type-name" }, plural(type, secs.length)),
                el("span", { class: n ? "rr-ok" : "rr-full" }, n ? ` · ${n} open` : " · all full")));
            // Rows are only built the first time the dropdown is opened (keeps the panel fast).
            det.addEventListener("toggle", () => {
              if (det.open && !det.dataset.built) { det.dataset.built = "1"; det.append(typeBody(secs)); }
            });
            return det;
          }));
      });
      canBody.append(...courseBoxes);
      refreshGroups();
      if (opts.openGroups) { canGrp.open = true; cantGrp.open = true; }
      return el("div", { class: "rr-courses" }, canGrp, cantGrp);

      // Sections of one type, grouped by meeting days: Mon/Wed/Fri patterns first, then Tue/Thu,
      // then everything else. Inside a group: open seats first, then by start time.
      function typeBody(secs) {
        const groups = new Map();
        for (const sec of secs) {
          const pat = dayPattern(sec);
          if (!groups.has(pat.key)) groups.set(pat.key, { pat, list: [] });
          groups.get(pat.key).list.push(sec);
        }
        const ordered = [...groups.values()].sort((a, b) => comparePattern(a.pat, b.pat));
        return el("div", { class: "rr-type-body" }, ordered.map(({ pat, list: l }) => {
          l.sort((a, b) => ((realOpen(b) > 0) - (realOpen(a) > 0)) || (firstStart(a) - firstStart(b)) || a.sequenceNumber.localeCompare(b.sequenceNumber));
          const n = l.filter(x => realOpen(x) > 0).length;
          return el("div", { class: "rr-daygroup" },
            el("div", { class: "rr-daygroup-head" }, pat.label,
              el("span", { class: "rr-muted" }, ` · ${l.length} section${l.length === 1 ? "" : "s"} · `),
              el("span", { class: n ? "rr-ok" : "rr-full" }, n ? `${n} open` : "all full")),
            l.map(sectionRow));
        }));
      }

      function sectionRow(s) {
        if (!registeredCrns) registeredCrns = new Set();
        const c = conflicts(s, mine);
        const prof = (s.faculty || []).find(f => f.primaryIndicator) || (s.faculty || [])[0];
        const open = realOpen(s), note = seatNote(s);
        const seats = [
          open > 0
            ? el("span", { class: "rr-ok" }, `${open}/${s.maximumEnrollment}`)
            : el("span", { class: "rr-full" }, `Full · WL ${s.waitCount ?? "?"}/${s.waitCapacity ?? "?"}`),
          note ? el("div", { class: "rr-note", title: note }, open > 0 ? "fewer than listed ⓘ" : "not open to you ⓘ") : null,
          fillLine(fillOf(s), open),
          oddsLine(s, fillOf(s), open)
        ];
        const pair = RRLink.describe(s, allByCourse.get(`${s.subject} ${s.courseNumber}`) || [s]);
        const crn = s.courseReferenceNumber;
        const pickBtn = el("button", { class: "rr-pick" }, picked.has(crn) ? "✓" : "+");
        pickBtn.addEventListener("click", () => {
          if (picked.has(crn)) picked.delete(crn); else picked.set(crn, `${s.subject} ${s.courseNumber}`);
          pickBtn.textContent = picked.has(crn) ? "✓" : "+";
          refreshPicked();
        });
        const where = locationText(s);
        return el("div", { class: "rr-row" + (c && c.length ? " rr-conflict" : "") + (open > 0 ? "" : " rr-row-full") },
          el("div", { class: "rr-c-time" }, timeText(s), where ? el("div", { class: "rr-muted" }, where) : null),
          el("div", { class: "rr-c-sec" },
            el("div", {}, el("strong", {}, s.sequenceNumber), el("span", { class: "rr-muted" }, ` · CRN ${crn}`),
              registeredCrns.has(crn) ? el("span", { class: "rr-badge-reg" }, "✓ you're registered") : null),
            pair ? el("div", { class: "rr-pair", title: `Link ${s.linkIdentifier}: a lecture must be taken with one discussion/lab that has the same link number` }, pair) : null,
            c && c.length ? el("div", { class: "rr-err" }, "Conflicts: " + c.join(", ")) : null),
          el("div", { class: "rr-c-seats" }, seats),
          // data-property="instructor" + a.email lets the RMP badge script pick this up automatically.
          el("div", { class: "rr-c-prof", "data-property": "instructor" }, prof ? el("a", { class: "email" }, prof.displayName) : el("span", { class: "rr-muted" }, "TBA")),
          el("div", { class: "rr-c-pick" }, pickBtn));
      }
    }

    if (mine === null) list.prepend(el("div", { class: "rr-err" }, "Couldn't load your current schedule, so conflicts aren't being checked."));

    // ---------- Settings tab ----------
    function buildSettingsView() {
      const v = views.set;
      const regInput = el("input", { type: "datetime-local", value: settings.regTime || "" });
      const standingSel = el("select", {},
        ["", "freshman", "sophomore", "junior", "senior"].map(x => el("option", { value: x }, x ? x[0].toUpperCase() + x.slice(1) : "— not set —")));
      standingSel.value = settings.standing || "";
      const majorsInput = el("input", { type: "text", value: settings.majors || "", placeholder: "e.g. Computer Engineering" });
      const status = el("span", { class: "rr-flash" });
      const bt = Object.assign({ sort: true, tags: true, pageSize: 50 }, settings.banner || {});
      const btSort = el("input", { type: "checkbox" }); btSort.checked = bt.sort;
      const btTags = el("input", { type: "checkbox" }); btTags.checked = bt.tags;
      const btSize = el("select", {}, ["10", "15", "20", "50"].map(n => el("option", { value: n }, n)));
      btSize.value = String(bt.pageSize);
      const save = el("button", { class: "rr-primary" }, "Save");
      save.addEventListener("click", async () => {
        settings = { ...settings, regTime: regInput.value, standing: standingSel.value, majors: majorsInput.value.trim(),
          banner: { sort: btSort.checked, tags: btTags.checked, pageSize: parseInt(btSize.value, 10) } };
        await browser.storage.local.set({ rrSettings: settings });
        list.querySelectorAll(".rr-sections").forEach(x => x.remove()); // re-check on next open
        status.textContent = " Saved.";
        setTimeout(() => (status.textContent = ""), 2000);
      });
      v.replaceChildren(el("div", { class: "rr-settings" },
        el("label", {}, el("strong", {}, "Your registration time"), regInput,
          el("div", { class: "rr-muted" }, "Your pass time for this term (for example, second pass). Used to estimate whether each section will still have seats when you can register.")),
        el("label", {}, el("strong", {}, "Class standing"), standingSel,
          el("div", { class: "rr-muted" }, "For courses restricted to certain class levels (e.g. juniors and seniors only).")),
        el("label", {}, el("strong", {}, "Major(s)"), majorsInput,
          el("div", { class: "rr-muted" }, "Comma-separated, as Banner names them. For major-restricted courses.")),
        el("div", { class: "rr-settings-sub" }, el("strong", {}, "Banner class search results"),
          el("label", { class: "rr-inline" }, btSort, " Re-sort results: lectures, then discussions, then labs (Mon/Wed/Fri before Tue/Thu)"),
          el("label", { class: "rr-inline" }, btTags, " Show a type tag on each row and a line between courses"),
          el("label", { class: "rr-inline" }, "Results per page ", btSize),
          el("div", { class: "rr-muted" }, "Fewer per page is lighter on slower computers. Applies to Banner's own results table; changing “Per Page” there yourself overrides it for that visit.")),
        el("div", {}, save, status),
        el("div", { class: "rr-muted rr-settings-note" },
          "How the odds work: the seat tracker records open seats every couple of hours. R'Rate looks at how fast a section has been losing seats and projects whether any are left at your registration time. ",
          "It's a straight-line estimate, so it can't see sudden rushes, like when a new pass opens. It gets better as more history builds up.")));
    }

    // ---------- Schedule builder tab ----------
    function buildBuilderView() {
      const v = views.build;
      const P = Object.assign({ openOnly: true, includeReg: true, avoidBad: false, daysOff: [], earliest: "", latest: "", monEarliest: "", friLatest: "" }, settings.prefs || {});
      const toMin = t => (t ? parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10) : null);

      const chips = el("div", { class: "rr-chips" });
      const addInput = el("input", { type: "text", class: "rr-add-input", placeholder: "Add a course, e.g. CS 100 or PHYS 40B" });
      const addMsg = el("span", { class: "rr-err" });
      const addCourse = () => {
        const m = /^\s*([A-Za-z]{2,5})\s*-?\s*(\d{1,3})([A-Za-z]{0,3})\s*$/.exec(addInput.value);
        if (!m) { addMsg.textContent = " Type a course like CS 100 or PHYS 040B"; return; }
        const num = (m[3].length <= 1 ? m[2].padStart(3, "0") : m[2]) + m[3].toUpperCase();
        builder.add(`${m[1].toUpperCase()} ${num}`);
        addInput.value = ""; addMsg.textContent = "";
      };
      addInput.addEventListener("keydown", e => { if (e.key === "Enter") addCourse(); });
      const renderChips = () => {
        chips.replaceChildren(...(builder.list.length ? builder.list.map(k =>
          el("span", { class: "rr-chip" }, k, el("button", { title: "Remove", onclick: () => builder.remove(k) }, "×")))
          : [el("span", { class: "rr-muted" }, "No courses yet. Add them here or with “+ builder” in the Requirements tab.")]));
      };
      builder.onChange = renderChips;
      renderChips();

      const chk = (key, label, title) => {
        const c = el("input", { type: "checkbox" });
        c.checked = !!P[key];
        c.addEventListener("change", () => { P[key] = c.checked; savePrefs(); });
        return el("label", title ? { title } : {}, c, " " + label);
      };
      const time = (key, label) => {
        const t = el("input", { type: "time", value: P[key] || "" });
        t.addEventListener("change", () => { P[key] = t.value; savePrefs(); });
        return el("label", { class: "rr-time" }, label + " ", t);
      };
      const dayBoxes = ["monday", "tuesday", "wednesday", "thursday", "friday"].map(d => {
        const c = el("input", { type: "checkbox" });
        c.checked = P.daysOff.includes(d);
        c.addEventListener("change", () => { P.daysOff = c.checked ? [...new Set([...P.daysOff, d])] : P.daysOff.filter(x => x !== d); savePrefs(); });
        return el("label", {}, c, " " + d.slice(0, 3)[0].toUpperCase() + d.slice(1, 3));
      });
      const savePrefs = () => { settings = { ...settings, prefs: P }; browser.storage.local.set({ rrSettings: settings }); };

      const runBtn = el("button", { class: "rr-primary" }, "Find schedules");
      const results = el("div", { class: "rr-results" });
      runBtn.addEventListener("click", () => run().catch(err => {
        lastErrors.push("builder: " + err);
        results.replaceChildren(el("div", { class: "rr-err" }, "Something went wrong: " + err.message));
      }));

      v.replaceChildren(el("div", { class: "rr-builder" },
        el("div", { class: "rr-b-row" }, addInput, el("button", { onclick: addCourse }, "Add"), addMsg),
        chips,
        el("details", { class: "rr-b-prefs" },
          el("summary", {}, "Preferences"),
          el("div", { class: "rr-b-row" }, chk("openOnly", "Only sections with open seats", "Skip full sections and sections whose seats are all reserved"),
            chk("includeReg", "Keep my current registration", "Treat the classes you're registered for as fixed"),
            chk("avoidBad", "Skip sections likely full by my time", "Uses the odds from your registration time in Settings")),
          el("div", { class: "rr-b-row" }, el("span", { class: "rr-muted" }, "Days off:"), dayBoxes),
          el("div", { class: "rr-b-row" }, time("earliest", "Start after"), time("latest", "End by")),
          el("div", { class: "rr-b-row" }, time("monEarliest", "Monday start after"), time("friLatest", "Friday done by"))),
        el("div", { class: "rr-b-row" }, runBtn,
          el("span", { class: "rr-muted" }, " Ranked by fewest days on campus, then shortest gaps, earliest Friday finish, fewest early starts.")),
        results));

      async function run() {
        const term = termSel.value;
        if (!builder.list.length) { results.replaceChildren(el("div", { class: "rr-muted" }, "Add at least one course first.")); return; }
        results.replaceChildren(el("div", { class: "rr-muted" }, "Loading sections…"));
        const fill = await getFill(term);
        const fillOf = s => (fill && fill.s && fill.s[s.courseReferenceNumber]) || null;
        const subjects = await getSubjects(term, terms);
        const keys = [...builder.list];
        const notes = [];
        const courses = [];
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          results.replaceChildren(el("div", { class: "rr-muted" }, `Loading ${k}…`));
          const secs = await courseSections(term, k);
          if (!secs.length) { notes.push(`${k} isn't offered this term, so it was left out.`); continue; }
          courses.push({ key: k, sections: secs });
          try { // corequisites (e.g. a W course's WRIT 040 workshop) are added automatically
            for (const c of await getCoreqs(term, secs[0])) {
              const code = subjects[RRPrereq.nameKey(c.subjectName)];
              const ck = code && `${code} ${c.number}`;
              if (ck && !keys.includes(ck)) { keys.push(ck); notes.push(`Added ${ck}, which has to be taken with ${k}.`); }
            }
          } catch (err) { lastErrors.push(`coreqs ${k}: ${err}`); }
        }

        let regSecs = [];
        let fixed = [];
        if (P.includeReg) {
          regSecs = (await registeredSections(term)) || [];
          regSecs = regSecs.filter(s => !keys.includes(`${s.subject} ${s.courseNumber}`)); // replacing a course you're in
          fixed = regSecs.flatMap(s => RRBuild.meetings(s).map(b => ({ ...b, label: `${s.subject} ${s.courseNumber}` })));
          if (!regSecs.length && mine && mine.length) fixed = mine; // fall back to plain time blocks
        }
        const reg = regTimeMs(settings);
        const prefs = {
          openOnly: P.openOnly, realOpen,
          daysOff: P.daysOff, earliest: toMin(P.earliest), latest: toMin(P.latest),
          mondayEarliest: toMin(P.monEarliest), fridayLatest: toMin(P.friLatest),
          avoidOdds: P.avoidBad && reg ? s => RROdds.estimate(fillOf(s), realOpen(s), reg).level : null
        };
        const res = RRBuild.search(courses.map(c => ({ key: c.key, packages: RRLink.packages(c.sections) })), fixed, prefs, { keep: 40 });

        const head = [];
        for (const n of notes) head.push(el("div", { class: "rr-b-note" }, n));
        if (fixed.length) head.push(el("div", { class: "rr-muted" }, `Working around your current registration: ${[...new Set(fixed.map(f => f.label))].join(", ")}.`));
        if (res.emptyCourses.length) {
          results.replaceChildren(...head, el("div", { class: "rr-err" },
            `No sections of ${res.emptyCourses.join(", ")} fit: they're full, outside your times/days, or conflict with your current classes. Try loosening the preferences.`));
          return;
        }
        if (!res.results.length) {
          results.replaceChildren(...head, el("div", { class: "rr-err" }, "Every combination has a time conflict. Try removing a course or loosening the preferences."));
          return;
        }
        head.push(el("div", { class: "rr-muted" },
          `${res.total.toLocaleString()} conflict-free schedule${res.total === 1 ? "" : "s"}${res.truncated ? " (stopped early, there were too many to check them all)" : ""}. Best ${Math.min(10, res.results.length)} shown.`));
        const cards = res.results.map((r, i) => resultCard(r, i, regSecs, fillOf, reg));
        const more = res.results.length > 10 ? el("button", { onclick: e => { cards.slice(10).forEach(c => c.classList.remove("rr-hidden")); e.target.remove(); } }, `Show ${res.results.length - 10} more`) : null;
        cards.slice(10).forEach(c => c.classList.add("rr-hidden"));
        results.replaceChildren(...head, ...cards, more);
      }

      function resultCard(r, i, regSecs, fillOf, reg) {
        const secs = r.packages.flatMap(p => p.sections);
        const sc = r.score;
        const all = [...secs, ...regSecs];
        const summary = [`${sc.days} day${sc.days === 1 ? "" : "s"} on campus`,
          sc.gaps ? `${Math.round(sc.gaps / 6) / 10}h of gaps` : "no gaps",
          sc.fridayEnd ? `Friday done ${fmtTime(sc.fridayEnd)}` : "Fridays off"].join(" · ");
        const crns = secs.map(s => s.courseReferenceNumber);
        const copyBtn = el("button", {}, "Copy CRNs");
        copyBtn.addEventListener("click", () => { navigator.clipboard.writeText(crns.join(" ")); flash(copyBtn.parentNode, "Copied, paste into the Enter CRNs tab"); });
        const icsBtn = el("button", { title: "Calendar file with these classes plus your current registration" }, "Export .ics");
        icsBtn.addEventListener("click", () => downloadIcs(all, `UCR schedule option ${i + 1}`));
        return el("details", { class: "rr-card" },
          el("summary", {}, el("strong", {}, `Option ${i + 1}`), el("span", { class: "rr-muted" }, " · " + summary)),
          weekGrid(all, new Set(regSecs.map(s => s.courseReferenceNumber))),
          el("table", { class: "rr-table" },
            el("tr", {}, ["Section", "When", "Seats", ""].map(h => el("th", {}, h))),
            secs.map(s => {
              const open = realOpen(s);
              const od = reg ? RROdds.estimate(fillOf(s), open, reg) : null;
              return el("tr", {},
                el("td", {}, `${s.subject} ${s.courseNumber}-${s.sequenceNumber} `, el("span", { class: "rr-muted" }, typeName(s)),
                  el("div", { class: "rr-muted" }, `CRN ${s.courseReferenceNumber}`)),
                el("td", {}, meetingText(s)),
                el("td", {}, open > 0 ? el("span", { class: "rr-ok" }, `${open}/${s.maximumEnrollment}`) : el("span", { class: "rr-full" }, "Full"),
                  od && od.text ? el("div", { class: "rr-odds rr-odds-" + od.level, title: od.tip }, od.text) : null),
                el("td", {}));
            })),
          el("div", { class: "rr-b-row" }, copyBtn, icsBtn));
      }

      // Mon–Fri columns listing each class's time (registered classes in grey).
      function weekGrid(sections, fixedCrns) {
        const cols = ["monday", "tuesday", "wednesday", "thursday", "friday"].map(d => {
          const items = [];
          for (const s of sections) for (const m of RRBuild.meetings(s)) if (m.day === d) items.push({ s, m });
          items.sort((a, b) => a.m.start - b.m.start);
          return el("div", { class: "rr-wk-col" },
            el("div", { class: "rr-wk-day" }, d.slice(0, 3)[0].toUpperCase() + d.slice(1, 3)),
            items.length ? items.map(({ s, m }) => el("div", { class: "rr-wk-item" + (fixedCrns.has(s.courseReferenceNumber) ? " rr-wk-fixed" : "") },
              el("div", {}, `${fmtTime(m.start)}–${fmtTime(m.end)}`),
              el("div", { class: "rr-wk-name" }, `${s.subject} ${s.courseNumber} ${typeName(s).slice(0, 4)}`))) : el("div", { class: "rr-muted rr-wk-free" }, "free"));
        });
        return el("div", { class: "rr-week" }, cols);
      }
    }
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
