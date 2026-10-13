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
  change, run `npm test`, `npm --prefix client test` and `npm run build`. To
  show a change leaves quote and invoice output untouched, run the
  quote/invoice proof described in `README.md` ("Development").
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
CI's gate: it passes only when every test lane passed (`docs/CI.md`). It blocks
force pushes and deletion of `main`. No approving review is required.

The maintainer (the repository admin role) can bypass it for emergencies
only, and only through a pull request: the merge button then offers to merge
before the checks pass. The bypass never allows a direct push, a force push
or deletion of `main`. A bypassed merge still does not reach production
until `main`'s own CI passes on the merged commit (`docs/REPLIT.md`,
"Publishing").

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
