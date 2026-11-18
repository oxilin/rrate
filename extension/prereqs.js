// Prerequisite parsing and checking. Pure functions, no browser APIs, so they can be
// tested on their own. Loaded before planner.js, which uses RRPrereq.*.
//
// Banner's getSectionPrerequisites returns HTML like:
//   ( Course or Test: Computer Science 011 Minimum Grade of D- May not be taken concurrently. )
//   or ( Course or Test: Mathematics 011 ... ) and ( Course or Test: Mathematics 009C ... ) ...
// Each ( ) group lists alternatives (a course, or a placement-test score). Groups are joined
// by "and"/"or"; "or" binds tighter, which matches the UCR catalog wording
// (e.g. CS 111: "CS 011 or MATH 011; MATH 009C or MATH 09HC; MATH 031 or EE 020B; ...").
var RRPrereq = (() => {
  const decode = s => s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  const squash = s => decode(s).replace(/\s+/g, " ").trim();
  const nameKey = s => squash(s).toLowerCase();

  // ---------- parsing ----------
  function parseItem(text) {
    const items = [];
    const courseRe = /Course or Test:\s*(.+?)\s+(\S+)\s+(?:Minimum Grade of\s+(\S+)\s+)?May (not )?be taken concurrently/g;
    let m, rest = text;
    while ((m = courseRe.exec(text))) {
      items.push({ kind: "course", subjectName: m[1].trim(), number: m[2].toUpperCase(), minGrade: m[3] || "D-", concurrent: !m[4] });
      rest = rest.replace(m[0], " ");
    }
    // Placement tests etc. ("Math: Score for Prereq 612 to 613 May not be taken concurrently.")
    const testRe = /([A-Za-z][A-Za-z .&'-]*?):\s*Score for Prereq\s+(\S+)(?:\s+to\s+(\S+))?/g;
    while ((m = testRe.exec(rest))) {
      items.push({ kind: "test", name: m[1].trim(), from: m[2], to: m[3] || "" });
      rest = rest.replace(m[0], " ");
    }
    rest = rest.replace(/May (not )?be taken concurrently\.?/g, "").replace(/[.\s]+/g, " ").trim();
    if (rest) items.push({ kind: "other", text: rest });
    return items;
  }

  // Returns { clauses: [[group, ...], ...], catalog: "free text", none: bool }
  //   clauses are ANDed; groups inside a clause are ORed; items inside a group are ORed.
  function parse(html) {
    const text = squash(
      String(html || "")
        .replace(/<\/(pre|p|div|tr|li)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " "));
    const out = { clauses: [], catalog: "", none: false };
    const areaStart = text.search(/Prerequisites:\s*\S+/);
    const head = areaStart >= 0 ? text.slice(0, areaStart) : text;
    out.catalog = head.replace(/Catalog Prerequisites|Area Prerequisites/g, "").trim();
    if (/No prerequisite information/i.test(text)) out.none = true;
    if (areaStart < 0) {
      if (!out.catalog) out.none = true;
      return out;
    }
    const body = text.slice(areaStart).replace(/^Prerequisites:\s*\S+/, "");
    const groupRe = /\(([^()]*)\)\s*(and|or)?/gi;
    let m, clause = [];
    while ((m = groupRe.exec(body))) {
      const items = parseItem(m[1]);
      if (items.length) clause.push(items);
      const conn = (m[2] || "").toLowerCase();
      if (conn !== "or") { // "and" or end of list closes the clause
        if (clause.length) out.clauses.push(clause);
        clause = [];
      }
    }
    if (clause.length) out.clauses.push(clause);
    if (!out.clauses.length && !out.catalog) out.none = true;
    return out;
  }

  // ---------- grades ----------
  const LETTERS = ["F", "D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"];
  const FAILING = new Set(["F", "NP", "U", "W", "WN", "I", "NR", "NC", "WU", "FN"]);
  const PASSING_NONLETTER = new Set(["S", "P", "CR", "T", "TR", "TC", "TP"]);
  const IN_PROGRESS = new Set(["IP", "REG", "PR", "PREREG", "INP", "RG"]);

  // true / false / null (can't tell)
  function gradeMeets(grade, min) {
    const g = String(grade || "").toUpperCase().trim();
    const want = String(min || "D-").toUpperCase().trim();
    if (!g) return null;
    if (FAILING.has(g)) return false;
    const gi = LETTERS.indexOf(g);
    if (want === "S" || want === "P") return gi >= 0 ? gi >= LETTERS.indexOf("C") : PASSING_NONLETTER.has(g) ? true : null;
    const wi = LETTERS.indexOf(want);
    if (gi >= 0 && wi >= 0) return gi >= wi;
    if (PASSING_NONLETTER.has(g)) return wi < 0 || wi <= LETTERS.indexOf("C");
    return null;
  }

  // ---------- checking ----------
  // classes: [{ s: "CS", n: "010C", g: "D", ip: bool, term: "202640" }] from Degree Works.
  // subjects: { "computer science": "CS", ... } from Banner's subject list.
  // Status order, worst first: no < check < pending < yes
  const RANK = { no: 0, check: 1, pending: 2, yes: 3 };
  const worst = list => list.reduce((a, b) => (RANK[b] < RANK[a] ? b : a), "yes");
  const best = list => list.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "no");

  function evalItem(item, classes, subjects, term) {
    if (item.kind === "test") return { status: "check", label: `${item.name} placement score` };
    if (item.kind !== "course") return { status: "check", label: item.text };
    const code = subjects[nameKey(item.subjectName)];
    const label = `${code || item.subjectName} ${item.number}${item.minGrade && item.minGrade !== "D-" ? ` (${item.minGrade} or better)` : ""}`;
    if (!code) return { status: "check", label };
    const attempts = classes.filter(c => c.s === code && c.n === item.number);
    let status = "no", via = null;
    for (const c of attempts) {
      const sameTerm = term && c.term && c.term === term;
      let st;
      if (c.ip || IN_PROGRESS.has(String(c.g || "").toUpperCase())) {
        // Registered for the very term being planned only counts if it may be taken concurrently.
        st = sameTerm ? (item.concurrent ? "pending" : "no") : "pending";
      } else {
        const ok = gradeMeets(c.g, item.minGrade);
        st = ok === true ? "yes" : ok === false ? "no" : "check";
      }
      if (RANK[st] > RANK[status]) { status = st; via = c; }
    }
    return { status, label, via };
  }

  function check(parsed, classes, subjects, term) {
    if (!parsed || parsed.none) return { status: "none", clauses: [] };
    if (!parsed.clauses.length) return { status: "check", clauses: [], note: parsed.catalog };
    const clauses = parsed.clauses.map(groups => {
      const items = groups.flat().map(it => evalItem(it, classes || [], subjects || {}, term));
      return { status: best(items.map(i => i.status)), items };
    });
    return { status: worst(clauses.map(c => c.status)), clauses, note: parsed.catalog };
  }

  // Short explanation for a badge tooltip / line.
  function explain(result) {
    const opts = c => c.items.map(i => i.label).filter((v, i, a) => a.indexOf(v) === i).join(" or ");
    const by = st => result.clauses.filter(c => c.status === st);
    return {
      missing: by("no").map(opts),
      pending: by("pending").map(c => {
        const i = c.items.find(x => x.status === "pending");
        return i ? i.label.replace(/ \(.*\)$/, "") : opts(c);
      }),
      check: by("check").map(opts),
      met: by("yes").map(c => {
        const i = c.items.find(x => x.status === "yes");
        return i ? i.label.replace(/ \(.*\)$/, "") : opts(c);
      })
    };
  }

  return { parse, check, explain, gradeMeets, nameKey };
})();
