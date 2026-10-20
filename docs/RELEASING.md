# Releasing Field

Field releases as openclaw/openclaw does. A release is a release train: it
ships what `main` holds at the cut, and nothing waits for a named feature.
A release agent picks the cut, a `main` commit that the 3-hourly Field Full
Release Validation proved, and cuts a release branch `release/YYYY.M.N`
from it. After the cut, only blocker fixes enter the branch, as `-x`
cherry-picks of merged `main` commits. Each release is one annotated tag on its
release branch (signed once the maintainer sets a key), built once and published three ways: an npm package, a
container image, and a GitHub Release that records both. After a stable
release, a closeout pull request brings what shipped back to `main`. An
installation runs a release it chose, by version and fingerprint, never a
branch.

## What a release produces

| Output | Where | How you verify it |
| --- | --- | --- |
| npm package `@arcforgelabs/field@<version>` | [npmjs.com](https://www.npmjs.com/package/@arcforgelabs/field) | `npm audit signatures` after install: the registry signature and SLSA v1 provenance from trusted publishing. No npm token is stored anywhere. |
| Image `ghcr.io/arcforgelabs/field@sha256:…` | [GHCR](https://github.com/arcforgelabs/field/pkgs/container/field) | `gh attestation verify oci://ghcr.io/arcforgelabs/field@sha256:… --repo arcforgelabs/field`: GitHub's build provenance and SBOM attestations for that digest |
| GitHub Release `v<version>` | [Releases](https://github.com/arcforgelabs/field/releases) | `sha256sum -c <file>.sha256` for each asset |

Each GitHub Release has these assets, each with a `.sha256` file:

- `release-manifest.json`: the version, channel, commit, the result of every
  check lane, the npm integrity and shasum, the tarball's SHA-256, the image
  digest and tags, and the schema and data migrations the release contains.
- `postpublish-evidence.json`: what the publish run verified from outside,
  after publishing: `npm audit signatures`, the npm provenance type, and the
  image's verified attestations.
- `arcforgelabs-field-<version>.tgz`: the npm tarball, byte for byte.
- `field-image-<version>.spdx.json`: the image's SBOM.
- `field-server-<version>.cdx.json` and `field-client-<version>.cdx.json`:
  SBOMs of the server's and the browser bundle's production dependencies.

The notes are the release's changelog file, `CHANGELOG/<version>.md`
(`CONTRIBUTING.md`, `.agents/skills/field-changelog-update/SKILL.md`). Every
release needs one: Field Release Prepare refuses to tag a release unless the
file's record lists every pull request in its range with GitHub's credit,
and a stable release has 5 to 8 highlights. After the GitHub Release is
published, Publish checks that its body is the file. A release tagged before
the changelog existed keeps GitHub's generated notes.

Each stable release and correction also gets a docs page,
`docs/releases/<version>.md`, which `changelog.mjs write` writes from the
file. The closeout brings it to `main`, and the docs site shows it at
https://arcforgelabs.github.io/docs/field/releases/. After the docs site
serves it, the release's GitHub Release body becomes the roster body
(`changelog.mjs thanks`): the numbers, the docs and changelog links, and
every person GitHub credits.

## Versions and channels

Versions are `YYYY.M.N` with no leading zeros: the year, the month, and a
count of releases in that month. The count is not the day, and it can pass
31: `2026.10.31` comes before `2026.10.32`. A new month can start again at 1.
A stable release is `2026.10.18`. A beta is a pre-release of the **upcoming**
stable version, so `2026.10.18-beta.1` and `2026.10.18-beta.2` come before
`2026.10.18`. A correction is `2026.10.18-1`: a fix of a published stable
release from its release branch, when that version cannot be published
again (npm never replaces a version). Corrections count from 1 and come
after their stable release. Tags add a `v`, are annotated (signed when a key is set), and
each GitHub Release is titled `field <version>`. On a release branch,
`package.json` holds the branch's version; a beta and a correction take
their own version only in the packed tarball. `main` holds the newest
shipped version, set by each closeout. `scripts/release/release.mjs` holds
the rules, and `scripts/release/release.test.js` tests them.

| Channel | npm dist-tag | Image tags | GitHub Release |
| --- | --- | --- | --- |
| beta | `beta` | `<version>`, `beta` | pre-release |
| stable | `latest` | `<version>`, `stable`, `latest` | release, marked latest |
| correction | `latest` | `<version>`, `stable`, `latest` | release, marked latest |

A release reaches its channel when it is published; there is no separate
step. The GitHub Release stays a draft until npm serves the version, then
Field NPM Release makes it public, as openclaw/openclaw does, so an
installation that follows GitHub's latest release never sees a version npm
does not have.

## The workflows

| Workflow | Starts | Does |
| --- | --- | --- |
| `field-full-release-validation.yml` (Field Full Release Validation) | Every 3 hours on `main`; on a release branch after each change there (Field Release Branch); by hand | Proves one exact commit with every lane a release needs: all CI lanes (`test`, `docker-build`, `package`) and the secret scan over the whole history. On a release branch it also requires `package.json` to hold the branch's version and each changelog file of that version to match its history. A scheduled run reuses an earlier pass of the same commit. Publishes nothing. |
| `field-release-branch.yml` (Field Release Branch) | By hand or from `release:stable`, from `main` | The only writer of `release/YYYY.M.N`. `cut` creates it at a picked `main` commit with one release commit on top: `package.json`'s version and the version's changelog files from `notes_ref`. `cherry-pick` copies merged `main` commits with `git cherry-pick -x` (blocker fixes only), with refreshed notes if given. `notes` replaces the version's changelog files. Each push starts the validation, CI and the secret scan on the branch. |
| `field-release-prepare.yml` (Field Release Prepare) | By hand or from `release:stable`, from `main` | Takes a commit on a release branch (default: its head) that Field Full Release Validation proved. Plans the next tag for the channel (beta, stable or correction), verifies the changelog, creates the tag annotated and signed with the release tag key, and starts Field Release Publish. |
| `field-release-checks.yml` (Field Release Checks) | From Field Release Publish | Requires the tag to be annotated before it checks anything out, and its signature verified by GitHub when `RELEASE_REQUIRE_SIGNED_TAGS` is `true`; to be a calendar version that matches `package.json`; and to sit on its release branch. Runs every CI lane on its commit, packs the npm tarball with a shrinkwrap of the tested dependencies, then installs it in an empty directory and starts it against PostgreSQL. Publishes nothing. |
| `field-release-publish.yml` (Field Release Publish) | From Field Release Prepare, or by hand for an existing tag | `approve` job at the start, alongside the checks: environment `release` for a stable release or correction, `release-beta` for a beta. Then the `image` job pushes the image by digest, attests it and its SBOM, verifies the attestation, starts the pushed digest against PostgreSQL, then adds the channel's tags. Then it creates the GitHub Release as a draft with the manifest, checks its body is the changelog file, and starts Field NPM Release for the tarball it proved. |
| `field-npm-release.yml` (Field NPM Release) | From Field Release Publish | Requires the tarball from that run to match the GitHub Release's manifest. Dispatched by Field Release Publish, it publishes on that run's approval: it checks that GitHub Actions dispatched it, that the run is for this tag, and, for a stable release, that GitHub's approvals record shows `release` approved. Dispatched by hand, it waits for `npm-release` first. `publish` runs in environment `npm-publish`: npm trusted publishing with provenance, to the channel's dist-tag. Then it verifies what npm serves, attaches the post-publish evidence and makes the GitHub Release public. For a stable release or correction it starts Field Release Closeout. |
| `field-release-closeout.yml` (Field Release Closeout) | From Field NPM Release, or by hand | openclaw/openclaw's stable main closeout. Requires every commit of the release branch that `main` lacks to be the release commit, a changelog commit or a `-x` cherry-pick of a `main` commit. On branch `release/<version>-main-closeout` from `main`, it copies the version's changelog files and sets `package.json` to the shipped version (unless `main` is newer), then opens `chore(release): close out <version> on main` and starts its checks. It does not merge. |
| `field-release-promote.yml` (Field Release Promote) | By hand or from `release:stable`, from `main` | Points a channel at a published release, to roll it back or put it back, and moves `beta` up after a stable release. It verifies the release (the manifest's checksum, the npm integrity, signatures and provenance, and the image attestation), then in environment `npm-release` moves the channel. A stable tag moves npm `latest`, GHCR `stable` and `latest`, and GitHub's latest release, and moves `beta` up when the beta channel is behind. A beta tag moves npm and GHCR `beta`. |

| Action | Approvals |
| --- | --- |
| Beta (`vYYYY.M.N-beta.B`) | 0 |
| Stable release (`vYYYY.M.N`) or correction (`vYYYY.M.N-C`) | 1: `release` (switched off for now, by the maintainer's decision; the one difference from openclaw/openclaw) |
| Promote or roll back a channel | 1: `npm-release` (switched off for now) |
| Field NPM Release dispatched by hand | 1: `npm-release` (switched off for now) |

Every release workflow that changes anything runs only from `main`, so the
release tooling is `main`'s even when the release is an older branch; every
environment accepts only runs from `main`, and `npm-publish`, the
environment npm's trusted publisher names, has no reviewer of its own.
Release tags (`v20*`) cannot be moved or deleted
(`.github/rulesets/release-tags.json`), and release branches cannot be
deleted or force-pushed (`.github/rulesets/release-branches.json`). Each job
that builds or publishes checks out the tag itself, never a commit handed on
from an earlier job, and stops if the tag no longer points at the commit the
checks proved (`scripts/release/workflows.test.js` holds this rule). A lightweight tag
(every tag from before release branches) is never published again: fix forward with a new version.

`main`'s CI health never gates a release: validation and publication run on
the release branch. A red `main` is fixed on `main`, in parallel.

npm can take minutes to serve a new version. Field NPM Release reads it back
with backoff for about 15 minutes, and a rerun skips a version npm already
serves with the manifest's integrity, so rerunning its failed jobs is safe.

Running Field Release Publish again for the same tag is safe. It checks again,
updates the GitHub Release's assets, and starts Field NPM Release, which skips
an npm version that is already published with the same bytes and refuses one
published with different bytes. A published version is never replaced: fix
forward with a correction or a new version.

## Release a stable version

One command runs the whole stable release, as openclaw/openclaw's
`pnpm release:stable` does. A release agent runs it when the maintainer asks
for a release, and follows `.agents/skills/field-release/SKILL.md`:

```bash
git fetch --unshallow --tags origin   # or: git fetch --tags origin
npm run release:stable -- 2026.10.34
```

It is a resumable state machine with the phases `cut → validate → publish →
flip-github → sync-beta → closeout → docs → thanks`. State lives in
`.artifacts/release-<version>/state.json`; running the command again
continues from the first phase not completed, `--from <phase>` starts again
from a phase, `--status` prints the table, and `--dry-run` prints every
command that would change anything without running it. Every refusal prints
`Next:` with the exact commands to run before resuming. It waits for no
person: the maintainer's one step is the installation's own deploy. For now
that is on purpose, so releases stay fast. `--hold` adds openclaw's two
stops for when they are wanted: confirm the cut (`--confirm-cut-sha <sha>`)
and approve publication (`--approve-publication`, which also merges the
closeout).

1. **cut.** The command picks the newest `main` commit that Field Full Release
   Validation proved (or `--cut-sha`), and refuses until the version's notes
   exist (and, with `--hold`, until that commit is confirmed). Write them at the cut
   (`.agents/skills/field-changelog-update/SKILL.md`), with 5 to 8 highlights:

   ```bash
   node scripts/release/changelog.mjs draft --version 2026.10.34 --target <cut> --output /tmp/section.md --manifest /tmp/manifest.json
   # edit the Highlights, Changes and Fixes
   node scripts/release/changelog.mjs write --version 2026.10.34 --file /tmp/section.md
   node scripts/release/changelog.mjs verify --version 2026.10.34 --target <cut>
   ```

   Commit `CHANGELOG/` on any branch, push it, and run the command again
   with `--notes-ref <branch>`. Field Release Branch
   cuts `release/2026.10.34` with the release commit: the version and the
   notes, in one commit. The notes never go through a pull request to
   `main`; the closeout brings them there.
2. **validate.** Field Full Release Validation runs on the branch's head.
3. **publish.** Field Release Prepare tags the head (signed when a key is
   set), Field Release Publish and Field NPM Release run, and the
   phase ends when npm serves the version.
4. **flip-github.** The GitHub Release is public and GitHub's latest.
5. **sync-beta.** npm `beta` moves up to the release when it is behind
   (Field Release Promote), so beta users are never behind stable.
6. **closeout.** Field NPM Release started Field Release Closeout; the
   command opens its pull request if GitHub Actions could not, waits for
   `test` and `gitleaks`, and merges it. `main` then carries the shipped
   changelog file, its docs page and the version.
7. **docs.** Docs Sync Publish mirrors `docs/` to `arcforgelabs/docs`, and
   its Pages workflow deploys the site. The phase ends when
   `https://arcforgelabs.github.io/docs/field/releases/<version>.md` is the
   page `main` has.
8. **thanks.** openclaw/openclaw's step after the docs deploy: the command
   reads the GitHub Release again, replaces only its body with
   `node scripts/release/changelog.mjs thanks --version <version>`, and
   reads it back (`verify --check-github --post-docs`). The release is done
   here.

A beta needs no command of its own: after the cut, start one from the
branch. Its notes are its own file, `CHANGELOG/<version>-beta.<n>.md`, from
the release npm's `beta` tag selects, put on the branch with Field Release
Branch `notes`:

```bash
gh workflow run field-release-branch.yml --repo arcforgelabs/field --ref main -f operation=notes -f version=2026.10.34 -f notes_ref=<branch>
gh workflow run field-release-prepare.yml --repo arcforgelabs/field --ref main -f channel=beta -f branch=release/2026.10.34
```

### Blockers, flakes and the cut

The release branch is the work queue. `main` moves on; the branch takes
only fixes for confirmed release blockers: a required lane that fails
deterministically on the branch, or an install, update or publish defect.
A flake is not a blocker, and neither is a dependency advisory (only known
malware stops a release). Every failed check gets a written decision,
blocker or flake. Rerun a flake on the same commit at most twice, and fix it
on `main` in parallel. Never cut again on newer `main` to pick up a fix, and
never cut again without the maintainer's word.

A blocker fix merges to `main` first, then reaches the branch:

```bash
gh workflow run field-release-branch.yml --repo arcforgelabs/field --ref main \
  -f operation=cherry-pick -f version=2026.10.34 -f commits="<main sha> <main sha>" -f notes_ref=<branch>
```

The pick adds its pull request to the release's range, so the stable notes
need it in their record: give `notes_ref` the refreshed notes (drafted
again at the branch's head) in the same run, or run `notes` after it. When a
pick does not apply cleanly, open a pull request into `release/<version>`
with the resolved cherry-pick, keeping its `(cherry picked from commit …)`
line, and merge it. Release-process changes (workflows, release scripts and
tests, this file) land on `main` first too, and reach an open branch the
same way.

### Correct a stable release

When a published stable release needs a fix and its version cannot be
published again, cherry-pick the fix onto its branch, write
`CHANGELOG/<version>-<n>.md` (the same range as the stable release's notes,
plus the fix, with 5 to 8 highlights), put it on the branch, and prepare a
correction:

```bash
gh workflow run field-release-prepare.yml --repo arcforgelabs/field --ref main -f channel=correction -f branch=release/2026.10.34
```

Only the newest stable release takes a correction. It publishes to npm
`latest` as `2026.10.34-1`, and Field Release Closeout brings its notes to
`main`.

### Roll back

To roll back, point the channel at the previous release (a stable tag for
`latest`, a beta tag for `beta`). Nothing is unpublished:

```bash
gh workflow run field-release-promote.yml --repo arcforgelabs/field --ref main -f tag=v2026.10.33
```

Prepare has no dry run: the tag it creates is protected and cannot be
deleted, and it starts the publish at once. `npm run release:stable --
<version> --dry-run` prints what a release would run. To test the release
steps without publishing, run Field Full Release Validation on any branch, or
look at CI on any pull request: its `package` and `docker-build` lanes run
the same smokes as a release.

## Run a release

`docs/SELF_HOSTING.md` describes how to pin, verify and run a release with
Docker, with Node, or on Replit (`deploy/replit/`).

## One-time setup

GitHub (done with `gh`; each item can be undone in the repository settings):

- Environments `release`, `npm-release`, `release-beta` and `npm-publish`:
  no reviewer (`release` and `npm-release` had Samuel as required reviewer
  until October 2026). All four deploy from `main` only.
- The release tag ruleset, from `.github/rulesets/release-tags.json`.

Ready for when releases go more secure, by Samuel; not needed now, and no
release waits for them (decided 20 Oct 2026: releases stay fast, with the
installation's deploy as the one step):

1. **The release branch ruleset.** Settings → Rules → Rulesets → New ruleset
   → New branch ruleset. Name `Protect Field release branches`, enforcement
   Active, no bypass list. Target branches → Add target → Include by
   pattern `release/20*`; Exclude by pattern `release/*-main-closeout`.
   Rules: tick **Restrict deletions** and **Block force pushes**, nothing
   else. Create. (Or New ruleset → Import a ruleset, with
   `.github/rulesets/release-branches.json`.)
2. **The release tag signing key.** Prepare signs each tag with an SSH key.
   Make one on your own computer: `ssh-keygen -t ed25519 -C "field release
   tags" -N "" -f field-release-tags`. Then:
   - Repository Settings → Secrets and variables → Actions → New repository
     secret: name `RELEASE_TAG_SIGNING_KEY`, value the whole private key
     file `field-release-tags`.
   - Your GitHub account Settings → SSH and GPG keys → New SSH key: title
     `Field release tags`, key type **Signing Key**, key the line in
     `field-release-tags.pub`. GitHub then shows each release tag as
     verified, signed by you, and Field Release Checks refuses any tag it
     does not show so.
   - Delete both files from your computer.
   - Then set the repository variable `RELEASE_REQUIRE_SIGNED_TAGS` to
     `true`, so a missing or bad signature stops a release.

   Prepare tags as `IAMSamuelRodda <7961255+IAMSamuelRodda@users.noreply.github.com>`;
   a repository variable `RELEASE_TAGGER` (`Name <email>`) names another
   account that holds the signing key.
3. **The closeout pull request.** Arc Forge's enterprise policy keeps
   **Allow GitHub Actions to create and approve pull requests** off, so
   Field Release Closeout opens its pull request with the Barnacle App token
   (`BARNACLE_APP_ID` variable, `BARNACLE_APP_PRIVATE_KEY` secret), as
   openclaw/openclaw's workflows use an App token. The App needs **Pull
   requests: Read and write** on this repository. Without the token,
   `release:stable` opens the pull request itself.

Later, when Field has many paying clients and becomes a target: sign each
tag with a key that a person holds, as openclaw/openclaw's maintainers do.
This is not for now (decided 20 Oct 2026); the CI key stays until then. A
touch on a hardware security key (FIDO2, for example a YubiKey) is the
control: no tag without a touch.

1. Make the key on the hardware key: `ssh-keygen -t ed25519-sk -O resident
   -O verify-required -C "field release tags"`, and add its `.pub` line to
   your GitHub account as a **Signing Key**.
2. `release:stable` stops before the tag and prints one command. The
   maintainer runs it on their own computer, touches the key, and pushes the
   signed tag: `git tag --sign v<version> <commit> && git push origin
   v<version>`.
3. Field Release Prepare takes the existing tag in place of making one.
   Field Release Checks already refuses a tag that GitHub does not verify.
4. Delete the `RELEASE_TAG_SIGNING_KEY` secret.

Until hardware keys are in use, a key held in the computer's secure chip,
with a fingerprint check on each use, gives the same control (on macOS, for
example, the Secretive app keeps it in the Secure Enclave). Browser and
phone passkeys cannot sign git tags: OpenSSH cannot use them.

npm (an npm owner of the `@arcforgelabs` scope does this on npmjs.com, with
two-factor authentication; never with a token in a file or a command):

1. Trusted publishing cannot create a package. Publish a placeholder once:
   a directory with only a `package.json` that has `"name":
   "@arcforgelabs/field"`, `"version": "0.0.0-placeholder"`, `"license":
   "MIT"` and this repository's URL
   (`git+https://github.com/arcforgelabs/field.git`). Run `npm login`, then
   `npm publish --access public --tag placeholder`, then `npm logout`.
2. On the package's **Settings**, under **Trusted publishing**, add two
   GitHub Actions publishers for organization `arcforgelabs`, repository
   `field`:
   - workflow `field-npm-release.yml`, environment `npm-publish`, allowed to
     publish;
   - workflow `field-release-promote.yml`, environment `npm-release`, with
     **Allow npm dist-tag** on and publishing off.

   npm checks the workflow file of the run's top-level workflow, so these
   names must match the files exactly. Renaming a file breaks publishing
   until its trusted publisher is changed here.
3. Under **Publishing access**, choose **Require two-factor authentication
   and disallow tokens**.

GHCR: the first publish creates the `field` container package as private,
linked to this repository. Before that, check that the organisation has no
`field` container package already
(`https://github.com/orgs/arcforgelabs/packages?repo_name=field`). If one
exists that this repository did not create, empty or remove it first: it
becomes public in the next step. After the first beta, on the package's
page, open **Package settings**, then **Change visibility**, and choose
**Public**. Under **Manage Actions access**, make sure `arcforgelabs/field`
has the **Write** role. Until the package is public, Replit and Docker
installations cannot pull the image anonymously; npm and the Replit channel
deploy do not need it.
