# Dr. JSSH Existing Log — Handover
Last updated: 21 Nov 2026 by Claude

## Purpose
Survey log of the air conditioners at the Dr. J.S.S.H site: area/room, floor, AC status (Existing / Existing
(Dismantle) / New Required), brand, tonnage, qty, photos (serial number visible) and remarks. Each AC
gets a unique Log No `JSSH/<FY>/0001`. There is a dashboard with filters, CSV export and edits (each
edit is logged). Users are the EON team only (emailed one-time code checked against EON_Team).

## Source locations
| Repo folder | Apps Script project | Script ID |
|---|---|---|
| `apps/dr-jssh-existing-log/main/` | "Dr. JSSH Existing Log" (container-bound to the Sheet) | `1UkcwCoMqJC1pEZV2C-afnSGdrdhzRBo5v7zjZyPkBOzC20p8jsHd34xs` |

Files: `Code.js` (all server logic), `Index.html` (whole UI: sign-in, log form, summary, dashboard, edit),
`appsscript.json`. No libraries, no helper projects.

## Projects and Sheets
- Sheet **"Dr. J.S.S.H Existing A.C log"** `1JJF3a9QJFETvPe6Ib_-yHqRbRotYTrSvH_5m6ozKwrA` (container parent, accessed through `getActiveSpreadsheet`).
  - `Log`: one row per AC. Headers: Log No, Area/Room No, Floor, AC Status, Brand, Tonnage, Qty, Photo, Remarks,
    Entered By, Logged At, Last Edited By, Last Edited At. Missing headers are appended automatically, and columns
    are found by header text.
  - `Dashboard Edit`: edit history (Timestamp, Log No, Field, Old Value, New Value, Edited By).
  - `EON_Team`: Name, Role, Email ID, Attachment Access, Status. Auto-created with director@ if missing.
- Drive folder **"Dr. JSSH Existing Log Photos"** (next to the Sheet): `_pending uploads`, then `FY <yy><yy>/` on submit.
  Photos are shared Anyone-with-link, Viewer (owner's explicit choice).

## Deployment
- **Public:** `AKfycbz6c7fE2jU91q-p4huOfOcNHv4nMXaXUCyHZTsHZ89ZgpuY1QGHz9Gnix5U-_cWjhlJ` @ version 1 "v1 - initial release".
  Execute as: deploying user (director@eonsales.in). Access: `ANYONE` (any signed-in Google account; the app's OTP + EON_Team is the real gate).
  URL: https://script.google.com/macros/s/AKfycbz6c7fE2jU91q-p4huOfOcNHv4nMXaXUCyHZTsHZ89ZgpuY1QGHz9Gnix5U-_cWjhlJ/exec
- **Test:** HEAD deployment `AKfycbxTqoVxRhUo0M-4xBAvXyXD4RaB0MQlxU2mFzAqcSA`, URL
  https://script.google.com/macros/s/AKfycbxTqoVxRhUo0M-4xBAvXyXD4RaB0MQlxU2mFzAqcSA/dev (editors only, latest saved code).
- Publishing an update: push → `clasp create-version` → `clasp update-deployment <public id> -V <n>` (or editor:
  Manage deployments → pencil → New version). **Never create a new deployment**, because that changes the URL.

## Triggers
- Simple `onEdit(e)`: clears the 5-min team cache when the EON_Team tab is edited. No installable triggers.

## Configuration (names only)
Script Properties: `SESSION_SECRET` (HMAC key, auto-generated), `PHOTO_ROOT_FOLDER_ID` (auto), `LOG_COUNTER_<FY>` (auto).
Code constants: `CONFIG` (sheet/tab names, OTP and session timings, photo limits, owner email), `OPTIONS` (tap choices).
Browser localStorage: `jssh_session_v1` (session token), `jssh_draft_v1` (unsent form draft, Drive refs only).

## GitHub ↔ Apps Script alignment
Aligned as of 21 Nov 2026: `main` = pushed code = public version 1.

## Testing
Use the `/dev` URL signed in as director@. Check sign-in, a multi-AC submit with photos, the summary Edit
button, the dashboard filters and edit, and that the edit appears in `Dashboard Edit`.

## Risks and known limitations
- MEDIUM: photos are viewable by anyone with a photo link (deliberate). Don't photograph documents with pricing or patient data.
- MEDIUM: sessions last 1 year per browser. Revoke by removing the person from EON_Team or deleting `SESSION_SECRET`.
- LOW: abandoned uploads stay in `_pending uploads`. No cleanup job yet.
- LOW: MailApp quota (~1,500/day Workspace) limits sign-in codes; fine at team scale.
- LOW: the dashboard reads the whole Log tab on each open. Fine to a few thousand rows.

## History (newest first)
- 21 Nov 2026: owner completed first-run authorization; /exec loads the sign-in screen.
- 21 Nov 2026: v1 built, project created bound to the Sheet with clasp, deployed @1, onboarded to GitHub (Claude).

## Next recommended action
Owner signs in once (this creates the EON_Team tab with director@), then adds team emails to EON_Team.
Share the domain-form link: https://script.google.com/a/macros/eonsales.in/s/AKfycbz6c7fE2jU91q-p4huOfOcNHv4nMXaXUCyHZTsHZ89ZgpuY1QGHz9Gnix5U-_cWjhlJ/exec
(the plain /macros/s/ form returns a Drive 404 when several Google accounts are signed in).
Possible next updates (through EON Update App): void/delete a log, floor-wise summary, cleanup of pending photos.
