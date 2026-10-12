#!/bin/sh
# Git credential helper: supplies the GITHUB_TOKEN Replit secret for github.com.
#
# Configure once per workspace (idempotent; scripts/github-sync.sh does this):
#   git config credential.helper "$PWD/scripts/git-credential-github.sh"
#
# Git calls this with "get" on stdin describing the host. We answer only for
# github.com and only when GITHUB_TOKEN is set; otherwise we print nothing and
# git falls through to its other helpers / prompts.
[ "$1" = "get" ] || exit 0
[ -n "$GITHUB_TOKEN" ] || exit 0

host=""
while IFS='=' read -r key value; do
  [ "$key" = "host" ] && host="$value"
done

[ "$host" = "github.com" ] || exit 0
printf 'username=x-access-token\npassword=%s\n' "$GITHUB_TOKEN"
