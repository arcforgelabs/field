---
name: github-sync
description: Push work to GitHub, open a pull request, or pull the default branch from GitHub for this project. Also explains how to create the GITHUB_TOKEN secret. Use whenever the user says push, PR, pull request, sync to GitHub, pull master/main, get this into the repo, asks whether the workspace matches GitHub, or asks how to give you GitHub push access.
---

# GitHub sync

This skill is account-wide and repo-agnostic. Before anything else, work out:

- `<remote>`: the remote whose URL is on github.com (`git remote -v | grep github.com`)
- `<owner>/<repo>`: from that URL (this repo is `embarkearthworks/field`)
- `<default>`: the default branch, `git remote show <remote> | sed -n 's/.*HEAD branch: //p'`
  (`master` or `main`; never assume)

GitHub `<default>` is the source of truth. The Replit workspace is a clone of it and
publishes from its own files, so keep the two identical.

## Facts you must not re-discover

- Find the GitHub remote by URL (`git remote -v | grep github.com`), usually
  `origin`, and use it as `<remote>`. The Replit Git pane may name it
  `subrepl-*`; a `subrepl-*` remote whose URL is not on github.com is a Replit
  task sandbox, not GitHub. Do not add a second GitHub remote.
- `<default>` is usually PR-only on GitHub (branch rulesets): a direct push is rejected with
  PUSH_REJECTED even with valid credentials. Always branch and open a PR.
- Your shell has **no GitHub credentials by default**. The GitHub connector
  only gives API access (`proxyFetch`), never a token, so plain `git push`
  fails with "Invalid username or token". The Replit Git tool authenticates
  with the human's browser session, which you cannot use. Pulling a public
  repository needs no token: `scripts/github-sync.sh pull` works without one.
- **Never** create commits on GitHub through the REST API (blobs/trees/commits).
  That produces commits whose hashes differ from the local ones and splits the
  history; it took a manual merge to repair last time.
- `<default>` must only move by fast-forward. Never rebase, amend, or force-push it.
- Replit auto-commits ("Published your App", checkpoints) land on the current
  branch. Do feature work on a branch so `<default>` stays fast-forwardable.
- Never print, echo, log, or commit the token value.

## Decide which path

Run `scripts/github-sync.sh status` if the repo has it. Otherwise check
`[ -n "$GITHUB_TOKEN" ]` and `git ls-remote <remote> <default>`, using the token
through a credential helper rather than putting it in the URL.
This repo ships `scripts/github-sync.sh` and `scripts/git-credential-github.sh`.

- Token works → you can push and pull yourself (Path A).
- No `GITHUB_TOKEN` → you can still pull a public repository. Prepare the
  work and hand off the push (Path B), and walk the user through **Setting up
  GITHUB_TOKEN**.
- Token set but rejected → see the checks at the end of **Setting up GITHUB_TOKEN**.

## Path A — do it yourself (GITHUB_TOKEN secret present)

1. Start from current `<default>`: `git checkout <default> && scripts/github-sync.sh pull`
2. Branch: `git checkout -b <type>/<short-slug>` (feat/, fix/, chore/)
3. Make the change, run the relevant checks/tests, commit with a clear message.
4. Open the PR: `scripts/github-sync.sh open-pr "<title>"` — this pushes the
   branch and prints the PR URL. Report the URL to the user.
5. When the user says it is merged: `git checkout <default> && scripts/github-sync.sh pull`,
   then delete the branch locally.
6. "Sync master/main" / "pull from GitHub" alone = step 5 only.

## Path B — hand off (no token)

1. Do steps 1–3 of Path A. The pull works without a token for a public
   repository; if it fails to fetch, warn that `<default>` may be behind
   GitHub.
2. Run `scripts/github-sync.sh handoff` and paste its output verbatim in your
   reply. It contains the branch name, HEAD sha, and the exact clicks a human
   or supervising agent needs in the Replit Git tool
   (Push branch as `<remote>/<branch>` → open PR → after merge, Pull on `<default>`).
3. Tell the user the permanent fix is a `GITHUB_TOKEN` secret and walk them
   through the next section.

## Setting up GITHUB_TOKEN (walk the human through this)

The human does every step; you never see, print, or store the token value.

1. Open **https://github.com/settings/personal-access-tokens/new**
   (GitHub → avatar → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token).
2. **Token name:** `replit-<repo>`. **Expiration:** 90 days.
3. **Resource owner:** switch from the personal account to `<owner>`
   (**embarkearthworks** for this repo).
   If this is skipped, the repo will not appear in the list.
4. **Repository access:** *Only select repositories* → `<repo>`.
5. **Repository permissions:**
   - *Contents:* Read and write (push)
   - *Pull requests:* Read and write (open PRs)
   - *Workflows:* Read and write — only if you will edit `.github/workflows/`
   - *Metadata:* Read-only is added automatically
6. **Generate token** and copy it — GitHub shows it only once.
7. In Replit: **Tools → Secrets → New Secret**, key `GITHUB_TOKEN`, paste the
   value. Tell the user not to paste it into the Agent chat.
8. If the org requires approval the token shows as pending; an org owner
   approves it at `https://github.com/organizations/<owner>/settings/personal-access-token-requests`
   (an owner of the `<owner>` organisation)
9. Verify: `scripts/github-sync.sh status` → `auth: GITHUB_TOKEN works`.

If the token is rejected, check in this order: expired (make a new one and
replace the secret), still pending org approval, resource owner was the
personal account, or the repo is not in its repository list. One token can
cover several repos: edit its repository list on GitHub (takes effect
immediately) and add the same secret to each Replit project.

## After any pull

Reinstall dependencies if a lockfile changed, then run the repo's own checks.
Find the commands in `docs/REPLIT.md`, then `AGENTS.md` / `README.md`, then the
package manifests (`package.json` scripts, `pyproject.toml`, `Makefile`). If a
repo has no documented check, say so rather than guessing.

Publishing deploys the workspace files, not GitHub, so the workspace must
contain the merged commit before you publish.
