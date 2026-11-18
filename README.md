# UCR registration tools

Three pieces:

| Folder | What it is |
|---|---|
| `extension/` | **R'Rate**, a Firefox extension. It reads your unmet Degree Works requirements and adds a Requirements panel to the registration site. The panel shows matching sections with real open seats, time conflicts, RMP scores and fill-up history. |
| `tracker/` | **Seat tracker.** It snapshots every section every 2 hours and records only what changed. |
| `data/` | The tracker's output. GitHub Actions commits it here, and the extension reads `data/<term>/fill.json`. |

`ucr_classes.py` is a standalone command-line class search, with `--watch` for seat alerts.

## "Real" open seats

Banner's `seatsAvailable` counts seats held for reserved groups, such as a learning community or a major, and ignores the shared pool for cross-listed courses. Everything here uses this instead:

```
open = reservedSeatSummary.seatsAvailableUnreserved   (when the section has reservations)
open = min(open, crossListAvailable)                   (when the section is cross-listed)
```

On the first snapshot for Winter 2027, 966 of the 11,247 sections listed more seats than a regular student could take.

## Seat tracker

```bash
python3 tracker/tracker.py              # snapshot every term that's open for registration
python3 tracker/report.py               # build data/<term>/fill.json
python3 tracker/report.py --sqlite      # also build seats.db for SQL queries
python3 tracker/report.py --course CS 100   # print one course's seat history
```

Data files (plain CSV so git stores the history compactly):
- `data/<term>/sections.csv`: course, title, type, instructor, meeting times, and whether the section is active or gone.
- `data/<term>/changes.csv`: an append-only log. Each row has `ts, crn, open, seats, enrolled, cap, wait, wait_cap, res_open, xl_open` and is written only when a value changes.
- `data/runs.csv`: every run, so "nothing changed" can be told apart from "didn't check".

Example query after `--sqlite`:

```sql
-- Sections that went from open to full, and when
SELECT s.subject, s.number, s.seq, c.ts
FROM changes c JOIN sections s USING (term, crn)
WHERE c.open = 0 ORDER BY c.ts;
```

### Running it on GitHub

`.github/workflows/track.yml` runs every 2 hours and commits `data/`. To set it up:
1. Create a **public** repo on GitHub and push this folder to it.
2. In the repo, open **Actions**, enable workflows, then run **Track seats** once with **Run workflow**.
3. The extension reads from `oxilin/rrate`. If the repo moves, update `FILL_REPO` in `extension/background.js`.

GitHub turns off scheduled workflows in repos with no activity for 60 days. The tracker's own commits normally keep it active.

## Extension

Install it temporarily: go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and pick `extension/manifest.json`. Open Degree Works once so it saves your requirements, classes, class standing and major.

The **R'Rate** button on the registration site opens a panel with three tabs. There's a term picker at the top.

**Requirements**: your unmet Degree Works requirements, grouped into collapsible blocks. Click a requirement to see the courses that satisfy it, split into **Courses you can take** and **Missing prerequisites or restricted**. Each course shows:
- a prerequisite badge: ✓ met, ⏳ met if you pass a course you're taking now, ✗ missing, or ⚠ check manually
- a restriction badge (e.g. "✓ Juniors & Seniors only"), checked against your class standing and major
- corequisites, e.g. "Also register for WRIT 040Q at the same time"
- **+ builder**, which adds the course to the Schedule builder

Sections are grouped into Lecture / Discussion / Lab dropdowns, with open sections first. Each section shows:
- real open seats
- which sections it pairs with ("goes with lecture 020", "with 1 discussion (D2) + 1 laboratory (B2)")
- fill history
- **odds**: whether it's likely to still have a seat at your registration time

**Export my schedule (.ics)** downloads your registered classes as a calendar file.

**Banner's own results table** (`banner-tweaks.js`, `banner-hook.js`, `banner-tweaks.css`): standalone and switchable in Settings.
- **Re-sort:** within each course, lectures come first, then discussions, then labs. Inside each type, Mon/Wed/Fri sections come before Tue/Thu, then earlier start times. Banner's server can only sort by section number, so R'Rate fetches the whole search once, re-sorts it, and answers each of Banner's page requests with the right slice. Banner's table, paging and buttons work as usual. Column sorting you pick yourself and searches over 3,000 results keep Banner's order.
- **Results per page:** sets Banner's "Per Page" for you (10, 15, 20 or 50; default 50). Pick fewer on a slow computer. Changing it in Banner yourself overrides it for that visit.
- **Type tags:** a colored tag (Lecture, Discussion, Lab, Workshop…) on each row, a colored stripe by type, and a line between courses.

**Search results (R'Rate view of Banner's class search)**: after you search in Banner's Browse Classes / Find Classes, an **R'Rate view · all N** button appears next to **Search Again**. It re-runs the same search with every result at once instead of 10 per page. The results open in a wide panel grouped by course, then Lecture / Discussion / Lab, then meeting days (Mon/Wed/Fri patterns before Tue/Thu), with open sections first. Every course gets the same badges, odds and pairing info as the Requirements tab, and sections you're registered for are marked.

**Schedule builder**: add courses, set preferences (days off, start/end times, Monday start, Friday finish, open seats only, keep current registration, skip sections likely full by your time), and click **Find schedules**. It tries every valid lecture + discussion + lab combination, adds corequisites automatically, and ranks the conflict-free schedules by days on campus, gaps, Friday finish and early starts. Each option has a week view, **Copy CRNs** and **Export .ics**.

**Settings**: your registration time (used for the odds), class standing and major (used for restrictions).

**Banner errors**: after you submit, R'Rate adds a plain-English explanation under Banner's registration errors (prerequisite error, time conflict, closed/reserved section, link error, unit limit, restrictions, and so on).

Code layout: `prereqs.js`, `linking.js`, `restrictions.js`, `odds.js`, `builder.js` and `ics.js` are pure logic with no browser APIs. `planner.js` is the panel. `errors.js` adds the error explanations. `dw-content.js` reads Degree Works. `search-hook.js` runs in the registration page and reports the URL of each Banner search, so R'Rate can re-run it.
