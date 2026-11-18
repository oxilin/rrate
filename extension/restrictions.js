// Course restrictions (class standing, major, ...). Pure functions.
//
// Banner's getRestrictions HTML looks like:
//   <span class="status-bold">Must be enrolled in one of the following Classes:</span><br/>
//   <span class="detail-popup-indentation">Junior (JR)</span> ...
var RRRestrict = (() => {
  const decode = s => String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  const clean = s => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

  // -> { none, partial, rules: [{ must: bool, field: "Classes", values: [...] }] }
  function parse(html) {
    const h = String(html || "");
    const out = { none: false, partial: /Not all restrictions are applicable/i.test(h), rules: [] };
    const tokenRe = /<span class="(status-bold|detail-popup-indentation)">([\s\S]*?)<\/span>/g;
    let m, rule = null;
    while ((m = tokenRe.exec(h))) {
      const text = clean(m[2]);
      if (m[1] === "status-bold") {
        const r = /^(Must|Cannot) be enrolled in one of the following (.+?):?$/i.exec(text);
        rule = r ? { must: /^must/i.test(r[1]), field: r[2].replace(/:$/, ""), values: [] } : null;
        if (rule) out.rules.push(rule);
      } else if (rule && text) {
        rule.values.push(text);
      }
    }
    if (!out.rules.length) out.none = true;
    return out;
  }

  const STANDINGS = ["freshman", "sophomore", "junior", "senior", "graduate"];
  const standingOf = v => STANDINGS.find(s => v.toLowerCase().includes(s)) || "";
  const short = v => v.replace(/\s*\([^)]*\)\s*$/, "").trim();

  // student: { standing: "junior", majors: ["Computer Engineering"], level: "Undergraduate" }
  // -> { status: "yes" | "no" | "check" | "none", text, tip }
  function check(parsed, student) {
    if (!parsed || parsed.none) return { status: "none", text: "", tip: "" };
    student = student || {};
    const results = parsed.rules.map(r => {
      const f = r.field.toLowerCase();
      const vals = r.values;
      let match = null; // true/false/null (unknown)
      if (/class/.test(f) && student.standing) {
        match = vals.some(v => standingOf(v) === student.standing);
      } else if (/major|field of study/.test(f) && student.majors && student.majors.length) {
        const mine = student.majors.map(x => x.toLowerCase());
        match = vals.some(v => mine.some(m => short(v).toLowerCase() === m || short(v).toLowerCase().includes(m) || m.includes(short(v).toLowerCase())));
      } else if (/level/.test(f)) {
        match = vals.some(v => /undergrad/i.test(v)) ? (student.level ? /undergrad/i.test(student.level) : true) : null;
      }
      const ok = match == null ? null : (r.must ? match : !match);
      const label = /class/.test(f)
        ? `${r.must ? "" : "not for "}${vals.map(v => short(v).replace(/^(.)/, c => c.toUpperCase()) + "s").join(" & ")}${r.must ? " only" : ""}`
        : `${r.must ? "only" : "not for"} ${r.field.toLowerCase()}: ${vals.map(short).join(", ")}`;
      return { ok, label, rule: r };
    });
    const tip = parsed.rules.map(r => `${r.must ? "Must" : "Cannot"} be in one of these ${r.field}: ${r.values.join(", ")}`).join("\n")
      + (parsed.partial ? "\n(Banner notes not all restrictions apply to every student.)" : "");
    const text = results.map(r => r.label).join("; ");
    if (results.some(r => r.ok === false)) return { status: "no", text, tip };
    if (results.some(r => r.ok == null)) return { status: "check", text, tip };
    return { status: "yes", text, tip };
  }

  return { parse, check, standingOf };
})();
