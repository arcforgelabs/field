---
name: field-release
description: Run a Field stable, beta or correction release from a release branch with npm run release:stable. Use when the maintainer asks for a release, when a release check fails, or when a fix must reach an open release branch.
---

# Field release

This is openclaw/openclaw's release-agent procedure, with Field's names.
`docs/RELEASING.md` holds the workflows and the commands; this file holds
the rules an agent follows while it runs them.

## Start

1. Get the full history: `git fetch --unshallow --tags origin` (or
   `git fetch --tags origin`).
2. Pick the version: `YYYY.M.N`, where `N` is the count of releases this
   month (`node scripts/release/release.mjs plan --channel stable` prints
   it).
3. Run `npm run release:stable -- <version>`. It refuses until the cut is
   confirmed and prints `Next:` with the exact commands. Follow them.

## The cut

- A release ships what `main` holds at the cut. There is no milestone and
  no wait for a pull request that has not merged.
- The cut is the newest `main` commit that Field Full Release Validation
  proved (it runs every 3 hours). Main's health at a later commit never
  gates the release.
- Write the notes at the cut with `.agents/skills/field-changelog-update`,
  and pass their branch as `--notes-ref`.
- Cut once. Never cut again on newer `main` to pick up a fix, and never cut
  again without the maintainer's word.

## Failed checks

Every failed check gets a written decision, blocker or flake, with the
evidence (the job, the error, the commit).

- Blocker: a required lane that fails deterministically on the branch, or
  an install, update or publish defect. Fix it on `main` first, then pick
  it onto the branch with Field Release Branch `cherry-pick` (it uses
  `git cherry-pick -x`). Draft the notes again at the branch's head.
- Flake: rerun on the same commit at most twice, and fix it on `main` in
  parallel. A flake never goes onto the branch.
- A dependency advisory is not a blocker. Only known malware stops a
  release.
- Never skip, disable or quarantine a test to get green.

## Publication

- Nothing waits for a person: run `release:stable` without `--hold`. The
  maintainer's one step is the installation's own deploy. Use `--hold` only
  when the maintainer asks for the stops; then `--approve-publication`
  needs their word for this release (a tapped card counts).
- Field Release Prepare makes the tag (signed when `RELEASE_TAG_SIGNING_KEY`
  is set) and Field Release Checks checks it. The GitHub Release stays a draft until npm serves the version.
- The release is done when the closeout pull request has merged, `main`
  carries the shipped changelog file, its docs page and the version, the
  docs site serves the page, and the GitHub Release body is the roster body
  (`release:stable` phases `docs` and `thanks`).

## Corrections

A published stable release that needs a fix gets `<version>-<n>` on the
same branch (`docs/RELEASING.md`, Correct a stable release). Only the
newest stable release takes a correction.

## Words

The repository is public. No customer, lab, practice or person names in
notes, commits, comments or workflow inputs.
