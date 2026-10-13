# Releasing Field

A release is one tagged commit on `main`, built once and published three
ways: an npm package, a container image, and a GitHub Release that records
both. An installation runs a release it chose, by version and fingerprint,
never a branch.

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

The notes are generated from the pull requests merged since the last release.

## Versions and channels

Versions are calendar versions with no leading zeros: `2026.10.14`. A beta is
a pre-release of one: `2026.10.14-beta.1`. Tags add a `v`. `package.json` holds
the stable form of the version being released. `scripts/release/release.mjs`
holds the rules, and `scripts/release/release.test.js` tests them.

| Channel | npm dist-tag | Image tags | GitHub Release |
| --- | --- | --- | --- |
| beta | `beta` | `<version>`, `beta` | pre-release |
| stable, published | `next` | `<version>` | release, not marked latest |
| stable, promoted | `latest` | `<version>`, `stable`, `latest` | latest release |

A beta reaches the beta channel when it is published. A stable release
reaches operators by default only when it is promoted, after it is verified.
Promotion also moves `beta` up when beta is behind stable, so beta users are
never behind stable.

## The workflows

| Workflow | Starts | Does |
| --- | --- | --- |
| `release-prepare.yml` | By hand, from `main` | Takes a `main` commit (default: the head) whose required checks passed, by the rule a Replit publish uses (`scripts/deploy-checks.js`). Plans the next tag for the channel, creates it, and starts `release-publish.yml`. |
| `release-checks.yml` | From `release-publish.yml`, or by hand to rehearse | Requires the tag to be a calendar version on `main` that matches `package.json`. Runs every CI lane on its commit (`docs/CI.md`). Packs the npm tarball with a shrinkwrap of the tested dependencies, then installs it in an empty directory and starts it. Publishes nothing. |
| `release-publish.yml` | From `release-prepare.yml`, or by hand for an existing tag | `npm` job (environment `npm-publish`): publishes the exact tarball the checks proved. `image` job (environment `release`): pushes the image, attests it and its SBOM, verifies the attestation, and runs the Playwright smoke against the pushed digest. Then it creates the GitHub Release and attaches the post-publish evidence. |
| `release-promote.yml` | By hand, from `main` | Verifies a published stable release (the manifest's checksum, the npm integrity, signatures and provenance, and the image attestation), then in environment `npm-release` moves npm `latest`, GHCR `stable` and `latest`, and GitHub's latest release. |

Each protected environment needs Samuel's approval and accepts only runs from
`main`. Release tags (`v20*`) cannot be moved or deleted
(`.github/rulesets/release-tags.json`).

Running `release-publish.yml` again for the same tag is safe. It checks again,
skips an npm version that is already published with the same bytes, refuses
one published with different bytes, and updates the GitHub Release's assets.
A published version is never replaced: fix forward with a new tag.

## Cut a release

1. Open a pull request that sets the version: `npm version 2026.10.14
   --no-git-tag-version`, which updates `package.json` and
   `package-lock.json`. Title it `chore: release 2026.10.14`. Merge it when
   CI passes. Do this once per version; betas reuse it.
2. Start a beta:

   ```bash
   gh workflow run release-prepare.yml --repo arcforgelabs/field --ref main -f channel=beta
   ```

3. When `release-checks` passes, approve `npm-publish` and `release` in the
   Release publish run. The beta is then on npm `beta`, GHCR `beta` and a
   GitHub pre-release.
4. Run the beta where it matters. To take a stable release from the same
   commit, give that commit:

   ```bash
   gh workflow run release-prepare.yml --repo arcforgelabs/field --ref main -f channel=stable -f commit=<commit>
   ```

   Approve it as in step 3.
5. Promote it, and approve `npm-release`:

   ```bash
   gh workflow run release-promote.yml --repo arcforgelabs/field --ref main -f tag=v2026.10.14
   ```

To roll back, promote the previous stable tag. Nothing is unpublished.

## Run a release

`docs/SELF_HOSTING.md` describes how to pin, verify and run a release with
Docker, with Node, or on Replit (`deploy/replit/`).

## One-time setup

GitHub (done with `gh`; each item can be undone in the repository settings):

- Environments `npm-publish`, `release` and `npm-release`: required reviewer
  Samuel, deployments from `main` only.
- The release tag ruleset, from `.github/rulesets/release-tags.json`.

npm (an npm owner of the `@arcforgelabs` scope does this on npmjs.com, with
two-factor authentication; never with a token in a file or a command):

1. Trusted publishing cannot create a package. Publish a placeholder once:
   a directory with only a `package.json` that has `"name":
   "@arcforgelabs/field"`, `"version": "0.0.0-placeholder"`, `"license":
   "MIT"` and this repository's URL. Run `npm login`, then
   `npm publish --access public --tag placeholder`, then `npm logout`.
2. On the package's **Settings**, under **Trusted publishing**, add two
   GitHub Actions publishers for organization `arcforgelabs`, repository
   `field`:
   - workflow `release-publish.yml`, environment `npm-publish`;
   - workflow `release-promote.yml`, environment `npm-release`, with
     **Allow npm dist-tag** on.
3. Under **Publishing access**, choose **Require two-factor authentication
   and disallow tokens**.

GHCR: the first publish creates the `field` container package as private. On
the package's page, open **Package settings**, then **Change visibility**, and
choose **Public**. Under **Manage Actions access**, make sure
`arcforgelabs/field` has the **Write** role.
