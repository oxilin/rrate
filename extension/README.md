# R'Rate – UCR Registration Helper (v0.2)

## What it does
1. **RMP badges.** Shows Rate My Professors scores next to instructor names on registrationssb.ucr.edu.
2. **Requirements panel.** Open Degree Works once and R'Rate saves your unmet requirements. On the registration page, click the **Requirements** button in the bottom right, then click any requirement. You get every section this term that satisfies it, with:
   - meeting times, with red rows for time conflicts with your current schedule
   - open seats, or the waitlist count when full
   - instructor and RMP score
   - a **+** button to collect CRNs. "Copy" puts them on your clipboard to paste into the Enter CRNs tab.

The extension never registers you for anything. You still submit in Banner yourself.

## Install (temporary, for testing)
1. Go to `about:debugging#/runtime/this-firefox`.
2. If an old R'Rate is loaded, click **Remove**.
3. Click **Load Temporary Add-on…** and pick `manifest.json`.
4. Open Degree Works and wait for a "saved N unmet requirements" popup.
5. Open Registration, then Register for Classes, and click **Requirements**.

## If something's off
Click **Copy debug info** at the bottom of the panel and paste the result to Claude. It includes the structure of your audit with your student ID removed, along with any errors and one sample section, so the parsing can be fixed.

## Notes
- Searches use your logged-in session and the same endpoints the registration page uses, one at a time. If the registration page acts strangely after you've used the panel, reload it.
- Your audit is stored only in this browser (extension storage).
- RMP's API isn't official, so badges can break if RMP changes it.
