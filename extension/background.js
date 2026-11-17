// R'Rate background script: talks to Rate My Professors' public GraphQL endpoint.
// Runs in the extension context, so it isn't blocked by CORS on the registration page.

const RMP_URL = "https://www.ratemyprofessors.com/graphql";
const RMP_AUTH = "Basic dGVzdDp0ZXN0"; // public "test:test" token RMP's own site uses
const SCHOOL_QUERY_NAME = "University of California Riverside";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // re-check ratings weekly

const memo = new Map(); // in-flight / per-session results

async function gql(query, variables) {
  const res = await fetch(RMP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: RMP_AUTH },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error("RMP HTTP " + res.status);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function getSchoolId() {
  const stored = await browser.storage.local.get("schoolId");
  if (stored.schoolId) return stored.schoolId;
  const data = await gql(
    `query($text: String!) {
       newSearch { schools(query: {text: $text}) { edges { node { id name city state } } } }
     }`,
    { text: SCHOOL_QUERY_NAME }
  );
  const edges = data.newSearch.schools.edges.map(e => e.node);
  const ucr =
    edges.find(s => /riverside/i.test(s.name) && /california/i.test(s.name)) ||
    edges.find(s => /riverside/i.test(s.city || ""));
  if (!ucr) throw new Error("Couldn't find UCR on RMP");
  await browser.storage.local.set({ schoolId: ucr.id });
  return ucr.id;
}

function norm(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
}

async function lookupProfessor(first, last) {
  const key = `${norm(first)}|${norm(last)}`;
  if (memo.has(key)) return memo.get(key);

  const p = (async () => {
    const cacheKey = "prof:" + key;
    const cached = (await browser.storage.local.get(cacheKey))[cacheKey];
    if (cached && Date.now() - cached.t < CACHE_TTL_MS) return cached.v;

    const schoolID = await getSchoolId();
    const data = await gql(
      `query($text: String!, $schoolID: ID!) {
         newSearch {
           teachers(query: {text: $text, schoolID: $schoolID}, first: 10) {
             edges { node {
               legacyId firstName lastName department
               avgRating avgDifficulty numRatings wouldTakeAgainPercent
             } }
           }
         }
       }`,
      { text: `${first} ${last}`.trim(), schoolID }
    );
    const nodes = data.newSearch.teachers.edges.map(e => e.node);

    // Prefer exact last-name match, then first-name prefix match (handles "Bob" vs "Robert" poorly, but avoids wrong people).
    const lastMatches = nodes.filter(n => norm(n.lastName) === norm(last));
    let best =
      lastMatches.find(n => norm(n.firstName) === norm(first)) ||
      lastMatches.find(n => norm(n.firstName).startsWith(norm(first).slice(0, 3)) || norm(first).startsWith(norm(n.firstName).slice(0, 3))) ||
      (lastMatches.length === 1 ? lastMatches[0] : null);

    const v = best
      ? {
          found: true,
          id: best.legacyId,
          name: `${best.firstName} ${best.lastName}`,
          dept: best.department,
          rating: best.avgRating,
          difficulty: best.avgDifficulty,
          count: best.numRatings,
          wta: best.wouldTakeAgainPercent,
          ambiguous: lastMatches.length > 1 && norm(best.firstName) !== norm(first)
        }
      : { found: false };

    await browser.storage.local.set({ [cacheKey]: { t: Date.now(), v } });
    return v;
  })();

  memo.set(key, p);
  p.catch(() => memo.delete(key));
  return p;
}

browser.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === "rmpLookup") {
    return lookupProfessor(msg.first, msg.last).catch(err => ({ found: false, error: String(err) }));
  }
});

// ---------- Seat fill-up history (from the seat tracker's public GitHub repo) ----------
// Set this to "<your GitHub username>/<repo name>" once the tracker repo is on GitHub.
const FILL_REPO = "oxilin/rrate";
const FILL_TTL_MS = 30 * 60 * 1000; // the tracker updates every 2 hours

const fillMemo = new Map();

async function getFill(term) {
  const { fillRepo } = await browser.storage.local.get("fillRepo"); // optional override
  const repo = fillRepo || FILL_REPO;
  if (!repo || repo.startsWith("YOUR_")) return { error: "Fill history isn't set up yet (FILL_REPO in background.js)." };

  const hit = fillMemo.get(term);
  if (hit && Date.now() - hit.t < FILL_TTL_MS) return hit.v;
  const p = (async () => {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/main/data/${term}/fill.json`, { cache: "no-cache" });
    if (res.status === 404) return { error: `No fill history for term ${term} yet.` };
    if (!res.ok) throw new Error("fill.json HTTP " + res.status);
    return res.json();
  })();
  fillMemo.set(term, { t: Date.now(), v: p });
  p.catch(() => fillMemo.delete(term));
  return p;
}

browser.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === "fillData") {
    return getFill(msg.term).catch(err => ({ error: String(err) }));
  }
});
