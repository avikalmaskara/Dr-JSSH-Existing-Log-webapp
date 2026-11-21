# AGENTS.md — start here (Claude, ChatGPT/Codex, any agent)

**App:** Dr. JSSH Existing Log, the EON Sales AC survey log (Google Apps Script web app + Google Sheet).
**Read first:** [docs/handover/dr-jssh-existing-log.md](docs/handover/dr-jssh-existing-log.md)

## Rules
- GitHub `main` is the master copy of the code.
- Changes go through **EON Update App**: edit in this repo → push to the Apps Script project → test on the `/dev`
  URL → **owner approves** → only then update the public deployment (new version on the *existing* deployment ID).
- Never commit secrets: `.clasp.json`, `.clasprc.json`, tokens, Script Property values, team email lists, customer data.
- Never change sharing, triggers, Script Properties or the public deployment without the owner's approval.
- Keep column lookups by header text, IDs self-healing (`nextLogNos_`), and every server function returning `{success, ...}`.
- Simplicity: reuse the same project's test deployment. Don't create extra projects or deployments.

## At the end of every work session
Update the handover's History, alignment and Next action, then commit.
