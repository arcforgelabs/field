# Self-hosting Field

Run a published Field release, not a branch of this repository. Each
installation pins one release by version and fingerprint, checks it before it
runs, and upgrades by changing the pin. `docs/RELEASING.md` describes what a
release publishes and how it is made.

Every installation needs the same things, whatever runs it:

- **PostgreSQL**: `DATABASE_URL`, with `FIELD_STORAGE=postgres` so job files
  are stored durably and rebuilt into the data directory at boot.
- **Configuration**: `FIELD_CONFIG_JSON` (the whole config as one secret
  JSON value, shaped like `config.json.example`), or a `config.json` named by
  `FIELD_CONFIG`. `docs/REPLIT.md` ("Configuration") lists what goes in it.
- **A data directory**: `FIELD_DATA`, writable.
- **A price catalogue** with at least one active item. Field refuses to start
  without one (`README.md`, "Getting started").

Keep every secret in your platform's secret store. Never put one in a file in
a repository, including your own deploy repository.

## Pin a release

Each release's `release-manifest.json` (on its GitHub Release) records its
npm integrity, its image digest and its commit. `deploy/replit/verify-release.mjs`
turns one release into a lock file:

```bash
node deploy/replit/verify-release.mjs pin 2026.10.14
```

It downloads that release's manifest, checks the manifest against its
`.sha256`, checks that npm serves the same integrity, and writes `field.lock`
(see `deploy/replit/field.lock.example`). Commit `field.lock` to your deploy
repository. To upgrade, pin a newer version. To roll back, pin the earlier
one.

## Docker

Run the image by the digest in `field.lock`, after you verify GitHub's
attestation for that digest:

```bash
gh attestation verify oci://ghcr.io/arcforgelabs/field@sha256:<digest> --repo arcforgelabs/field
docker run -d -p 19200:19200 -v field-data:/app/data \
  -e DATABASE_URL -e FIELD_CONFIG_JSON -e FIELD_STORAGE=postgres \
  ghcr.io/arcforgelabs/field@sha256:<digest>
```

The image listens on 19200 as an unprivileged user and keeps its data
directory at `/app/data`. `GET /health` names the commit it was built from.

## Node

Install the exact version on Node 24. The package's shrinkwrap pins every
dependency to the tree CI tested. Then check its signatures and provenance:

```bash
mkdir field && cd field
npm init -y
npm install --omit=dev --save-exact @arcforgelabs/field@2026.10.14
npm audit signatures
```

`npm audit signatures` checks the registry signature and the provenance
attestation cryptographically. To check what the provenance claims (the
commit, this repository and its release workflow) against your `field.lock`,
copy `deploy/replit/verify-release.mjs` from this repository next to your
`field.lock` and run `node verify-release.mjs verify <install-dir>`. Use your
own copy, not one from the installed package: a package must not vouch for
itself.

Start it with the `field-server` command, with the environment above:

```bash
FIELD_DATA=/var/lib/field FIELD_STORAGE=postgres npx field-server
```

Run it under a supervisor (systemd, for example) that restarts it. Field
sends scheduled emails in-process, so it must stay up.

## Replit

`deploy/replit/` is a template for a Replit deployment that runs a pinned
release:

| File | Does |
| --- | --- |
| `.replit` | A Reserved VM deployment. Its build runs `install-and-verify.sh`; it runs `start.sh`. |
| `install-and-verify.sh` | Installs `@arcforgelabs/field` at exactly `field.lock`'s version, runs `npm audit signatures`, then `verify-release.mjs verify`. Any failure fails the build, and Replit keeps the previous deployment. |
| `start.sh` | Starts the installed release with `FIELD_STORAGE=postgres`, the data directory, and the release's commit as `FIELD_REVISION`. |
| `verify-release.mjs` | Writes `field.lock` (`pin`) and checks an install against it (`verify`). No dependencies. |
| `field.lock.example` | The shape of `field.lock`. |
| `.npmrc` | Lets npm install through Replit's package firewall. |

To use it:

1. Create your own **private** repository and copy the contents of
   `deploy/replit/` into its root. Your deploy repository holds your pin and
   your Replit settings; this public repository never does.
2. Pin a release: `node verify-release.mjs pin <version>`, and commit
   `field.lock`.
3. Import the repository into Replit. Add a PostgreSQL database, which sets
   `DATABASE_URL`. Add the Secrets from `docs/REPLIT.md` ("Configuration").
   Set `FIELD_AUTH` and anything else your installation needs in `.replit`'s
   `[userenv]` or as Secrets.
4. Publish. The build log shows `Verified @arcforgelabs/field@<version>` and
   the commit, or `REFUSED:` with the reason.

To upgrade, open a pull request in your deploy repository that changes
`field.lock` (`pin <newer version>`), merge it, and publish again. Before you
upgrade, read the release's notes and the migrations in its manifest.
`docs/REPLIT.md` covers the rest of running Field on Replit: durable storage,
issued documents in R2, sign-in, Sentry and data migrations.
