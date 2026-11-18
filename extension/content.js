// R'Rate content script: finds instructor names on UCR's Banner registration page
// and puts an RMP badge next to each one.

(() => {
  const DONE = "rrateDone";

  // Turn "Last, First M." or "First Last" into {first, last}.
  function parseName(raw) {
    const text = raw.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
    if (!text || /^(tba|staff|to be announced)$/i.test(text)) return null;
    if (text.includes(",")) {
      const [last, rest] = text.split(",").map(s => s.trim());
      return { first: (rest || "").split(" ")[0], last };
    }
    const parts = text.split(" ");
    if (parts.length < 2) return null;
    return { first: parts[0], last: parts[parts.length - 1] };
  }

  function colorFor(rating) {
    if (rating >= 4) return "rrate-good";
    if (rating >= 3) return "rrate-ok";
    return "rrate-bad";
  }

  function makeBadge(name, r) {
    const a = document.createElement("a");
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "rrate-badge";

    if (!r || !r.found || !r.count) {
      a.href = "https://www.ratemyprofessors.com/search/professors?q=" + encodeURIComponent(`${name.first} ${name.last}`);
      a.classList.add("rrate-none");
      a.textContent = r && r.error ? "RMP ?" : "No RMP";
      a.title = r && r.error ? "Couldn't reach Rate My Professors: " + r.error : "No ratings found — click to search RMP";
      return a;
    }

    a.href = "https://www.ratemyprofessors.com/professor/" + r.id;
    a.classList.add(colorFor(r.rating));
    if (r.count < 5) a.classList.add("rrate-few");
    a.textContent = `★ ${r.rating.toFixed(1)}`;
    const wta = r.wta >= 0 ? `${Math.round(r.wta)}% would take again` : "would-take-again n/a";
    a.title =
      `${r.name}${r.dept ? " · " + r.dept : ""}\n` +
      `Rating ${r.rating.toFixed(1)}/5 · Difficulty ${r.difficulty.toFixed(1)}/5\n` +
      `${wta} · ${r.count} rating${r.count === 1 ? "" : "s"}` +
      (r.ambiguous ? "\n⚠ Name match isn't exact — double-check it's the right person" : "") +
      (r.count < 5 ? "\n⚠ Few ratings — take with a grain of salt" : "");

    const diff = document.createElement("span");
    diff.className = "rrate-sub";
    diff.textContent = ` · D ${r.difficulty.toFixed(1)} · ${r.count}`;
    a.appendChild(diff);
    return a;
  }

  // Elements that hold one instructor name each.
  function findNameElements() {
    const els = [];

    // 1) Banner 9 grids tag cells with data-property="instructor".
    document.querySelectorAll('td[data-property="instructor"], [data-property="instructor"]').forEach(cell => {
      const links = cell.querySelectorAll("a.email, a[href^='mailto:']");
      if (links.length) links.forEach(l => els.push(l));
      else if (cell.textContent.trim()) els.push(cell);
    });

    // 2) Fallback: any table column whose header says "Instructor".
    document.querySelectorAll("table").forEach(table => {
      if (table.closest(".rr-panel")) return;
      const headers = [...table.querySelectorAll("thead th, tr:first-child th")];
      const idx = headers.findIndex(th => /^\s*instructor/i.test(th.textContent));
      if (idx < 0) return;
      table.querySelectorAll("tbody tr").forEach(tr => {
        const cell = tr.children[idx];
        if (!cell || cell.querySelector(".rrate-badge")) return;
        const links = cell.querySelectorAll("a.email, a[href^='mailto:']");
        if (links.length) links.forEach(l => els.push(l));
        else if (cell.textContent.trim()) els.push(cell);
      });
    });

    // 3) Class-detail popups list instructors as mailto links too.
    document.querySelectorAll(".meeting-faculty a.email, .faculty-name a.email, span.email").forEach(el => els.push(el));

    return [...new Set(els)].filter(el => !el.dataset[DONE]);
  }

  async function process() {
    for (const el of findNameElements()) {
      el.dataset[DONE] = "1";
      const name = parseName(el.textContent);
      if (!name) continue;

      const holder = document.createElement("span");
      holder.className = "rrate-holder";
      holder.innerHTML = '<span class="rrate-badge rrate-loading">…</span>';
      el.insertAdjacentElement("afterend", holder);

      browser.runtime
        .sendMessage({ type: "rmpLookup", first: name.first, last: name.last })
        .then(r => holder.replaceChildren(makeBadge(name, r)))
        .catch(err => holder.replaceChildren(makeBadge(name, { found: false, error: String(err) })));
    }
  }

  // Banner loads results with JavaScript, so watch for new rows.
  let timer = null;
  // Ignore changes that are only our own badges being added.
  const ours = m => m.target.nodeType === 1 && m.target.closest && m.target.closest(".rrate-holder");
  new MutationObserver(muts => {
    if (muts.every(ours)) return;
    clearTimeout(timer);
    timer = setTimeout(process, 300);
  }).observe(document.body, { childList: true, subtree: true });

  process();
})();
