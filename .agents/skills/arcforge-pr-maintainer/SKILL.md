---
name: arcforge-pr-maintainer
description: "Arc Forge issues and pull requests in upstream OpenClaw's shape: issue forms, routing, PR sections and evidence."
---

# Arc Forge pull request maintainer

Use this for Arc Forge issue and pull request work. The source of this skill is `arc-forge-tools`. A repo `AGENTS.md` rule that asks for more proof wins over this skill.

## Issues

Pick the route from the table in `CONTRIBUTING.md`. File through the forms in `.github/ISSUE_TEMPLATE/`; they copy upstream OpenClaw's. With `gh issue create`, use each form field label as a `###` heading and fill the required fields.

- Answer from observed evidence only. Where the evidence does not answer a field, write exactly `NOT_ENOUGH_INFO`. Do not guess a cause.
- One issue per report. Search open issues first and add new evidence to a matching one instead of filing a duplicate.
- Agent-authored or non-trivial work starts from an issue. Its pull request links it with `Closes #<n>` or `Related: #<n>`.
- Security issues follow the security policy linked in `CONTRIBUTING.md`. Never paste a credential.
- A defect in OpenClaw itself goes upstream through upstream's own forms, `CONTRIBUTING.md` and language. Our forms match theirs, so the fields carry over.

## Pull request body

Create or update the body from `.github/pull_request_template.md`. These four sections need authored text:

- What Problem This Solves
- User Impact
- Why This Change Was Made
- Evidence

HTML comments and placeholders such as `tbd`, `n/a`, and `not tested` do not count. Maintainer authorship does not skip the sections.

When a review asks for more proof, edit the body. A short comment may point at the edit. The body stays the record.

## Evidence

Write the command, the commit, the result, and what was not run. For a screen, use the real product, name the viewport, and say whether the data was synthetic or live.

A passing test is evidence about this source. Production activation, customer cutover, and live revocation are a separate record. Do not treat that unfinished work as a reason to hide a source defect, and do not treat a source test as that activation record.

If the proof could not be run, say exactly what is missing and why. The closest real command still goes in Evidence.

## Changelog

A pull request never edits `CHANGELOG.md` or `CHANGELOG/`. The release cut writes the file. Put release-note text in the PR title and User Impact.

## Before merge

Read the diff, the linked issue, and the check named `PR context`. Do not merge a bug fix on the pull request text alone. A green `PR context` check means the four sections have text. It does not judge whether the fix is right.
