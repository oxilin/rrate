// Calendar export: weekly repeating events for a set of Banner sections, as an .ics file
// that Google Calendar, Apple Calendar and Outlook can import. Pure functions.
var RRIcs = (() => {
  const BYDAY = { monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA", sunday: "SU" };
  const JS_DAY = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const pad = n => String(n).padStart(2, "0");
  const esc = s => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const titleCase = t => String(t || "").toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase());

  // "01/04/2027" -> Date (local)
  function parseDate(mdY) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdY || "");
    return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null;
  }
  const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const local = (d, hhmm) => `${ymd(d)}T${hhmm.slice(0, 2)}${hhmm.slice(2)}00`;

  const VTIMEZONE = [
    "BEGIN:VTIMEZONE", "TZID:America/Los_Angeles",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0800", "TZOFFSETTO:-0700", "TZNAME:PDT",
    "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:-0700", "TZOFFSETTO:-0800", "TZNAME:PST",
    "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
    "END:VTIMEZONE"
  ];

  function build(sections, calName) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//R'Rate//UCR schedule//EN", "CALSCALE:GREGORIAN",
      `X-WR-CALNAME:${esc(calName || "UCR classes")}`, ...VTIMEZONE];
    let n = 0;
    for (const s of sections) {
      for (const mf of s.meetingsFaculty || []) {
        const mt = mf.meetingTime || {};
        const days = Object.keys(BYDAY).filter(d => mt[d]);
        const start = parseDate(mt.startDate), end = parseDate(mt.endDate);
        if (!days.length || !mt.beginTime || !mt.endTime || !start || !end) continue;
        // First meeting: the first listed weekday on/after the start date.
        const first = new Date(start);
        while (!days.includes(Object.keys(JS_DAY).find(k => JS_DAY[k] === first.getDay()))) first.setDate(first.getDate() + 1);
        const until = new Date(end); until.setDate(until.getDate() + 1); // through the last day
        const type = (s.scheduleTypeDescription || "").trim();
        const where = [mt.building, mt.room].filter(Boolean).join(" ");
        const prof = (s.faculty || []).map(f => f.displayName).join("; ");
        lines.push(
          "BEGIN:VEVENT",
          `UID:${s.term || ""}-${s.courseReferenceNumber}-${++n}@rrate`,
          `DTSTAMP:${stamp}`,
          `SUMMARY:${esc(`${s.subject} ${s.courseNumber} ${type}`.trim())}`,
          `DTSTART;TZID=America/Los_Angeles:${local(first, mt.beginTime)}`,
          `DTEND;TZID=America/Los_Angeles:${local(first, mt.endTime)}`,
          `RRULE:FREQ=WEEKLY;BYDAY=${days.map(d => BYDAY[d]).join(",")};UNTIL=${ymd(until)}T075959Z`,
          where ? `LOCATION:${esc(where)}` : null,
          `DESCRIPTION:${esc(`${titleCase(s.courseTitle)}\nSection ${s.sequenceNumber} · CRN ${s.courseReferenceNumber}${prof ? "\n" + prof : ""}`)}`,
          "END:VEVENT");
      }
    }
    lines.push("END:VCALENDAR");
    return lines.filter(l => l != null).join("\r\n") + "\r\n";
  }

  return { build };
})();
