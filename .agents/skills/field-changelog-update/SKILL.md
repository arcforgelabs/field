---
name: field-changelog-update
description: Write a Field release's changelog file (CHANGELOG/<version>.md, its record in CHANGELOG/records/ and its docs page in docs/releases/) from the history since the previous release. Use when cutting a beta or stable release, or when asked to write or fix release notes.
---

# Field changelog update

This is openclaw/openclaw's `openclaw-changelog-update` skill, with Field's
names. `CONTRIBUTING.md` holds the rules; `scripts/release/changelog.mjs`
holds the tool, the format check (`check`) and the history check
(`verify`).

## When

At the release cut, before Field Release Branch cuts `release/<version>`
(`docs/RELEASING.md`, Release a stable version). Commit the files on any
branch and pass it as `notes_ref`: the cut puts them on the release branch
in the release commit. They never go through a pull request to `main`;
Field Release Closeout brings them there after the stable release. Never in
a feature pull request. Draft again at the branch's head after a blocker
pick, and put the refreshed files on the branch with Field Release Branch
`notes` (or in the same `cherry-pick` run). Prepare refuses a release while
its file misses a pull request, misses GitHub's credit or breaks the
highlight budget. Publish uses the file as the GitHub Release body and
checks the published body. Each beta gets its own file
(`CHANGELOG/<version>-beta.<n>.md`), never a copy of the stable file; the
stable release gets a new, cumulative file, and a correction
(`CHANGELOG/<version>-<n>.md`) the same range plus its fix.

## Inputs

- Stable base: the newest stable release tag older than the version, on
  any branch. When it is not in the target's history (it shipped from its
  own release branch), the range starts at their merge base and leaves out
  the pull requests that release already shipped, picks included.
- Beta base: the version npm's `beta` tag selects before the beta
  publishes. `draft` reads it with `npm view @arcforgelabs/field
  dist-tags.beta`. If npm already selects this beta or a newer one, pass the
  tag you captured before publishing with `--base`.
- Target: the commit the release will tag: the cut commit on `main` before
  the branch exists, then the branch's head (`origin/release/<version>`).
  The record's target may be an older commit of that history; any pull
  request merged after it makes `verify` fail until you draft again.

## Steps

1. Get the full history. A shallow clone gives a short range, and the tool
   refuses it:

   ```bash
   git fetch --unshallow --tags origin   # or: git fetch --tags origin
   ```

2. Draft the section and its manifest. `draft` reads each pull request's
   author, commits and closed issues from GitHub (`gh api`):

   ```bash
   node scripts/release/changelog.mjs draft --version <version> \
     --output /tmp/section.md --manifest /tmp/manifest.json
   ```

   The draft has every `feat`, `improve` and `fix` pull request under
   Changes or Fixes, the first eight of them as Highlights, and the complete
   contribution record: every pull request in the range once, as
   `- **PR #N** Related #I. Thanks @a and @b.` The manifest also lists the
   direct commits. They are editorial input; they get no row.

3. Read the manifest, then edit the prose, not the record:
   - Highlights: 1 to 8 bullets for a stable release, 0 to 8 for a beta.
     One user story per bullet, in one sentence, with every pull request
     that tells it: `- Text. (#N, #M) Thanks @a.` Leave out tests, CI,
     refactors and docs unless the outcome is a material install, update or
     data-safety change.
   - Changes: new capabilities and behaviour changes. Fixes: user-facing
     fixes first. Group pull requests that tell one story into one bullet.
   - A bullet that names a pull request keeps every thanks from its record
     row. Issues stay inline as `#N`.
   - Put the user-visible fixes first: data safety, then sending and sync,
     then screens. Drop release-process words such as "release 2026.10.31".
   - Never thank bots, Claude, Codex, the organization or the maintainer.
   - No customer, lab, practice or person names. The repository is public.

4. Save it, and check it against history and GitHub:

   ```bash
   node scripts/release/changelog.mjs write --version <version> --file /tmp/section.md
   node scripts/release/changelog.mjs verify --version <version>
   npm run changelog:check
   ```

5. Commit `CHANGELOG/<version>.md`, `CHANGELOG/records/<version>.md`,
   `CHANGELOG.md` and, for a stable release or a correction,
   `docs/releases/<version>.md` together on your branch, push it, and give
   it to the cut or to Field Release Branch `notes` as `notes_ref`. `write`
   writes the docs page from the file; never edit the page by hand.

6. After Publish, it runs the body check itself. To run it by hand:

   ```bash
   node scripts/release/changelog.mjs verify --version <version> --check-github
   ```

`node scripts/release/changelog.mjs notes --version <version>` prints the
GitHub Release body for that version: the whole section, or, past GitHub's
125,000-character limit, the prose and a link to the tag's record file.
`verify` keeps GitHub's answers in `.git/field-changelog/`;
`--refresh-github-snapshot` asks again.

## Docs page and roster

OpenClaw's post-release docs route, with Field's names:

- The docs page. `write` and `index` write `docs/releases/<version>.md` for
  each stable release and correction from its file: the prose for readers,
  with the pull requests, issues and people as links, the numbers, and a
  link to the record. `check` refuses a page that is not the file's page.
  The closeout pull request carries the page to `main`; Docs Sync Publish
  mirrors it to `arcforgelabs/docs`, which lists every release with the
  highest stable as latest (https://arcforgelabs.github.io/docs/field/releases/).
- The roster. After the docs site serves the page, `release:stable` (phase
  `thanks`) reads the GitHub Release again and replaces only its body with
  `node scripts/release/changelog.mjs thanks --version <version>`: the
  version, its pull requests, direct commits and contributors, the docs,
  Raw changelog and record links, and one alphabetical roster of every
  person GitHub credits on its pull requests and direct commits (authors,
  co-authors, issue reporters). The maintainer is in the roster; bots,
  agents and the organization are not. The published body's
  `### Release verification` section stays. It reads the body back with
  `verify --check-github --post-docs`. Never retag, rebuild or publish again
  to change the body.

## Differences from OpenClaw

- A stable release has 1 to 8 highlights, not OpenClaw's 5 to 8. Reason:
  Arc Forge's stable releases are often small, and a highlight must be a
  real user-facing change; the maintainer chose this on 20 Oct 2026 rather
  than pad highlights with internal work.
- The docs page is written from the changelog file at the cut, and the file
  stays the one source. OpenClaw writes its docs page by hand in a separate,
  approved docs pull request after the release, then turns the changelog
  file into a flat copy of the page (`changelog:from-docs`). Reason: the
  handover of 2026-10-20 puts the page at the cut, in the closeout pull
  request, and one source keeps the page, the file and the release body in
  step. This is open for the maintainer's review (a hand-written page needs
  that second pull request and its approval for every release).
- OpenClaw's post-docs body renderer is in its private release tooling.
  Field's `thanks` body follows the public text of OpenClaw's skill (numbers,
  Raw changelog and docs links, the roster, the verification section); its
  exact layout is Field's.
- Docs pages exist for stable releases and corrections only, as OpenClaw's
  `docs/releases/` has no beta page.
