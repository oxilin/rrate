// Runs inside Banner's class search page (page context, not the extension sandbox).
// Banner's server can only sort by course + section number, which mixes lectures in with
// discussions. When Banner asks for a page of results in its default order, this fetches the
// whole search once, re-sorts it, and answers Banner's request with the right slice, so
// Banner's own table and paging keep working, just in a better order:
//   course (Banner's order) -> Lecture, Discussion, Lab, ... -> Mon/Wed/Fri before Tue/Thu
//   -> more meeting days first -> earliest day -> start time -> section number
// If anything goes wrong it lets Banner's original request through untouched.
(() => {
  let cfg = { sort: true, maxSort: 3000 };
  window.addEventListener("message", e => {
    if (e.source === window && e.data && e.data.source === "rrate-banner-config") cfg = Object.assign(cfg, e.data.config || {});
  });

  const TYPES = ["Lecture", "Seminar", "Studio", "Discussion", "Workshop", "Laboratory", "Activity", "Research", "Individual Study"];
  const DAYS = [["monday", "M"], ["tuesday", "T"], ["wednesday", "W"], ["thursday", "R"], ["friday", "F"], ["saturday", "S"], ["sunday", "U"]];

  function info(s) {
    const letters = new Set();
    let start = 9999;
    for (const mf of s.meetingsFaculty || []) {
      const mt = mf.meetingTime || {};
      for (const [k, l] of DAYS) if (mt[k]) letters.add(l);
      if (mt.beginTime) start = Math.min(start, parseInt(mt.beginTime, 10));
    }
    const L = [...letters];
    const family = !L.length ? 4
      : L.every(l => "MWF".includes(l)) ? 0
      : L.every(l => "TR".includes(l)) ? 1
      : L.some(l => "SU".includes(l)) ? 3 : 2;
    const first = L.length ? Math.min(...L.map(l => "MTWRFSU".indexOf(l))) : 9;
    const t = (s.scheduleTypeDescription || "").trim();
    const type = TYPES.indexOf(t) < 0 ? TYPES.length : TYPES.indexOf(t);
    return { family, n: L.length, first, start, type };
  }

  function sortSections(list) {
    const courseOrder = new Map();
    list.forEach(s => { const k = s.subject + " " + s.courseNumber; if (!courseOrder.has(k)) courseOrder.set(k, courseOrder.size); });
    const keyed = list.map(s => ({ s, c: courseOrder.get(s.subject + " " + s.courseNumber), i: info(s) }));
    keyed.sort((a, b) => a.c - b.c || a.i.type - b.i.type || a.i.family - b.i.family || b.i.n - a.i.n
      || a.i.first - b.i.first || a.i.start - b.i.start || String(a.s.sequenceNumber).localeCompare(String(b.s.sequenceNumber)));
    return keyed.map(k => k.s);
  }

  const cache = new Map(); // search (without paging) -> { t, p: Promise<{ first, sorted }> }
  const headers = () => ({
    "X-Requested-With": "XMLHttpRequest",
    "X-Synchronizer-Token": (document.querySelector('meta[name="synchronizerToken"]') || {}).content || "",
    Accept: "application/json, text/javascript, */*; q=0.01"
  });

  function sortedFor(u) {
    const q = new URLSearchParams(u.search);
    q.delete("pageOffset"); q.delete("pageMaxSize");
    const key = u.pathname + "?" + q.toString();
    const hit = cache.get(key);
    // Seat counts change, so a cached search is only reused for paging within ~2 minutes.
    if (hit && Date.now() - hit.t < 120000) return hit.p;
    const p = (async () => {
      let first = null;
      const all = [];
      for (let offset = 0; ; offset += 500) {
        q.set("pageOffset", String(offset)); q.set("pageMaxSize", "500");
        const res = await fetch(u.pathname + "?" + q.toString(), { credentials: "include", headers: headers() });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        if (!first) {
          first = json;
          if ((json.totalCount || 0) > cfg.maxSort) throw new Error("too many results to re-sort (" + json.totalCount + ")");
        }
        const page = json.data || [];
        all.push(...page);
        if (!page.length || all.length >= (json.totalCount || 0)) break;
      }
      return { first, sorted: sortSections(all) };
    })();
    cache.set(key, { t: Date.now(), p });
    p.catch(() => cache.delete(key));
    return p;
  }

  function respond(xhr, u, all) {
    const offset = parseInt(u.searchParams.get("pageOffset") || "0", 10);
    const max = parseInt(u.searchParams.get("pageMaxSize") || "10", 10);
    const slice = all.sorted.slice(offset, offset + max);
    const body = Object.assign({}, all.first, {
      data: slice, pageOffset: offset, pageMaxSize: max,
      totalCount: all.first.totalCount, sectionsFetchedCount: all.first.totalCount
    });
    const text = JSON.stringify(body);
    const def = (k, v) => Object.defineProperty(xhr, k, { configurable: true, get: () => v });
    def("readyState", 4);
    def("status", 200);
    def("statusText", "OK");
    def("responseURL", u.href);
    def("responseText", text);
    def("response", xhr.responseType === "json" ? body : text);
    xhr.getResponseHeader = n => (/content-type/i.test(n) ? "application/json;charset=utf-8" : null);
    xhr.getAllResponseHeaders = () => "content-type: application/json;charset=utf-8\r\n";
    setTimeout(() => {
      for (const type of ["readystatechange", "load", "loadend"]) xhr.dispatchEvent(new Event(type));
      window.postMessage({ source: "rrate-banner-sorted" }, location.origin);
    }, 0);
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__rrSort = null;
    try {
      const u = new URL(String(url), location.href);
      if (/\/searchResults\/searchResults$/.test(u.pathname) && cfg.sort
          && (u.searchParams.get("sortColumn") || "subjectDescription") === "subjectDescription"
          && (u.searchParams.get("sortDirection") || "asc") === "asc") this.__rrSort = u;
    } catch (_) {}
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const u = this.__rrSort;
    if (!u) return origSend.call(this, body);
    const xhr = this;
    sortedFor(u)
      .then(all => respond(xhr, u, all))
      .catch(err => { console.info("R'Rate: kept Banner's order:", err.message); origSend.call(xhr, body); });
  };
})();
