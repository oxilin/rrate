#!/usr/bin/env python3
"""Snapshot every UCR class section and record what changed since last time.

Uses the public Browse Classes search (no login). For each term that is open
for registration (not "View Only"), it downloads every section and appends a
row to data/<term>/changes.csv only for sections whose seat numbers changed.

Files (all plain text so git stores the history compactly):
  data/<term>/sections.csv  one row per section: course, title, type, times, ...
  data/<term>/changes.csv   append-only: ts, crn, then seat numbers (see FIELDS)
  data/runs.csv             one row per term per run, so "no change" is provable

"open" is the number of seats a regular student can actually take:
seats not held for a reserved group, and for cross-listed courses no more
than the shared pool has left. Banner's own seatsAvailable counts reserved seats.

Usage:
  python3 tracker/tracker.py                 # all open terms
  python3 tracker/tracker.py --term 202710   # one term
"""
import argparse
import csv
import http.cookiejar
import json
import os
import random
import string
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = "https://registrationssb.ucr.edu/StudentRegistrationSsb/ssb"
PAGE = 500
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# Seat numbers stored per change, in this column order.
FIELDS = ["open", "seats", "enrolled", "cap", "wait", "wait_cap", "res_open", "xl_open"]
SECTION_COLS = ["crn", "subject", "number", "seq", "type", "title", "credits", "link",
                "cross_list", "instructor", "meetings", "status"]
DAYS = [("monday", "M"), ("tuesday", "T"), ("wednesday", "W"), ("thursday", "R"),
        ("friday", "F"), ("saturday", "S"), ("sunday", "U")]


class Banner:
    def __init__(self):
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, path, params=None, data=None, tries=3):
        url = f"{BASE}/{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        req = urllib.request.Request(url, data=body, headers={
            "User-Agent": "Mozilla/5.0 (ucr seat tracker)",
            "X-Requested-With": "XMLHttpRequest",
        })
        for attempt in range(tries):
            try:
                with self.opener.open(req, timeout=60) as r:
                    text = r.read().decode()
                    return json.loads(text) if text.strip() else None
            except Exception:
                if attempt == tries - 1:
                    raise
                time.sleep(5 * (attempt + 1))

    def open_terms(self):
        terms = self.call("classSearch/getTerms", {"searchTerm": "", "offset": 1, "max": 20})
        return [t["code"] for t in terms if "view only" not in t["description"].lower()]

    def all_sections(self, term):
        self.call("term/search", {"mode": "search"}, {"term": term})
        self.call("classSearch/resetDataForm", data={})
        sid = "".join(random.choices(string.ascii_lowercase, k=5)) + str(int(time.time() * 1000))
        by_crn, offset, total = {}, 0, None
        while total is None or offset < total:
            d = self.call("searchResults/searchResults", {
                "txt_term": term, "pageOffset": offset, "pageMaxSize": PAGE,
                "sortColumn": "subjectDescription", "sortDirection": "asc", "uniqueSessionId": sid,
            })
            total = d.get("totalCount") or 0
            rows = d.get("data") or []
            if not rows:
                break
            for s in rows:
                by_crn[s["courseReferenceNumber"]] = s
            offset += PAGE
            time.sleep(1)  # be polite
        return by_crn, total


def real_open(s):
    n = s.get("seatsAvailable") or 0
    rs = s.get("reservedSeatSummary")
    if rs:
        n = rs.get("seatsAvailableUnreserved") or 0
    if s.get("crossList"):
        n = min(n, s.get("crossListAvailable") or 0)
    return max(n, 0)


def seat_values(s):
    rs = s.get("reservedSeatSummary") or {}
    return [
        real_open(s),
        s.get("seatsAvailable"),
        s.get("enrollment"),
        s.get("maximumEnrollment"),
        s.get("waitCount"),
        s.get("waitCapacity"),
        rs.get("seatsAvailableReserved", ""),
        s.get("crossListAvailable") if s.get("crossList") else "",
    ]


def section_row(s):
    meets = []
    for m in s.get("meetingsFaculty") or []:
        mt = m.get("meetingTime") or {}
        days = "".join(a for k, a in DAYS if mt.get(k))
        if mt.get("beginTime"):
            meets.append(f"{days} {mt['beginTime']}-{mt['endTime']} {mt.get('building') or ''} {mt.get('room') or ''}".strip())
    prof = next((f for f in s.get("faculty") or [] if f.get("primaryIndicator")), None) or (s.get("faculty") or [None])[0]
    return {
        "crn": s["courseReferenceNumber"], "subject": s["subject"], "number": s["courseNumber"],
        "seq": s["sequenceNumber"], "type": (s.get("scheduleTypeDescription") or "").strip(),
        "title": (s.get("courseTitle") or "").strip(), "credits": s.get("creditHours") or s.get("creditHourLow") or "",
        "link": s.get("linkIdentifier") or "", "cross_list": s.get("crossList") or "",
        "instructor": prof["displayName"] if prof else "", "meetings": " | ".join(meets), "status": "active",
    }


def norm(v):
    return "" if v is None else str(v)


def latest_values(path):
    """Last recorded seat values per CRN, read back from changes.csv."""
    last = {}
    if os.path.exists(path):
        with open(path, newline="") as f:
            for row in csv.DictReader(f):
                last[row["crn"]] = [row[k] for k in FIELDS]
    return last


def track_term(b, term, ts):
    sections, total = b.all_sections(term)
    if not sections or len(sections) < total * 0.98:
        raise RuntimeError(f"term {term}: got {len(sections)} of {total} sections, not saving a partial snapshot")

    tdir = os.path.join(DATA, term)
    os.makedirs(tdir, exist_ok=True)
    changes_path = os.path.join(tdir, "changes.csv")
    sections_path = os.path.join(tdir, "sections.csv")

    # Seat changes
    last = latest_values(changes_path)
    new_rows = []
    for crn, s in sections.items():
        vals = [norm(v) for v in seat_values(s)]
        if last.get(crn) != vals:
            new_rows.append([ts, crn] + vals)
    gone = [crn for crn in last if crn not in sections and last[crn][0] != ""]
    for crn in gone:  # section cancelled / removed: record a blank row once
        new_rows.append([ts, crn] + [""] * len(FIELDS))

    new_file = not os.path.exists(changes_path)
    with open(changes_path, "a", newline="") as f:
        w = csv.writer(f)
        if new_file:
            w.writerow(["ts", "crn"] + FIELDS)
        w.writerows(sorted(new_rows, key=lambda r: int(r[1])))

    # Section details (rewritten only when something in it changed)
    old = {}
    if os.path.exists(sections_path):
        with open(sections_path, newline="") as f:
            old = {r["crn"]: r for r in csv.DictReader(f)}
    merged = dict(old)
    for crn, s in sections.items():
        merged[crn] = section_row(s)
    for crn in merged:
        if crn not in sections:
            merged[crn]["status"] = "gone"
    rows = sorted(merged.values(), key=lambda r: int(r["crn"]))
    if rows != sorted(old.values(), key=lambda r: int(r["crn"])):
        with open(sections_path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=SECTION_COLS)
            w.writeheader()
            w.writerows(rows)

    runs_path = os.path.join(DATA, "runs.csv")
    new_runs = not os.path.exists(runs_path)
    with open(runs_path, "a", newline="") as f:
        w = csv.writer(f)
        if new_runs:
            w.writerow(["ts", "term", "sections", "changed"])
        w.writerow([ts, term, len(sections), len(new_rows)])

    print(f"term {term}: {len(sections)} sections, {len(new_rows)} changed, {len(gone)} gone")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--term", action="append", help="term code(s); default: every term open for registration")
    a = p.parse_args()

    b = Banner()
    terms = a.term or b.open_terms()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    failed = False
    for term in terms:
        try:
            track_term(b, term, ts)
        except Exception as e:
            print(f"error: {e}", file=sys.stderr)
            failed = True
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
