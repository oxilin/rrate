#!/usr/bin/env python3
"""Pull class sections (CRNs, seats, waitlist, times, instructors) from UCR's
Banner 9 registration site. No login needed. Standard library only.

Examples:
  python3 ucr_classes.py --terms                       # list term codes
  python3 ucr_classes.py --subject CS                  # all CS sections, newest term
  python3 ucr_classes.py --subject CS --course 010A    # just CS 010A
  python3 ucr_classes.py --subject MATH --csv math.csv # save to CSV
  python3 ucr_classes.py --subject CS --open-only      # only sections with open seats
  python3 ucr_classes.py --subject CS --crn 51235 --watch 120   # alert when a seat opens
"""
import argparse
import csv
import http.cookiejar
import json
import sys
import time
import urllib.parse
import urllib.request

BASE = "https://registrationssb.ucr.edu/StudentRegistrationSsb/ssb"
PAGE = 500  # Banner's max page size


class Banner:
    def __init__(self):
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def _req(self, path, params=None, data=None):
        url = f"{BASE}/{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        req = urllib.request.Request(url, data=body, headers={"User-Agent": "Mozilla/5.0"})
        with self.opener.open(req, timeout=30) as r:
            return json.loads(r.read().decode() or "null")

    def terms(self, n=10):
        return self._req("classSearch/getTerms", {"searchTerm": "", "offset": 1, "max": n})

    def search(self, term, subject="", course=""):
        # Term must be set on the session first; reset clears any previous search.
        self._req("term/search", {"mode": "search"}, {"term": term})
        self._req("classSearch/resetDataForm", data={})
        out, offset = [], 0
        while True:
            d = self._req("searchResults/searchResults", {
                "txt_subject": subject, "txt_courseNumber": course, "txt_term": term,
                "pageOffset": offset, "pageMaxSize": PAGE,
                "sortColumn": "subjectDescription", "sortDirection": "asc",
            })
            rows = d.get("data") or []
            out += rows
            offset += PAGE
            if not rows or offset >= d.get("totalCount", 0):
                return out


DAYS = [("monday", "M"), ("tuesday", "T"), ("wednesday", "W"), ("thursday", "R"),
        ("friday", "F"), ("saturday", "S"), ("sunday", "U")]


def fmt_time(t):
    return f"{t[:2]}:{t[2:]}" if t else ""


def real_open(c):
    """Seats a regular student can take: excludes reserved seats and respects the cross-list pool."""
    n = c.get("seatsAvailable") or 0
    if c.get("reservedSeatSummary"):
        n = c["reservedSeatSummary"].get("seatsAvailableUnreserved") or 0
    if c.get("crossList"):
        n = min(n, c.get("crossListAvailable") or 0)
    return max(n, 0)


def flatten(c):
    meetings = []
    for m in c.get("meetingsFaculty") or []:
        mt = m["meetingTime"]
        days = "".join(a for k, a in DAYS if mt.get(k)) or "TBA"
        when = f"{fmt_time(mt.get('beginTime'))}-{fmt_time(mt.get('endTime'))}" if mt.get("beginTime") else ""
        where = f"{mt.get('building') or ''} {mt.get('room') or ''}".strip()
        meetings.append(" ".join(x for x in (days, when, where) if x))
    return {
        "crn": c["courseReferenceNumber"],
        "course": f"{c['subject']} {c['courseNumber']}",
        "section": c["sequenceNumber"],
        "type": c.get("scheduleTypeDescription"),
        "title": c["courseTitle"],
        "units": c.get("creditHours") or c.get("creditHourLow"),
        "seats_open": real_open(c),
        "seats_listed": c["seatsAvailable"],
        "enrolled": c["enrollment"],
        "capacity": c["maximumEnrollment"],
        "waitlist": c.get("waitCount"),
        "wait_cap": c.get("waitCapacity"),
        "instructor": "; ".join(f["displayName"] for f in c.get("faculty") or []),
        "meetings": " | ".join(meetings),
    }


def print_table(rows):
    print(f"{'CRN':<6} {'COURSE':<10} {'SEC':<4} {'TYPE':<11} {'SEATS':>9} {'WAIT':>5}  {'INSTRUCTOR':<22} MEETINGS")
    for r in rows:
        seats = f"{r['seats_open']}/{r['capacity']}"
        print(f"{r['crn']:<6} {r['course']:<10} {r['section']:<4} {str(r['type'])[:11]:<11} "
              f"{seats:>9} {r['waitlist'] or 0:>5}  {r['instructor'][:22]:<22} {r['meetings']}")
    print(f"\n{len(rows)} sections")


def main():
    p = argparse.ArgumentParser(description="UCR class search")
    p.add_argument("--terms", action="store_true", help="list available term codes")
    p.add_argument("--term", help="term code, e.g. 202710 (default: newest)")
    p.add_argument("--subject", default="", help="subject code, e.g. CS, MATH")
    p.add_argument("--course", default="", help="course number, e.g. 010A")
    p.add_argument("--crn", nargs="*", default=[], help="only these CRNs")
    p.add_argument("--open-only", action="store_true", help="only sections with open seats")
    p.add_argument("--csv", help="write results to this CSV file")
    p.add_argument("--json", action="store_true", help="print raw JSON")
    p.add_argument("--watch", type=int, metavar="SECONDS",
                   help="re-check every N seconds (min 60) and alert when seats open")
    a = p.parse_args()

    b = Banner()
    if a.terms:
        for t in b.terms(20):
            print(t["code"], t["description"])
        return
    term = a.term or b.terms(1)[0]["code"]

    def fetch():
        rows = [flatten(c) for c in b.search(term, a.subject.upper(), a.course.upper())]
        if a.crn:
            rows = [r for r in rows if r["crn"] in a.crn]
        if a.open_only:
            rows = [r for r in rows if r["seats_open"] > 0]
        return rows

    if a.watch:
        interval = max(a.watch, 60)
        print(f"Watching term {term} every {interval}s. Ctrl+C to stop.")
        while True:
            try:
                for r in fetch():
                    status = "OPEN" if r["seats_open"] > 0 else "full"
                    print(f"{time.strftime('%H:%M:%S')} {r['crn']} {r['course']}-{r['section']} "
                          f"{status} {r['seats_open']}/{r['capacity']} wait {r['waitlist']}")
                    if r["seats_open"] > 0:
                        print("\a", end="", flush=True)  # terminal bell
            except Exception as e:
                print("error:", e, file=sys.stderr)
            time.sleep(interval)

    rows = fetch()
    if a.json:
        print(json.dumps(rows, indent=2))
    else:
        print(f"Term {term}")
        print_table(rows)
    if a.csv and rows:
        with open(a.csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=rows[0].keys())
            w.writeheader()
            w.writerows(rows)
        print(f"Saved {len(rows)} rows to {a.csv}")


if __name__ == "__main__":
    main()
