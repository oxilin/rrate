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

Install it temporarily: go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and pick `extension/manifest.json`. See `extension/README.md` for how to use it.

In the Requirements panel, the seat column now shows:
- **Real open seats.** A small "not open to you ⓘ" or "fewer than listed ⓘ" note appears when Banner's number is misleading. Hover over it for details.
- **Fill history** from the tracker: a sparkline of open seats over time, plus notes like "−8 in last day", "filled Nov 20", "reopened 2×" and "full since tracking began".
