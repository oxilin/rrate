// Which sections have to be taken together. Pure functions (no browser APIs).
//
// Banner link IDs: a lecture "L2" must be paired with exactly one section of every other
// linked type that has the same number ("D2" discussion, "B2" lab). Confirmed against
// Banner's fetchLinkedSections (PHYS 040B-020: L2 -> 56 combos = every D2 x every B2).
var RRLink = (() => {
  const TYPE_ORDER = ["Lecture", "Seminar", "Studio", "Discussion", "Workshop", "Laboratory", "Activity"];
  const typeOf = s => (s.scheduleTypeDescription || "Other").trim() || "Other";
  const rank = t => { const i = TYPE_ORDER.indexOf(t); return i < 0 ? TYPE_ORDER.length : i; };
  const linkParts = id => {
    const m = /^([A-Za-z]+)(\d+)$/.exec(String(id || "").trim());
    return m ? { letter: m[1].toUpperCase(), num: m[2] } : null;
  };

  // The "anchor" link letter for a course: the one used by its most primary section type.
  function anchorLetter(sections) {
    let best = null;
    for (const s of sections) {
      const p = linkParts(s.linkIdentifier);
      if (!p) continue;
      const r = rank(typeOf(s));
      if (!best || r < best.r || (r === best.r && p.letter === "L")) best = { r, letter: p.letter };
    }
    return best && best.letter;
  }

  function cartesian(lists) {
    return lists.reduce((acc, list) => acc.flatMap(a => list.map(b => [...a, b])), [[]]);
  }

  // Every valid combination of sections for one course: [{ sections: [...] }]
  function packages(sections) {
    const anchor = anchorLetter(sections);
    if (!anchor) {
      // No links: one section of the most primary type is enough (other types are optional).
      const top = Math.min(...sections.map(s => rank(typeOf(s))));
      return sections.filter(s => rank(typeOf(s)) === top).map(s => ({ sections: [s] }));
    }
    const out = [];
    for (const a of sections) {
      const p = linkParts(a.linkIdentifier);
      if (!p || p.letter !== anchor) continue;
      const byLetter = new Map();
      for (const s of sections) {
        const q = linkParts(s.linkIdentifier);
        if (!q || q.letter === anchor || q.num !== p.num) continue;
        if (!byLetter.has(q.letter)) byLetter.set(q.letter, []);
        byLetter.get(q.letter).push(s);
      }
      for (const combo of cartesian([...byLetter.values()])) out.push({ sections: [a, ...combo] });
    }
    return out;
  }

  // Short text for a section row: what it must be paired with.
  function describe(section, courseSections) {
    const p = linkParts(section.linkIdentifier);
    if (!p) return "";
    const anchor = anchorLetter(courseSections);
    if (p.letter === anchor) {
      const needs = new Map();
      for (const s of courseSections) {
        const q = linkParts(s.linkIdentifier);
        if (q && q.letter !== anchor && q.num === p.num) needs.set(q.letter, typeOf(s));
      }
      if (!needs.size) return "";
      return "with 1 " + [...needs].map(([l, t]) => `${t.toLowerCase()} (${l}${p.num})`).join(" + 1 ");
    }
    const anchors = courseSections.filter(s => {
      const q = linkParts(s.linkIdentifier);
      return q && q.letter === anchor && q.num === p.num;
    });
    if (!anchors.length) return "";
    const t = typeOf(anchors[0]).toLowerCase();
    return `goes with ${t} ${anchors.map(s => s.sequenceNumber).join(" or ")}`;
  }

  return { packages, describe, typeOf, rank, linkParts };
})();
