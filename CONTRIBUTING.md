# Contributing

Read `VISION.md` first; `README.md` indexes the rest of the documentation.
Work is tracked in GitHub issues and pull requests.

## Working in this repo

- Code, configuration, tests and the maintained docs indexed in `README.md`
  hold Field's implementation and product truth. A change to product
  behaviour updates the doc that describes it in the same pull request.
- Preserve the customer-facing quote and invoice revision rules unless the
  issue you are delivering explicitly changes that contract. A change to which
  quote or invoice version is selected, sent or invoiced needs a regression
  test.
- Run the smallest relevant tests while you work. Before handing off a broad
  change, run `npm test`, `npm --prefix client run lint`,
  `npm --prefix client test` and `npm run build`. To show a change leaves
  quote and invoice output untouched, run the quote/invoice proof described
  in `README.md` ("Development").
- When one customer's work shows a reusable product opportunity, file it as
  its own feature request instead of widening that customer's scope.
- Never commit customer data, credentials, raw private messages or runtime
  state. `SECURITY.md` holds those rules.

## Issues

| Situation | Use | Required evidence |
| --- | --- | --- |
| Bug, regression, crash, wrong behaviour or wrong docs | Bug report form | Repro steps, expected and actual behaviour, version, environment, redacted logs or screenshots |
| New capability or improvement | Feature request form | Problem, proposed solution, alternatives, impact, whether you will open the PR |
| Security issue | `SECURITY.md` (private report) | Never paste a credential, in full or in part |

Answer every field of the forms in `.github/ISSUE_TEMPLATE/` from observed
evidence. Where the evidence does not answer a field, write exactly
`NOT_ENOUGH_INFO`. File one issue per report, and reuse an open issue rather
than file a duplicate. Without the web form (for example `gh issue create`),
use each field label as a `###` heading in the body.

For non-trivial work, create or reuse the issue first, then open the pull
request against it with a visible `Closes #<issue>` or `Related: #<issue>`.

## Changelog

`CHANGELOG.md` is an index of one file per release in `CHANGELOG/`, with
each release's contribution record again in `CHANGELOG/records/`. The
layout, formats and rules are openclaw/openclaw's split changelog. The
release owns these files:

- A normal pull request never edits `CHANGELOG.md`, `CHANGELOG/` or a
  release page in `docs/releases/`. Put the release-note text in the pull
  request: its title and its User Impact section.
- The release cut writes `CHANGELOG/<version>.md` from the pull requests
  in the release's range, edits the prose, and commits it on the release
  branch `release/<version>` with the version (`docs/RELEASING.md`). It
  never goes through a pull request to `main`: Field Release Closeout brings
  the shipped file to `main` after the stable release. The procedure is
  `.agents/skills/field-changelog-update/SKILL.md`.
- Field Release Prepare refuses a release until its file lists every pull
  request in its range with GitHub's credit, and the GitHub Release takes
  its notes from the file (`docs/RELEASING.md`).
- A stable release covers everything since the previous stable release,
  including the blocker fixes picked onto its branch. A correction
  (`<version>-<n>`) covers the same range plus its fix. A beta covers everything since the release npm's `beta` tag selects before
  the beta publishes, in its own file.
- A release file has Highlights, Changes and Fixes, then a complete
  contribution record that lists every pull request in the range once:
  `- **PR #N** Related #I. Thanks @a and @b.` A prose bullet names its pull
  requests as `(#N, #M)` and keeps every thanks from their rows. `feat`,
  `improve` and `fix` pull requests go in the prose; `docs`, `chore`,
  `refactor`, `test`, `ci`, `build` and `style` go only in the record,
  unless the title marks a breaking change with `!`.
- A stable release has 5 to 8 highlights; a beta has 0 to 8.
- Thanks go to the pull request's author, its co-authors and the people who
  reported the issues it closes (`Closes #N`, `Fixes #N`, `Resolves #N`).
  Never to bots, to Claude or Codex, to the organization or to the
  maintainer.
- `npm test` runs `scripts/release/changelog.mjs check`, which holds the
  format rules; `verify` holds the rules that need git and GitHub.
  `CHANGELOG/Unreleased.md` stays empty.

## Pull requests

Title: `type: user-facing description`, where type is one of `feat`, `fix`,
`improve`, `refactor`, `docs` or `chore`.

Use `.github/pull_request_template.md` and keep the body current. The
`PR context` check (`.github/workflows/pr-context.yml`) fails a body that is
missing authored text under any of these headings:

- **What Problem This Solves**: the concrete problem and when it happens.
- **User Impact**: what someone can now do, or a plain statement that there
  is no user-visible change.
- **Why This Change Was Made**: the shipped solution and any boundary that
  matters.
- **Evidence**: the command, commit, result, and what was not run.
  Screenshots show the real product, with the viewport and whether the data
  was synthetic or live. Placeholder text does not count.

Edit the pull request body when someone asks for more proof; the body stays
the record.

## Merging to main

A repository ruleset on `main` (`.github/rulesets/main.json`) requires a pull
request, and requires the checks `test`, `client-build`, `docker-build`
(CI), `gitleaks` (Secret Scan) and `context` (PR context) to pass on the
pull request's latest commit. GitHub Actions must report them. `test` is
CI's gate: it passes only when every test lane passed (`docs/CI.md`). It also
requires code scanning (CodeQL, the repository's default setup) to have
analysed the pull request, and refuses one that adds a high or critical
security alert. Fix the cause; dismiss an alert only when it is not a defect,
with a one-line reason. It blocks force pushes and deletion of `main`. No
approving review is required.

Organisation admins can bypass it at any time, while Arc Forge's gates are
still being tuned. Use the bypass for emergencies, a private security fix, or
a gate that cannot be satisfied, and say why in the pull request. A bypassed
merge still does not reach production until `main`'s own CI passes on the
merged commit (`docs/REPLIT.md`, "Publishing").

GitHub's security-advisory merge ("Merge commit from fork") merges a
temporary private fork. GitHub runs no checks there and says it does not
enforce the branch's protection rules for that merge. If the ruleset refuses
it, disable the ruleset (repository Settings > Rules > Rulesets, or
`gh api -X PUT repos/arcforgelabs/field/rulesets/<id> -f enforcement=disabled`),
merge the advisory, and enable it again at once (`-f enforcement=active`).
The merged commit then runs CI on `main` like any other.

To change the ruleset, edit `.github/rulesets/main.json` in a pull request,
then apply it:

```bash
gh api -X PUT repos/arcforgelabs/field/rulesets/$(gh api repos/arcforgelabs/field/rulesets --jq '.[] | select(.name == "main: pull request and passing CI") | .id') --input .github/rulesets/main.json
```

<!-- arc-forge-org-consistency:start -->
## Issue, PR, and contact routing

This follows upstream OpenClaw's routing. Start here before you create a GitHub item:

| Situation | Use | Required evidence |
| --- | --- | --- |
| Bug, regression, crash or wrong behaviour | Bug report form | Repro steps, expected and actual behaviour, version, OS, model and provider route when relevant, logs or screenshots, impact |
| Wrong, missing or contradictory docs | Docs bug report form | Docs path or URL, verification steps, expected and actual content, impact, evidence |
| New capability or improvement | Feature request form | Problem, proposed solution, alternatives, impact, examples, whether you will open the PR |
| Security issue | This repo's `SECURITY.md`; without one, the [Arc Forge security policy](https://github.com/arcforgelabs/business/blob/master/SECURITY.md) | Never paste a credential, in full or in part |
| Defect in OpenClaw itself | The upstream repo's own forms and `CONTRIBUTING.md` | What upstream asks for, in its language (American English for OpenClaw) |
| PR for an existing or new issue | `.github/pull_request_template.md` | Visible `Closes #<issue>` or `Related: #<issue>`, then the four sections below |

The forms in `.github/ISSUE_TEMPLATE/` are copies of upstream OpenClaw's. Answer every field from observed evidence. Where the evidence does not answer a field, write exactly `NOT_ENOUGH_INFO`. File one issue per report, and reuse an open issue rather than file a duplicate. Without the web form (for example `gh issue create`), use each field label as a `###` heading in the body.

For agent-authored or non-trivial work, create or reuse the issue first, then open the PR against it. Do not tag people to route work; the forms and labels do that.

## Pull request body

Use `.github/pull_request_template.md` and keep the body current:

- **What Problem This Solves** — the concrete problem and when it happens.
- **User Impact** — what someone can now do, or a plain statement that there is no user-visible change.
- **Why This Change Was Made** — the shipped solution and any boundary that matters.
- **Evidence** — the command, commit, result, and what was not run. Screenshots show the real product. Placeholder text does not count.

Edit the pull request body when someone asks for more proof. A review comment can point at that edit. The body stays the record. Maintainer authorship does not remove this requirement.
<!-- arc-forge-org-consistency:end -->
