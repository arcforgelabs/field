# Surveyor

Surveyor is Field's before/after verification system for bugs that need a real
runtime and visible proof. It runs a scenario against a known-bad ref, captures
evidence, runs the same scenario against a candidate ref, and writes a comparison
a human can read and a machine can publish.


## The oracle

**Verified means the baseline failed and the candidate passed.** A candidate that
passes on its own proves nothing: it may never have exercised the reported path.

A run has exactly four honest outcomes:

| Outcome | Meaning | Exit |
| --- | --- | --- |
| `verified` | baseline reproduced the bug, candidate fixed it | 0 |
| `not_verified` | both lanes ran a real oracle, pattern not observed | 1 |
| `harness_failure` | setup, deps, build, ports or credentials broke before the oracle mattered — **no verdict on the candidate** | 2 |
| `smoke_pass` / `smoke_fail` | one-lane harness check; proves the lane works, not a fix | 0 / 1 |

The distinction between `not_verified` and `harness_failure` is the single most
important property here. A flaky environment must never read as a product verdict.

## Commands

```bash
# what can I run
npm run qa:surveyor -- list

# prove a fix: baseline must fail, candidate must pass
npm run qa:surveyor -- run \
  --scenario server-boot-smoke \
  --baseline <bug-ref> \
  --candidate HEAD

# check the harness itself, one lane only
npm run qa:surveyor:smoke
```

Output lands in `.artifacts/surveyor/<scenario>-<timestamp>/`:

```text
surveyor-report.md        human-readable; safe to paste into a PR or issue comment
surveyor-summary.json     machine-readable source of truth
surveyor-evidence.json    publish manifest (schemaVersion 1)
comparison.json           the oracle result
run.log                   phase markers and lane output
baseline/checkout/        detached worktree for the baseline ref
candidate/checkout/       detached worktree for the candidate ref
```

## How a run works

1. Resolve baseline and candidate refs to SHAs.
2. Create a **detached worktree per lane** under the output directory. Never
   `git checkout` in the working tree — sync and dirty state mix proof across
   lanes, which is an upstream lesson we did not have to learn the hard way.
3. Install dependencies and build only what the scenario needs, per lane.
4. Run the scenario with an isolated data root, an isolated port, and a generated
   throwaway auth token.
5. Capture the oracle result and any artifacts.
6. Compare, write the summary, evidence manifest, report and log.
7. Remove the lane worktrees unless `--keep-worktrees`.

Every stage prints `SURVEYOR_PHASE:<stage>:<lane>` into `run.log`, so a failure
names the stage instead of "the run failed".

## Writing a scenario

A scenario declares its whole contract. `validateScenario()` rejects a partial
one, because a scenario that does not state its oracle cannot produce trustworthy
proof.

```js
export const quoteTotalRegression = {
  id: "quote-total-regression",
  title: "Quote total excludes hidden-amount nodes",
  transport: "http",                 // http | browser
  requiredCredentials: [],           // names only, never values
  baselineExpectation: "total includes the hidden node",
  candidateExpectation: "total excludes the hidden node",
  visualCaptureTargets: [],
  timeoutMs: 120_000,
  async run({ checkoutPath, laneDir, lane, log }) {
    // ... set up, stimulate, read the oracle
    return { status: "pass" | "fail" | "error", oracle: { ... }, notes: [] };
  },
};
```

Rules:

- **`error` is for the harness, `fail` is for the product.** A failed `npm
  install`, an occupied port or a missing config returns `error`. Only a real
  observation of wrong behaviour returns `fail`.
- **Prefer a typed oracle over a screenshot.** If an API response can prove the
  bug, that is the pass/fail signal; screenshots are for human confidence.
- **Isolate state.** Own data root, own port, own token. Never the operator's
  config or a real client dataset.
- **A Surveyor run should become a regression test** once the fix is understood.
  The scenario is scaffolding for diagnosis, not a permanent substitute for a
  cheap test.

## Machines

Today Surveyor runs `local` only. `--provider libvirt|container|ssh` **fails
closed** rather than running locally while reporting a remote machine. Anything
that executes steps supplied by a bug reporter belongs in an isolated VM.

## Evidence is customer data

Field screenshots and API payloads can contain client names, addresses, job sites
and prices. Treat every artifact as customer data:

- never commit `.artifacts/`
- never attach raw evidence to a public issue
- report credential presence and length, never values
- prefer a link to a local artifact directory over an inline image when the
  audience is not the operator

## What is not built yet

Remote lanes, visual artifacts, motion previews, artifact hosting and a PR or
issue comment publisher are deliberately deferred.
