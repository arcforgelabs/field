// Barnacle for arcforgelabs/field: close-reason labels post a reply and close the item.
// Upstream shape: each openclaw repository owns its own Barnacle script and
// rules (openclaw/openclaw, openclaw/clawhub scripts/github/). This repository
// keeps only the label rules it uses.

export const rules = [
  {
    "label": "r: not-in-vision",
    "stateReason": "not_planned",
    "message": "Closing this because it doesn't fit Field's vision: https://github.com/arcforgelabs/field/blob/main/VISION.md (see \"Out of scope\" and \"Standing decisions\"). This includes work started before the vision changed.\n\nIf you think it does fit, or the vision should change, comment with the line you think it serves and we'll take another look."
  },
  {
    "label": "r: customer-data",
    "stateReason": "not_planned",
    "message": "Closing this because it contains, or asks for, one installation's customer data, credentials or private configuration. Field's public repository never holds those (SECURITY.md, \"Rules Held Hard\"). If something sensitive was posted, tell a maintainer privately through the Security tab so it can be removed.\n\nIf the underlying problem is about how Field works, open a new issue that describes it with synthetic data."
  }
];

const badBarnacleLabel = "bad-barnacle";

function labelNames(item) {
  return new Set((item?.labels ?? []).map((label) => (typeof label === "string" ? label : label?.name)));
}

// A maintainer, ClawSweeper or another bot adds a close-reason label; Barnacle
// posts that rule's message and closes the item. `bad-barnacle` switches it off.
export async function runBarnacleAutoResponse({ github, context, core }) {
  const { payload } = context;
  if (payload.action !== "labeled") return;
  const item = payload.pull_request ?? payload.issue;
  if (!item || item.state !== "open" || labelNames(item).has(badBarnacleLabel)) return;
  const rule = rules.find((candidate) => candidate.label === payload.label?.name);
  if (!rule) return;

  const { owner, repo } = context.repo;
  const number = item.number;
  await github.rest.issues.createComment({ owner, repo, issue_number: number, body: rule.message });
  if (payload.pull_request) {
    await github.rest.pulls.update({ owner, repo, pull_number: number, state: "closed" });
  } else {
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: number,
      state: "closed",
      state_reason: rule.stateReason ?? "not_planned",
    });
  }
  core.info(`Barnacle closed #${number} for ${rule.label}.`);
}
