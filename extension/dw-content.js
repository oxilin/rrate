// Degree Works side: grab the audit the page loads, pull out unmet requirements,
// and save them for the registration page.
(() => {
  // ---------- status box (so it's obvious whether this is working) ----------
  let statusBox = null;
  function status(text, kind = "info") {
    const show = () => {
      if (!statusBox) {
        statusBox = document.createElement("div");
        Object.assign(statusBox.style, {
          position: "fixed", bottom: "20px", right: "20px", zIndex: 2147483647, maxWidth: "380px",
          color: "#fff", padding: "10px 14px", borderRadius: "8px", cursor: "pointer",
          font: "13px/1.4 -apple-system, sans-serif", boxShadow: "0 4px 14px rgba(0,0,0,.25)"
        });
        statusBox.title = "Click to hide";
        statusBox.addEventListener("click", () => statusBox.remove());
        document.body.appendChild(statusBox);
      }
      statusBox.style.background = kind === "error" ? "#a12121" : kind === "ok" ? "#17692f" : "#1f3a6e";
      statusBox.textContent = "R'Rate: " + text;
    };
    document.body ? show() : document.addEventListener("DOMContentLoaded", show, { once: true });
  }
  status("running, waiting for your audit to load…");

  const looksLikeAudit = text => text && text.length > 200 && text.includes('"blockArray"');

  // ---------- capture method 1: small script that watches the page's own requests (read-only) ----------
  try {
    const s = document.createElement("script");
    s.src = browser.runtime.getURL("dw-hook.js");
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (_) {}

  // Firefox content scripts need absolute URLs; content.fetch sends the request as the page itself.
  const pageFetch = (path, opts) => {
    const url = new URL(path, location.origin).href;
    return (typeof content !== "undefined" && content.fetch) ? content.fetch(url, opts) : fetch(url, opts);
  };

  function handleText(text, how) {
    try { handleAudit(JSON.parse(text), how); } catch (_) {}
  }

  // Blocks that are informational or that just repeat course lists from other blocks.
  const SKIP_BLOCK = /\bgpa\b|informational/i;
  // Degree Works uses 98/99 for "in progress / registered".
  const DONE_PCT = 98;

  function toOption(c) {
    if (!c) return null;
    const subject = (c.discipline || "").trim();
    const number = (c.number || "").trim();
    const attrs = [];
    for (const w of c.withArray || []) {
      if (/attr/i.test(w.code || "")) attrs.push(...(w.valueList || []));
    }
    if (!subject && !attrs.length) return null;
    if (c.hideFromAdvice === "Yes") return null;
    return { subject, number, numberEnd: (c.numberEnd || "").trim(), attrs };
  }

  function describe(rule) {
    const r = rule.requirement || {};
    if (r.classesBegin) return `${r.classesBegin} class${r.classesBegin === "1" ? "" : "es"}`;
    if (r.creditsBegin) return `${r.creditsBegin}${r.creditsEnd && r.creditsEnd !== r.creditsBegin ? "–" + r.creditsEnd : ""} units`;
    return "";
  }

  function parseAudit(audit) {
    const out = [];
    const seen = new Set();

    function walk(rules, block, parent) {
      for (const rule of rules || []) {
        const pct = Number(rule.percentComplete ?? 0);
        const type = String(rule.ruleType || "").toLowerCase();
        if (pct >= DONE_PCT) continue;
        if (["block", "blocktype", "noncourse", "complete", "incomplete"].includes(type)) continue;

        if (rule.ruleArray && rule.ruleArray.length) {
          walk(rule.ruleArray, block, rule.label || parent);
          continue;
        }
        const courses =
          (rule.advice && rule.advice.courseArray && rule.advice.courseArray.length && rule.advice.courseArray) ||
          (rule.requirement && rule.requirement.courseArray) ||
          [];
        const options = courses.map(toOption).filter(Boolean);
        if (!options.length) continue;

        const key = options.map(o => `${o.subject}${o.number}${o.attrs.join()}`).join("|");
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          id: rule.nodeId || key,
          block,
          parent: parent && parent !== rule.label ? parent : "",
          label: rule.label || "Requirement",
          needed: describe(rule),
          options
        });
      }
    }

    for (const block of audit.blockArray || []) {
      if (SKIP_BLOCK.test(block.title || "")) continue;
      walk(block.ruleArray, block.title || block.requirementValue || "");
    }
    return out;
  }

  // Every class on the audit (taken, in progress, registered, transfer), for prerequisite checks.
  // Degree Works lists them under classInformation.classArray and again under each rule's
  // classesAppliedToRule, so walk the whole audit and keep anything that looks like a class.
  function extractClasses(audit) {
    const out = new Map();
    const seen = new WeakSet();
    const yes = v => v === true || /^(y|yes|true)$/i.test(String(v || ""));
    (function walk(node) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.discipline && node.number && ("letterGrade" in node || "grade" in node)) {
        const g = String(node.letterGrade ?? node.grade ?? "").trim();
        const c = {
          s: String(node.discipline).trim().toUpperCase(),
          n: String(node.number).trim().toUpperCase(),
          g,
          ip: yes(node.inProgress) || yes(node.preregistered) || /^(IP|REG|PR|PREREG)$/i.test(g),
          term: String(node.term || node.termCode || "").trim()
        };
        if (c.s && c.n && !/^-+$/.test(c.n)) out.set(`${c.s}|${c.n}|${c.g}|${c.term}|${c.ip}`, c);
      }
      for (const v of Object.values(node)) if (v && typeof v === "object") walk(v);
    })(audit);
    return [...out.values()];
  }

  // Class standing and major(s), for course restrictions. Best effort: Degree Works keeps
  // goals like {code: "MAJOR", valueLiteral: "Computer Engineering"} and a class-level field.
  function extractStudent(audit) {
    const majors = new Set();
    let standing = "";
    const seen = new WeakSet();
    (function walk(node) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (/^major$/i.test(String(node.code || "")) && (node.valueLiteral || node.description))
        majors.add(String(node.valueLiteral || node.description).trim());
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string" && !standing && /class|standing/i.test(k)) {
          const m = /\b(freshman|sophomore|junior|senior)\b/i.exec(v);
          if (m) standing = m[1].toLowerCase();
        } else if (v && typeof v === "object") walk(v);
      }
    })(audit);
    return { standing, majors: [...majors] };
  }

  function toast(text) {
    const t = document.createElement("div");
    t.textContent = text;
    Object.assign(t.style, {
      position: "fixed", bottom: "20px", right: "20px", zIndex: 2147483647,
      background: "#1f3a6e", color: "#fff", padding: "10px 14px", borderRadius: "8px",
      font: "13px -apple-system, sans-serif", boxShadow: "0 4px 14px rgba(0,0,0,.25)"
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  let captured = false;

  window.addEventListener("message", e => {
    if (e.source !== window || !e.data || e.data.source !== "rrate-dw") return;
    handleAudit(e.data.body, "page script");
  });

  // ---------- capture method 2: ask Degree Works directly ----------
  setTimeout(async () => {
    if (captured) return;
    status("didn't see the audit load, asking Degree Works for it directly…");
    const base = location.pathname.match(/^\/[^/]*dashboard/i)?.[0] || "/ResponsiveDashboard";
    const tried = [];
    try {
      const meRes = await pageFetch(`${base}/api/students/myself`, { credentials: "include", headers: { Accept: "application/json" } });
      tried.push(`students/myself → ${meRes.status}`);
      if (!meRes.ok) throw new Error("couldn't get student info");
      const me = await meRes.json();
      const goal = (me.goals || [])[0] || {};
      const q = new URLSearchParams({
        studentId: me.id, school: goal.school?.key || "UG", degree: goal.degree?.key || "BS",
        "is-process-new": "false", "audit-type": "AA", auditId: "",
        "include-inprogress": "true", "include-preregistered": "true", "aid-term": ""
      });
      const res = await pageFetch(`${base}/api/audit?${q}`, { credentials: "include", headers: { Accept: "application/json" } });
      tried.push(`audit → ${res.status}`);
      const text = await res.text();
      if (!looksLikeAudit(text)) throw new Error("audit response didn't look like an audit");
      handleText(text, "direct request");
    } catch (err) {
      const msg = `${err.message} (${tried.join(", ") || "no response"})`;
      await browser.storage.local.set({ dwError: msg });
      status("couldn't read your audit: " + msg + ". Send this to Claude.", "error");
    }
  }, 10000);

  async function handleAudit(audit, how) {
    if (captured || !audit || !Array.isArray(audit.blockArray)) return;
    captured = true;
    const e = { data: { url: how } };
    const requirements = parseAudit(audit);
    const classes = extractClasses(audit);
    const student = extractStudent(audit);
    // Small structural sample for debugging (no grades), in case parsing needs fixing.
    const debugSample = {
      capturedVia: e.data.url,
      blocks: audit.blockArray.map(b => ({
        title: b.title,
        pct: b.percentComplete,
        rules: (b.ruleArray || []).slice(0, 3).map(r => ({
          label: r.label, ruleType: r.ruleType, pct: r.percentComplete,
          keys: Object.keys(r), advice: r.advice, requirement: r.requirement
        }))
      }))
    };
    // Field names of a couple of classes (not grades) so class parsing can be fixed if needed.
    const rawClasses = audit.classInformation && audit.classInformation.classArray;
    debugSample.classCount = classes.length;
    debugSample.classKeys = Array.isArray(rawClasses) && rawClasses[0] ? Object.keys(rawClasses[0]) : null;
    debugSample.classSample = classes.slice(0, 3).map(c => ({ ...c, g: c.g ? "(grade)" : "" }));
    await browser.storage.local.set({ dwRequirements: requirements, dwClasses: classes, dwStudent: student, dwCapturedAt: Date.now(), dwDebug: debugSample });
    await browser.storage.local.remove("dwError");
    status(`saved ${requirements.length} unmet requirement${requirements.length === 1 ? "" : "s"} and ${classes.length} classes for prerequisite checks (via ${how}). Open the Registration page and click "Requirements".`, "ok");
  }
})();
