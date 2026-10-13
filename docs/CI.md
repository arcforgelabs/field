# Continuous integration

`.github/workflows/ci.yml` runs one job per lane, so a failed check names what
broke. It runs on every pull request, on every push to `main`, on demand, and
from `release-checks.yml` for the exact commit of a release.

## Required checks

The `main` ruleset (`.github/rulesets/main.json`) requires `test`,
`client-build`, `docker-build`, `gitleaks` (Secret Scan) and `context`
(PR context). The Replit publish (`scripts/deploy-checks.js`) builds only a
commit whose `test`, `client-build`, `docker-build` and `gitleaks` passed.

`test` is the gate. It passes only when every lane below passed. Because of
that gate, a new lane needs no ruleset change: add it to the `needs` list of
`test`. Do not rename `test`, `client-build` or `docker-build`. The ruleset and
the Replit publish check look for those names.

## Lanes

| Check | What it proves | Run it locally |
| --- | --- | --- |
| `unit-server` | Data-layer types, generated migrations match the schema, and the server, scripts and shared tests. Tests that need a real PostgreSQL skip here. | `npm run db:typecheck && npm run db:check:ci && npm test` |
| `unit-client` | Client typecheck and tests | `npm --prefix client run typecheck && npm --prefix client test` |
| `postgres` | Every test file that opens a real PostgreSQL, against a `postgres:16-alpine` service | `FIELD_DB_TEST_DOCKER=1 npm test` (runs every test, with a Docker PostgreSQL) |
| `quote-invoice-proof` | The quote and invoice proof (`README.md`, "Development") gives the same 25 PDFs, emails and API responses on two PGlite runs and on a run with PostgreSQL storage | See below |
| `client-build` | The client bundle builds | `npm --prefix client run build` |
| `docker-build` | The image builds | `docker build .` |
| `smoke` | Playwright signs a synthetic operator in to the built image, on desktop and phone viewports, and opens the jobs board and the catalogue. `/health` must name the commit the image was built from. | `e2e/run-image-smoke.sh <image> [commit]` |
| `audit` | No high or critical advisory outside the accepted list in `SECURITY.md` ("Dependency Advisories"), and none past its recheck date. It also writes CycloneDX SBOMs of the server and client production dependencies (artifact `sbom`). | `node scripts/dependency-audit.mjs` |
| `test` | The gate: every lane above passed | |

To run the quote and invoice proof the way CI does:

```bash
npm run qa:quote-invoice-proof -- . /tmp/proof-a
npm run qa:quote-invoice-proof -- . /tmp/proof-b
PROOF_STORAGE=postgres npm run qa:quote-invoice-proof -- . /tmp/proof-postgres
node scripts/quote-invoice-proof/compare.mjs /tmp/proof-a /tmp/proof-b
node scripts/quote-invoice-proof/compare.mjs /tmp/proof-a /tmp/proof-postgres
```

The PostgreSQL run starts a throwaway container when
`FIELD_DB_TEST_DATABASE_URL` is not set. The smoke needs Docker and
Playwright's Chromium:

```bash
npm --prefix e2e ci
npx --prefix e2e playwright install chromium
docker build -t field:local .
e2e/run-image-smoke.sh field:local
```

All lane data is synthetic: the verification catalogue
(`scripts/verification/fixtures.js`) and fixture operators with
`example.invalid` addresses.

## Documentation-only pull requests

A pull request that changes only files under `docs/` and Markdown files skips
`postgres`, `quote-invoice-proof`, `docker-build` and `smoke`. Nothing in the
server, the client bundle or the image reads those files. The unit lanes, the
client build and the audit still run. A push to `main`, a manual run and a
release check always run every lane, because the Replit publish needs a
passing `test` on each commit it deploys.

## Heavy lanes on Crabbox

The heavy lanes (`postgres`, `quote-invoice-proof`, `smoke`) need Docker and a
few minutes of CPU. They run on GitHub-hosted runners, which cost nothing for a
public repository. To run them away from a workstation, for example to prove a
large change before you push, use Crabbox. Field has no `crabbox.yaml` yet, so
each run names its command:

```bash
crabbox run --preflight --preflight-tools node,docker --shell 'npm ci && FIELD_DB_TEST_DOCKER=1 npm test'
crabbox run --preflight --shell 'npm ci && npm run db:build && PROOF_STORAGE=postgres npm run qa:quote-invoice-proof -- . /tmp/proof-postgres'
crabbox run --fresh-pr arcforgelabs/field#<number> --shell 'docker build -t field:local . && npm --prefix e2e ci && npx --prefix e2e playwright install --with-deps chromium && e2e/run-image-smoke.sh field:local'
```

`crabbox actions hydrate` can also prepare a box from `ci.yml`. Add a
`crabbox.yaml` with these lanes as jobs when they are run this way often.
