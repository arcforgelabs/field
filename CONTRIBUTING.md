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
