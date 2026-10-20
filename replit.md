# replit.md

Replit Agent reads this file. Read `VISION.md` before starting work.
`README.md` indexes all other documentation; check it first.

## If this workspace runs an installation

An installation runs published Field releases. It does not develop Field.

| Task | Read |
| --- | --- |
| Set up a new installation on Replit | `docs/SELF_HOSTING.md` ("Replit"), then `docs/REPLIT.md` ("Configuration", "Database", "Durable storage", "Publishing") |
| Follow stable releases | `docs/REPLIT.md`, "Following stable releases" (`FIELD_DEPLOY_REF=stable`) |
| Update to a new release | `docs/REPLIT.md`, "Updating to a new release" |
| Know when the workspace must be pulled | `docs/REPLIT.md`, "When to pull the workspace" |
| `git pull` fails | `docs/REPLIT.md`, "When to pull the workspace" (take the deploy files from the newest stable tag) |
| Pin a release or roll back | `docs/REPLIT.md`, "Pinning a release and rolling back" |
| Check what is live | `GET /health`: `build.release`, `build.checks`, `storage` |
| Know whether a new release is out | `GET /api/updates` as an owner (`docs/SELF_HOSTING.md`, "Update notice") |

Rules for an installation:

- Do not change Field's code here. A code change goes to the repository as a
  pull request and reaches the installation as a release.
- Never push or sync to GitHub. Make the workspace fetch-only
  (`docs/REPLIT.md`, "A production installation: fetch only").
- Put secrets and start-up settings in Replit Secrets, and in Publishing >
  Adjust settings > Secrets. Put business settings in Field's own screens.
  Never put them in a file in git (`docs/REPLIT.md`, "Where an
  installation's settings go").
- When Replit shows "Development database changes detected", always press
  Cancel. Field migrates production itself when it starts.
- After each publish, bring the workspace's database to the same release:
  `npm ci --no-audit --no-fund && npm run db:apply && npm run db:smoke`
  (`"pending":0`).
- Do not run SQL by hand on the production database.

## If this workspace develops Field

Work on a branch and open a pull request (`CONTRIBUTING.md`). GitHub steps:
`.agents/skills/github-sync/SKILL.md`.
