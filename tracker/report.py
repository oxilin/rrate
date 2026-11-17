#!/usr/bin/env python3
"""Turn the tracker's change log into fill-up history the extension can read.

Writes:
  data/<term>/fill.json   per-CRN seat history and fill-up summary
  data/index.json         which terms have data and when they were updated
  seats.db (optional)     SQLite copy of everything, for your own queries

fill.json layout (times are Unix seconds):
  {"term", "updated", "since", "runs",
   "s": {crn: {"o": open now, "c": capacity, "w": waitlist, "wc": waitlist cap,
               "f": when it last filled (open -> 0), "fb": full since tracking began,
               "r": times it reopened (0 -> open), "lo": last time it had open seats,
               "h": [[t, open, waitlist], ...] only when something changed}}}

Usage:
  python3 tracker/report.py               # every term in data/
  python3 tracker/report.py --sqlite      # also build seats.db
  python3 tracker/report.py --course CS 100 --term 202710   # print one course's history
"""
import argparse
import csv
import json
import os
import sqlite3
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")


def to_unix(ts):
    return int(datetime.strptime(ts, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc).timestamp())


def as_int(v):
    return int(v) if v not in ("", None) else None


def load_term(term):
    tdir = os.path.join(DATA, term)
    with open(os.path.join(tdir, "sections.csv"), newline="") as f:
        sections = {r["crn"]: r for r in csv.DictReader(f)}
    hist = {}
    with open(os.path.join(tdir, "changes.csv"), newline="") as f:
        for r in csv.DictReader(f):
            hist.setdefault(r["crn"], []).append(r)
    runs = []
    with open(os.path.join(DATA, "runs.csv"), newline="") as f:
        runs = [r["ts"] for r in csv.DictReader(f) if r["term"] == term]
    return sections, hist, runs


def summarize(rows):
    points = [(to_unix(r["ts"]), as_int(r["open"]), as_int(r["wait"])) for r in rows]
    points = [p for p in points if p[1] is not None]  # blank rows = section removed
    if not points:
        return None
    last = rows[-1]
    out = {"o": points[-1][1], "c": as_int(last["cap"]), "w": as_int(last["wait"]), "wc": as_int(last["wait_cap"])}
    reopens, filled, last_open = 0, None, None
    for (t0, o0, _), (t1, o1, _) in zip(points, points[1:]):
        if o0 > 0 and o1 == 0:
            filled = t1
        if o0 == 0 and o1 > 0:
            reopens += 1
    for t, o, _ in points:
        if o > 0:
            last_open = t
    if out["o"] == 0:
        if filled:
            out["f"] = filled
        elif all(o == 0 for _, o, _ in points):
            out["fb"] = 1
    if reopens:
        out["r"] = reopens
    if last_open and out["o"] == 0:
        out["lo"] = last_open
    if len(points) > 1:
        out["h"] = [list(p) for p in points]
    return out


def write_fill(term):
    sections, hist, runs = load_term(term)
    s = {}
    for crn, rows in hist.items():
        summary = summarize(rows)
        if summary:
            s[crn] = summary
    doc = {
        "term": term,
        "updated": to_unix(runs[-1]) if runs else None,
        "since": to_unix(runs[0]) if runs else None,
        "runs": len(runs),
        "s": s,
    }
    path = os.path.join(DATA, term, "fill.json")
    with open(path, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"{path}: {len(s)} sections, {os.path.getsize(path) // 1024} KB")
    return doc


def write_sqlite(terms):
    path = os.path.join(ROOT, "seats.db")
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.executescript("""
      CREATE TABLE sections (term, crn, subject, number, seq, type, title, credits, link,
                             cross_list, instructor, meetings, status, PRIMARY KEY (term, crn));
      CREATE TABLE changes (term, ts, crn, open INT, seats INT, enrolled INT, cap INT,
                            wait INT, wait_cap INT, res_open INT, xl_open INT);
      CREATE TABLE runs (ts, term, sections INT, changed INT);
      CREATE INDEX changes_crn ON changes (term, crn, ts);
    """)
    for term in terms:
        sections, hist, _ = load_term(term)
        db.executemany("INSERT INTO sections VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       [(term, r["crn"], r["subject"], r["number"], r["seq"], r["type"], r["title"], r["credits"],
                         r["link"], r["cross_list"], r["instructor"], r["meetings"], r["status"]) for r in sections.values()])
        db.executemany("INSERT INTO changes VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                       [(term, r["ts"], r["crn"], *(as_int(r[k]) for k in
                         ["open", "seats", "enrolled", "cap", "wait", "wait_cap", "res_open", "xl_open"]))
                        for rows in hist.values() for r in rows])
    with open(os.path.join(DATA, "runs.csv"), newline="") as f:
        db.executemany("INSERT INTO runs VALUES (?,?,?,?)",
                       [(r["ts"], r["term"], r["sections"], r["changed"]) for r in csv.DictReader(f)])
    db.commit()
    print(f"{path} written")


def print_course(term, subject, number):
    sections, hist, _ = load_term(term)
    fmt = lambda t: datetime.fromtimestamp(t).strftime("%b %d %H:%M")
    for crn, sec in sorted(sections.items(), key=lambda kv: kv[1]["seq"]):
        if sec["subject"] != subject.upper() or sec["number"] != number.upper():
            continue
        sm = summarize(hist.get(crn, [])) or {}
        line = f"{crn} {sec['subject']} {sec['number']}-{sec['seq']} {sec['type']:<11} open {sm.get('o')}/{sm.get('c')} wait {sm.get('w')}"
        if sm.get("f"):
            line += f"  filled {fmt(sm['f'])}"
        if sm.get("fb"):
            line += "  full since tracking began"
        if sm.get("r"):
            line += f"  reopened {sm['r']}x"
        print(line)
        for t, o, w in sm.get("h", []):
            print(f"      {fmt(t)}  open {o}  wait {w}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sqlite", action="store_true", help="also build seats.db")
    p.add_argument("--term", help="only this term")
    p.add_argument("--course", nargs=2, metavar=("SUBJECT", "NUMBER"), help="print one course's history")
    a = p.parse_args()

    terms = [a.term] if a.term else sorted(
        d for d in os.listdir(DATA) if os.path.exists(os.path.join(DATA, d, "changes.csv")))
    if a.course:
        print_course(terms[-1], *a.course)
        return
    index = {"terms": {}}
    for term in terms:
        doc = write_fill(term)
        index["terms"][term] = {"updated": doc["updated"], "since": doc["since"], "runs": doc["runs"]}
    with open(os.path.join(DATA, "index.json"), "w") as f:
        json.dump(index, f, indent=1)
    if a.sqlite:
        write_sqlite(terms)


if __name__ == "__main__":
    main()
