// Plain-English explanations for Banner registration errors.
// Watches the registration page for Banner's error messages (in the summary table and the
// notification pop-ups) and adds a short explanation underneath each one.
var RRErrors = (() => {
  const RULES = [
    [/prereq(uisite)?s?( and test score)?[- ]*(error|not met)|PREQ AND TEST SCORE/i,
      "You're missing a prerequisite (or the minimum grade or placement score) for this class. If you think you meet it, for example through transfer or AP credit, ask the department for a prerequisite override."],
    [/time conflict|TIME CONFLICT/i,
      "This class meets at the same time as another class you're adding or already registered for. Pick a different section."],
    [/closed section|CLOSED SECTION|closed\s*-\s*\d+\s*waitlisted|class is full/i,
      "The section is full. If it has a waitlist, change the action to “Waitlist” and submit again; otherwise pick another section."],
    [/reserve[sd]?\s*(seats?\s*)?closed|reserved seats?/i,
      "There are seats left, but they're all held for a specific group (a major, learning community, or class level) that you're not in."],
    [/link(ed)?\s*(course|section)?\s*(required|error)|LINK ERROR/i,
      "This class has linked parts: register for the lecture and a matching discussion/lab together (same link number, e.g. L2 with D2 and B2) in one submit."],
    [/co-?requisite|COREQ/i,
      "This class has a corequisite you have to add in the same submit (for example a W course's WRIT 040 workshop)."],
    [/maximum (hours|units) exceeded|MAXIMUM HOURS/i,
      "Adding this would put you over your unit limit for this pass (17 units during first pass). Wait for the next pass or ask your advisor to raise the limit."],
    [/minimum (hours|units)|MINIMUM HOURS/i,
      "This change would drop you below the minimum number of units. Add another class first, then drop."],
    [/class(ification)? restriction|CLASS RESTRICTION/i,
      "This class is limited to certain class levels (e.g. juniors and seniors)."],
    [/major restriction|MAJOR RESTRICTION|field of study restriction/i,
      "This class is limited to certain majors."],
    [/(level|college|program|degree|cohort|campus|department) restriction/i,
      "This class is limited to a group of students you're not in (level, college, program, or cohort). The department may be able to give you an override."],
    [/duplicate (course|section)|DUPL CRSE|DUPLICATE/i,
      "You're already registered for (or adding) another section of this same course."],
    [/repeat (count|limit|hours) exceed|REPEAT COUNT|repeat limit/i,
      "You've already taken this course the maximum number of times allowed. Talk to your advisor about repeat policy."],
    [/instructor (approval|permission|consent)|DEPT(ARTMENT)? APPROVAL|approval required/i,
      "This class needs instructor or department approval. Request a permission/override from the department, then register."],
    [/(not permitted to register at this time|registration (is )?not (open|permitted|allowed)|time ticket|outside.*registration (window|time))/i,
      "Your registration time hasn't started yet (or has ended). Check your pass time in the registration status page."],
    [/\bholds?\b.*(prevent|exist|registration)/i,
      "You have a hold on your account. Look up the hold in R'Web/Student Business Services and clear it before registering."],
    [/web registration not allowed|NO WEB REGISTRATION/i,
      "This class can't be added online. Contact the department to be added."],
    [/errors? preventing registration/i,
      "Heads up: Banner handles each change in a submit separately. Any drops in the same submit may already have gone through even though these adds failed. Check your schedule before trying again."]
  ];

  const MARK = "data-rr-explained";

  function explain(text) {
    for (const [re, msg] of RULES) if (re.test(text)) return msg;
    return null;
  }

  // Elements Banner uses for registration messages. Kept broad on purpose; text is matched.
  const SELECTOR = [
    ".notification-center-message", ".notification-item", ".notification-flyout-item",
    "[data-property='statusDescription']", "[data-property='messages']", "[data-property='message']",
    ".errorText", ".ui-state-error", ".message-error", "td.status", "[role='alert']"
  ].join(",");

  function scan(root) {
    const nodes = root.querySelectorAll ? root.querySelectorAll(SELECTOR) : [];
    for (const n of nodes) {
      if (n.closest(".rr-panel") || n.hasAttribute(MARK)) continue;
      const text = (n.textContent || "").trim();
      if (!text || text.length > 600) continue;
      const msg = explain(text);
      if (!msg) continue;
      n.setAttribute(MARK, "1");
      const tip = document.createElement("div");
      tip.className = "rr-explain";
      tip.textContent = "R'Rate: " + msg;
      n.append(tip);
    }
  }

  if (typeof document !== "undefined" && document.body) {
    scan(document);
    let pending = false;
    const inPanel = m => { const t = m.target.nodeType === 1 ? m.target : m.target.parentElement; return t && t.closest && t.closest(".rr-panel, .rrate-holder, .rr-explain"); };
    new MutationObserver(muts => {
      if (muts.every(inPanel)) return;
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; scan(document); }, 300);
    }).observe(document.body, { childList: true, subtree: true });
  }

  return { explain, scan };
})();
