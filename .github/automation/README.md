# GitHub bot automation

Public repositories cannot call a private reusable workflow. These local workflow copies
come from `arcforgelabs/.github@a115c8f8dc02978d8c82c9554f02ea8e013a6981` (PR #5).
Upstream helper and reaction logic: `openclaw/openclaw@5ff5fb278348bb6d2280bfbfb7e5cd3a66e74712`, MIT.

Only delivery changes: direct event triggers, default manual inputs, trusted base checkout
of this repository, caller-only App repository scope, and the helper path here. No PR code
is executed. Preserve those substitutions when updating from the shared implementation.
Labeler uses the arc-forge-barnacle App token; reactions use GITHUB_TOKEN.

Field copies these files from `arcforgelabs/dictate` (`.github/workflows/labeler.yml`,
`maintainer-command-reactions.yml` and this folder). Its only change is
that the size label leaves out `package-lock.json`, `client/package-lock.json` and
`e2e/package-lock.json`, as
it already leaves out other lockfiles. Field's area labels are in `.github/labeler.yml`.

ClawSweeper needs no workflow here. An `arcforgelabs` organization webhook sends this
repository's issue, comment and pull request events to ClawSweeper; enrolment is
`ARCFORGE_ACTIVITY_REPOSITORIES` in `arcforgelabs/clawsweeper`.
