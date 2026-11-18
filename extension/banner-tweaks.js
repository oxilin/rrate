// Improvements to Banner's own class search results table. Independent of the rest of
// R'Rate (it only shares the settings key), so it can be split into its own extension.
//   - re-sorts results: lectures, then discussions, then labs; Mon/Wed/Fri before Tue/Thu
//     (done by banner-hook.js inside the page)
//   - sets Banner's "Per Page" to your preferred number of results
//   - adds a colored type tag to every row and a divider between courses
// Settings: rrSettings.banner = { sort: true, tags: true, pageSize: 50 }
(() => {
  const DEFAULTS = { sort: true, tags: true, pageSize: 50 };
  let cfg = { ...DEFAULTS };
  let userPickedSize = false; // once you change "Per Page" yourself, R'Rate leaves it alone

  // Page script that re-sorts Banner's results (it needs to run in the page itself).
  try {
    const s = document.createElement("script");
    s.src = browser.runtime.getURL("banner-hook.js");
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (_) {}

  const sendConfig = () => window.postMessage({ source: "rrate-banner-config", config: { sort: cfg.sort } }, location.origin);

  async function loadConfig() {
    try {
      const { rrSettings } = await browser.storage.local.get("rrSettings");
      cfg = Object.assign({}, DEFAULTS, (rrSettings && rrSettings.banner) || {});
    } catch (_) {}
    sendConfig();
    document.documentElement.classList.toggle("rr-bt-on", !!cfg.tags);
    apply();
  }
  browser.storage.onChanged.addListener(changes => { if (changes.rrSettings) { userPickedSize = false; loadConfig(); } });
  // The page script may load after the first config message; send again once it's there.
  setTimeout(sendConfig, 500);

  function setPageSize() {
    const sel = document.querySelector(".page-size-select");
    if (!sel || userPickedSize || !cfg.pageSize) return;
    if (!sel.dataset.rrWatch) {
      sel.dataset.rrWatch = "1";
      sel.addEventListener("change", e => { if (e.isTrusted) userPickedSize = true; });
    }
    const want = String(cfg.pageSize);
    if (![...sel.options].some(o => o.value === want)) sel.append(new Option(want, want));
    if (sel.value !== want) {
      sel.value = want;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  const TYPE_CLASS = { Lecture: "lec", Discussion: "dis", Laboratory: "lab", Workshop: "wks", Seminar: "sem", Studio: "stu", Activity: "act" };
  const cell = (tr, prop) => tr.querySelector(`td[data-property="${prop}"]`);
  const val = td => (td ? (td.getAttribute("title") || td.textContent || "").trim() : "");

  function decorate() {
    if (!cfg.tags) return;
    const table = document.getElementById("table1");
    if (!table || !table.tBodies[0]) return;
    let prevCourse = null;
    for (const tr of table.tBodies[0].rows) {
      const course = val(cell(tr, "subject")) + " " + val(cell(tr, "courseNumber"));
      const type = val(cell(tr, "scheduleType"));
      tr.classList.toggle("rr-bt-newcourse", prevCourse !== null && course !== prevCourse);
      prevCourse = course;
      const cls = TYPE_CLASS[type] || "other";
      tr.dataset.rrType = cls;
      const title = cell(tr, "courseTitle");
      if (title && type && !title.querySelector(".rr-bt-tag")) {
        const tag = document.createElement("span");
        tag.className = "rr-bt-tag rr-bt-" + cls;
        tag.textContent = type;
        const seq = val(cell(tr, "sequenceNumber"));
        if (seq) tag.title = `Section ${seq}`;
        title.prepend(tag);
      }
    }
  }

  function apply() { setPageSize(); decorate(); }

  let timer = null;
  new MutationObserver(muts => {
    if (muts.every(m => m.target.closest && m.target.closest(".rr-panel, .rr-bt-tag"))) return;
    clearTimeout(timer);
    timer = setTimeout(apply, 120);
  }).observe(document.body, { childList: true, subtree: true });

  loadConfig();
})();
