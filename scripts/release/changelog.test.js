import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  baseTag,
  checkChangelog,
  checkReleaseBody,
  checkSection,
  compareVersions,
  creditFor,
  highlightCountError,
  isEligibleHandle,
  main,
  parseSubject,
  provenance,
  pullRequestsIn,
  recordRow,
  releaseNotes,
  renderIndex,
  renderRecordFile,
  renderDocsPage,
  renderSection,
  renderThanksBody,
  verificationTail,
} from "./changelog.mjs";

const root = join(import.meta.dirname, "../..");
const A = "a".repeat(40);
const B = "b".repeat(40);

function section(version, { highlights = [], changes = [], fixes = [], rows = [] } = {}) {
  const lines = [`## ${version}`, "", "### Highlights", "", ...highlights, "", "### Changes", "", ...changes, "", "### Fixes", "", ...fixes, ""];
  lines.push("### Complete contribution record", "", provenance({ base: A, target: B, total: rows.length }), "", "#### Pull requests", "", ...rows, "");
  return lines.join("\n");
}

// A stand-in for `gh api`: pull requests, their commits and issues.
function fakeGithub({ pulls = {}, issues = {}, releases = {} }) {
  return (path) => {
    let match = /pulls\/(\d+)\/commits/.exec(path);
    if (match) return pulls[match[1]]?.commits ?? [];
    match = /pulls\/(\d+)$/.exec(path);
    if (match) return pulls[match[1]] ? { user: { login: "IAMSamuelRodda", type: "User" }, body: "", ...pulls[match[1]] } : null;
    match = /issues\/(\d+)$/.exec(path);
    if (match) return issues[match[1]] ?? (pulls[match[1]] ? { pull_request: {} } : null);
    match = /releases\/tags\/(.+)$/.exec(path);
    if (match) return releases[match[1]] ?? null;
    throw new Error(`unexpected ${path}`);
  };
}

test("the repository's changelog follows the rules", () => {
  const { versions } = checkChangelog(root);
  assert.ok(versions.includes("2026.10.22"));
});

test("a squash subject gives the pull request, its type and its section", () => {
  assert.deepEqual(parseSubject("fix(xero): match jobs once invoices are copied (#99)"), {
    number: 99, title: "fix(xero): match jobs once invoices are copied", type: "fix", scope: "xero", breaking: false,
    description: "match jobs once invoices are copied", editorial: true, section: "Fixes",
  });
  assert.equal(parseSubject("improve: settings rows (#80)").section, "Changes");
  for (const internal of ["docs: how to release (#23)", "chore: release 2026.10.19 (#41)", "refactor: split the port (#9)", "test: cover sends (#8)"]) {
    assert.equal(parseSubject(internal).editorial, false, internal);
  }
  assert.equal(parseSubject("chore!: drop Node 22 (#7)").editorial, true);
  assert.equal(parseSubject("chore: start Field with a new history").number, null);
});

test("direct commits get no row, and a pull request reverted in the range drops out", () => {
  const prs = pullRequestsIn([
    { sha: "a", subject: "chore: start Field with a new history" },
    { sha: "b", subject: "feat: job board (#10)" },
    { sha: "c", subject: "fix: sign-in loop (#11)" },
    { sha: "d", subject: 'Revert "fix: sign-in loop (#11)" (#12)' },
    { sha: "e", subject: "chore(release): 2026.10.40" },
  ]);
  assert.deepEqual(prs.map((pr) => pr.number), [10]);
});

test("versions sort newest first, and the index links each file and its raw copy", () => {
  const sorted = ["2026.10.9", "2026.10.32-beta.1", "2026.10.32-1", "2026.10.32", "2026.10.31", "2026.11.1", "2026.10.32-2"].sort((a, b) => compareVersions(b, a));
  assert.deepEqual(sorted, ["2026.11.1", "2026.10.32-2", "2026.10.32-1", "2026.10.32", "2026.10.32-beta.1", "2026.10.31", "2026.10.9"]);
  assert.match(renderIndex(["2026.10.9", "2026.10.31"]), /- \[Unreleased\]\(CHANGELOG\/Unreleased\.md\) · \[Raw\]\(https:\/\/github\.com\/arcforgelabs\/field\/raw\/refs\/heads\/main\/CHANGELOG\/Unreleased\.md\)\n- \[2026\.10\.31\]/);
});

test("a stable release starts from the previous stable release, a correction from where its stable release started", () => {
  const tags = ["v2026.10.30", "v2026.10.31", "v2026.10.31-1", "v2026.10.32-beta.1", "v2026.10.32-beta.2", "v2026.10.33", "not-a-tag"];
  assert.equal(baseTag({ version: "2026.10.32", tags }), "v2026.10.31-1");
  assert.equal(baseTag({ version: "2026.10.32-beta.3", tags }), "v2026.10.32-beta.2");
  assert.equal(baseTag({ version: "2026.10.31-2", tags }), "v2026.10.30");
  assert.equal(baseTag({ version: "2026.10.30", tags }), null);
});

test("credit is OpenClaw's: closed issues as Related, thanks to people, never to bots or excluded handles", () => {
  const github = fakeGithub({
    pulls: {
      10: {
        user: { login: "ada", type: "User" },
        body: "Closes #5. Fixes arcforgelabs/tools#6. Related: #7. Resolves #11.",
        commits: [
          { author: { login: "ada", type: "User" }, commit: { message: "feat: x\n\nCo-authored-by: Grace <123+grace@users.noreply.github.com>\nCo-authored-by: Claude <noreply@anthropic.com>" } },
          { author: { login: "dependabot[bot]", type: "Bot" }, commit: { message: "chore: bump" } },
        ],
      },
      11: {},
    },
    issues: { 5: { user: { login: "linus", type: "User" } }, 7: { user: { login: "ken", type: "User" } } },
  });
  assert.deepEqual(creditFor(github, 10), { related: [5], thanks: ["ada", "grace", "linus"] });
  assert.deepEqual(creditFor(github, 11), { related: [], thanks: [] });
  assert.equal(recordRow(10, creditFor(github, 10)), "- **PR #10** Related #5. Thanks @ada and @grace and @linus.");
  for (const handle of ["IAMSamuelRodda", "claude", "codex", "arcforgelabs", "github-actions", "renovate[bot]", "app/x"]) assert.equal(isEligibleHandle(handle), false, handle);
});

test("a drafted section is OpenClaw's format and passes the check", () => {
  const prs = pullRequestsIn([
    { sha: "a", subject: "feat: job board (#10)" },
    { sha: "b", subject: "fix: sign-in loop (#11)" },
    { sha: "c", subject: "docs: how to release (#12)" },
  ]);
  const credits = new Map([[10, { related: [5], thanks: ["ada"] }]]);
  const text = renderSection({ version: "2026.10.40", base: A, target: B, prs, credits });
  assert.match(text, /### Changes\n\n- Job board\. \(#10\) Thanks @ada\./);
  assert.match(text, /### Fixes\n\n- Sign-in loop\. \(#11\)\n/);
  assert.match(text, /covers the complete a{40}\.\.b{40} history: 3 in-range PRs \+ 0 retained seed-only PRs = 3 unique PRs\./);
  assert.match(text, /#### Pull requests\n\n- \*\*PR #10\*\* Related #5\. Thanks @ada\.\n- \*\*PR #11\*\*\n- \*\*PR #12\*\*\n$/);
  assert.equal(checkSection("2026.10.40.md", text).rows.size, 3);
  assert.equal(renderRecordFile("2026.10.40", text), `## 2026.10.40\n\n${text.slice(text.indexOf("### Complete"))}`);
});

test("the check refuses a section that breaks the format rules", () => {
  const rows = ["- **PR #10** Thanks @ada.", "- **PR #12**"];
  const ok = { highlights: ["- Job board. (#10) Thanks @ada."], changes: ["- Job board. (#10) Thanks @ada."], rows };
  assert.equal(checkSection("2026.10.40.md", section("2026.10.40", ok)).rows.size, 2);
  const refused = [
    [{ ...ok, changes: ["- Job board. (#10)"] }, /keeps its credit @ada/],
    [{ ...ok, changes: ["- Job board. (#10) Thanks @IAMSamuelRodda and @ada."] }, /never thank @IAMSamuelRodda/],
    [{ ...ok, changes: ["- Job board. (#10) Thanks @ada and @claude."] }, /never thank @claude/],
    [{ ...ok, rows: [...rows, "- **PR #10**"] }, /in the record twice/],
    [{ ...ok, rows: [...rows, "- **PR #13** feat: a title"] }, /a record row is/],
  ];
  for (const [parts, reason] of refused) assert.throws(() => checkSection("2026.10.40.md", section("2026.10.40", parts)), reason);
  assert.throws(() => checkSection("2026.10.40.md", section("2026.10.41", ok)), /first line must be "## 2026.10.40"/);
  assert.throws(() => checkSection("2026.10.40.md", section("2026.10.40", ok).replace("= 2 unique", "= 3 unique")), /sum must match its 2 rows/);
  assert.throws(() => checkSection("2026.10.40.md", section("2026.10.40", ok).replace("#### Pull requests", "#### Rows")), /rows follow/);
  assert.throws(() => checkSection("2026.10.40.md", section("2026.10.40", ok).replace("### Highlights", "### Notes")), /is not one of/);
  assert.throws(() => checkSection("Unreleased.md", section("Unreleased", ok)), /Unreleased has no record/);
});

test("the highlight budget is 1-8 for a stable release and 0-8 for a beta", () => {
  const five = Array.from({ length: 5 }, (_, i) => `- Story ${i}. (#10)`);
  assert.equal(highlightCountError("2026.10.40", section("2026.10.40", { highlights: five })), null);
  assert.equal(highlightCountError("2026.10.40", section("2026.10.40", { highlights: five.slice(4) })), null);
  assert.match(highlightCountError("2026.10.40", section("2026.10.40", { highlights: [] })), /1-8 top-level bullets; found 0/);
  assert.match(highlightCountError("2026.10.40", section("2026.10.40", { highlights: [...five, ...five] })), /found 10/);
  assert.equal(highlightCountError("2026.10.40-beta.1", section("2026.10.40-beta.1")), null);
});

test("release notes keep the whole section, or the prose and a link to the record file, and the published body must match", () => {
  const short = section("2026.10.40", { highlights: ["- Job board. (#10)"], rows: ["- **PR #10**"] });
  assert.equal(releaseNotes(short, "2026.10.40"), short);
  const long = short.replace("- **PR #10**", Array.from({ length: 9000 }, (_, i) => `- **PR #${i + 1}**`).join("\n").repeat(2));
  const notes = releaseNotes(long, "2026.10.40");
  assert.ok(notes.length < 2000);
  assert.match(notes, /blob\/v2026\.10\.40\/CHANGELOG\/records\/2026\.10\.40\.md/);
  assert.equal(checkReleaseBody(short.replace(/\n/g, "\r\n"), short), null);
  assert.equal(checkReleaseBody(`${short}\n### Release verification\n\nrun 1\n`, short), null);
  assert.match(checkReleaseBody(`${short}\nmore`, short), /not the changelog section/);
});

test("draft, write and verify work from a git history and GitHub", () => {
  const dir = mkdtempSync(join(tmpdir(), "field-changelog-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  const commit = (subject) => run("commit", "-q", "--allow-empty", "-m", subject);
  commit("chore: start (#1)");
  run("tag", "v2026.10.1");
  commit("feat: job board (#2)");
  commit("fix: sign-in loop (#3)");
  commit("chore: direct commit");
  commit("chore: release 2026.10.2 (#4)");
  run("tag", "v2026.10.2");
  mkdirSync(join(dir, "CHANGELOG"));
  writeFileSync(join(dir, "CHANGELOG", "Unreleased.md"), "## Unreleased\n");
  const request = fakeGithub({
    pulls: { 2: { user: { login: "ada", type: "User" }, body: "Closes #9" }, 3: {}, 4: {} },
    issues: { 9: { user: { login: "IAMSamuelRodda", type: "User" } }, 20: { user: { login: "ken" } } },
    releases: {},
  });
  const sha = (ref) => run("rev-parse", ref).trim();

  const manifest = join(dir, "manifest.json");
  const draft = main(["draft", "--version", "2026.10.2", "--target", "v2026.10.2", "--manifest", manifest], dir, { request });
  assert.ok(draft.includes(`${sha("v2026.10.1")}..${sha("v2026.10.2")} history: 3 in-range PRs`));
  assert.match(draft, /- \*\*PR #2\*\* Related #9\. Thanks @ada\.\n/);
  assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")).directCommits.map((c) => c.subject), ["chore: direct commit"]);

  // Five highlights, one story each, as a stable release needs.
  const stories = ["Job board. (#2) Thanks @ada.", "Sign-in loop. (#3)", "Board filters. (#2) Thanks @ada.", "Board cards. (#2) Thanks @ada.", "Fixes the loop in #20. (#3)"];
  const edited = draft.replace(/### Highlights\n\n[\s\S]*?\n\n### Changes/, `### Highlights\n\n${stories.map((s) => `- ${s}`).join("\n")}\n\n### Changes`);
  writeFileSync(join(dir, "draft.md"), edited);
  main(["write", "--version", "2026.10.2", "--file", join(dir, "draft.md")], dir);
  assert.equal(readFileSync(join(dir, "CHANGELOG", "records", "2026.10.2.md"), "utf8"), renderRecordFile("2026.10.2", edited));
  assert.match(main(["check"], dir), /follow the rules/);
  assert.match(main(["verify", "--version", "2026.10.2"], dir, { request }), /lists the 3 pull requests through v2026\.10\.2/);
  assert.equal(main(["read", "--version", "2026.10.2", "--record"], dir), renderRecordFile("2026.10.2", edited));

  const save = (text) => {
    writeFileSync(join(dir, "draft.md"), text);
    main(["write", "--version", "2026.10.2", "--file", join(dir, "draft.md")], dir);
  };
  save(edited.replace("- **PR #2** Related #9. Thanks @ada.", "- **PR #2** Thanks @ada."));
  assert.throws(() => main(["verify", "--version", "2026.10.2"], dir, { request }), /GitHub gives "- \*\*PR #2\*\* Related #9\. Thanks @ada\."/);
  save(edited.replace(/- \*\*PR #3\*\*\n/, "").replace(/.*\(#3\).*\n/g, "").replace(/3 in-range PRs \+ 0 retained seed-only PRs = 3/, "2 in-range PRs + 0 retained seed-only PRs = 2"));
  assert.throws(() => main(["verify", "--version", "2026.10.2"], dir, { request }), /missing #3/);
  save(edited.replace("- Sign-in loop. (#3)\n", "- Release tooling. (#4)\n"));
  assert.throws(() => main(["verify", "--version", "2026.10.2"], dir, { request }), /PR #4 \(chore\) belongs only in the record/);
  save(edited.replace(/### Highlights\n\n[\s\S]*?\n\n### Changes/, "### Highlights\n\n### Changes"));
  assert.throws(() => main(["verify", "--version", "2026.10.2"], dir, { request }), /1-8 top-level bullets; found 0/);
  save(edited);

  const notes = main(["notes", "--version", "2026.10.2"], dir);
  const published = fakeGithub({ releases: { "v2026.10.2": { body: notes } } });
  assert.match(main(["verify", "--version", "2026.10.2", "--check-github"], dir, { request: published }), /body is CHANGELOG\/2026\.10\.2\.md/);
  assert.throws(() => main(["verify", "--version", "2026.10.2", "--check-github"], dir, { request: fakeGithub({ releases: { "v2026.10.2": { body: "generated" } } }) }), /not the changelog section/);

  // The docs page: written with the file, checked against it.
  const page = join(dir, "docs", "releases", "2026.10.2.md");
  assert.equal(readFileSync(page, "utf8"), renderDocsPage("2026.10.2", edited));
  writeFileSync(page, `${readFileSync(page, "utf8")}\nEdited by hand.\n`);
  assert.throws(() => main(["check"], dir), /docs\/releases\/2026\.10\.2\.md is not the docs page of CHANGELOG\/2026\.10\.2\.md/);
  main(["index"], dir);
  writeFileSync(join(dir, "docs", "releases", "2026.10.7.md"), "# v2026.10.7\n");
  assert.throws(() => main(["check"], dir), /docs\/releases\/2026\.10\.7\.md has no stable CHANGELOG\/2026\.10\.7\.md/);
  execFileSync("rm", [join(dir, "docs", "releases", "2026.10.7.md")]);

  // After the docs deploy: the roster body, with the maintainer, the direct
  // commit's people, and the published verification section.
  const proof = "### Release verification\n\n- Field Full Release Validation passed.";
  const deployed = (body) => (path) => {
    if (/commits\/[0-9a-f]{40}$/.test(path)) return { author: { login: "IAMSamuelRodda", type: "User" }, commit: { message: "chore: direct commit\n\nCo-authored-by: Ken <7+ken@users.noreply.github.com>\nCo-authored-by: Claude <noreply@anthropic.com>" } };
    if (/releases\/tags\//.test(path)) return { body };
    return request(path);
  };
  const thanks = main(["thanks", "--version", "2026.10.2"], dir, { request: deployed(`${notes}\n${proof}\n`) });
  assert.equal(thanks, renderThanksBody({ version: "2026.10.2", pullRequests: 3, directCommits: 1, roster: ["ada", "IAMSamuelRodda", "ken"], verification: proof }));
  assert.match(thanks, /^## 2026\.10\.2\n\nThis release covers \*\*3 pull requests, 1 direct commit, and 3 contributors\.\*\*\n/);
  assert.match(thanks, /- Release notes: https:\/\/arcforgelabs\.github\.io\/docs\/field\/releases\/2026\.10\.2\/\n/);
  assert.match(thanks, /### Thanks\n\n@ada, @IAMSamuelRodda, @ken\n\n### Release verification\n/);
  assert.match(main(["verify", "--version", "2026.10.2", "--check-github", "--post-docs"], dir, { request: deployed(thanks) }), /roster body/);
  assert.throws(() => main(["verify", "--version", "2026.10.2", "--check-github", "--post-docs"], dir, { request: deployed(notes) }), /not the roster body/);

  // A beta starts at what npm's beta tag selects before it publishes.
  commit("feat: invoices (#5)");
  assert.match(main(["draft", "--version", "2026.10.3-beta.1"], dir, { request: fakeGithub({ pulls: { 5: {} } }), npm: () => "2026.10.2" }), /- \*\*PR #5\*\*\n$/);
  assert.throws(() => main(["draft", "--version", "2026.10.3-beta.1"], dir, { request, npm: () => "2026.10.3-beta.1" }), /already selects/);
  assert.throws(() => main(["draft", "--version", "2026.10.3-beta.1"], dir, { request, npm: () => null }), /Pass --base/);

  writeFileSync(join(dir, "CHANGELOG", "2026.10.9.md"), edited.replace("## 2026.10.2", "## 2026.10.9"));
  assert.throws(() => main(["check"], dir), /records\/2026\.10\.9\.md is missing/);
});

test("a release on its own branch starts where it split from the previous release's branch, less what that release shipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "field-changelog-branches-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  const commit = (subject) => run("commit", "-q", "--allow-empty", "-m", subject);
  commit("chore: start (#1)");
  run("tag", "v2026.10.1");
  commit("feat: job board (#2)");
  run("branch", "release/2026.10.2");
  commit("feat: invoices (#3)");
  commit("fix: sign-in loop (#4)");
  const fix = run("rev-parse", "HEAD").trim();
  run("checkout", "-q", "release/2026.10.2");
  commit("chore(release): 2026.10.2");
  run("cherry-pick", "-x", "--allow-empty", fix);
  run("tag", "v2026.10.2");
  run("checkout", "-q", "main");
  commit("chore(release): close out 2026.10.2 on main (#5)");
  commit("feat: price list (#6)");
  mkdirSync(join(dir, "CHANGELOG"));
  writeFileSync(join(dir, "CHANGELOG", "Unreleased.md"), "## Unreleased\n");
  const request = fakeGithub({ pulls: { 3: {}, 5: {}, 6: {} } });
  const manifest = join(dir, "manifest.json");
  const draft = main(["draft", "--version", "2026.10.3", "--manifest", manifest], dir, { request });
  assert.match(draft, /#### Pull requests\n\n- \*\*PR #3\*\*\n- \*\*PR #5\*\*\n- \*\*PR #6\*\*\n$/);
  assert.ok(draft.includes(`${run("rev-parse", "v2026.10.2").trim()}..${run("rev-parse", "HEAD").trim()} history: 3 in-range PRs`));
  assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")).shippedByBase, [4]);
});

test("a docs page links the prose's pull requests, issues and people, and has no record rows", () => {
  const text = section("2026.10.5", {
    highlights: ["- Invoices sync. (#12) Thanks @ada.", "- b. (#13)", "- c. (#13)", "- d. (#13)", "- e. (#13)"],
    changes: ["- Invoices sync, as #9 asked. (#12) Thanks @ada."],
    rows: ["- **PR #12** Related #9. Thanks @ada.", "- **PR #13**"],
  });
  const page = renderDocsPage("2026.10.5", text);
  assert.match(page, /^---\ntitle: "v2026\.10\.5"\nsummary: "Invoices sync\."\n/);
  assert.match(page, /\n# v2026\.10\.5\n\n<!-- Written by/);
  assert.match(page, /This release covers \*\*2 pull requests, with thanks to 1 contributor\.\*\*/);
  assert.match(page, /- Invoices sync, as \[#9\]\(https:\/\/github\.com\/arcforgelabs\/field\/issues\/9\) asked\. \(\[#12\]\(https:\/\/github\.com\/arcforgelabs\/field\/pull\/12\)\) Thanks \[@ada\]\(https:\/\/github\.com\/ada\)\./);
  assert.doesNotMatch(page, /## Fixes|\*\*PR #/);
  assert.equal(verificationTail("notes\n\n### Release verification\n\n- ok\n"), "### Release verification\n\n- ok");
  assert.equal(verificationTail("notes"), "");
});

test("Prepare verifies the changelog before it tags, and Publish uses it and checks the published body", () => {
  const workflow = (name) => readFileSync(join(root, ".github/workflows", name), "utf8");
  const prepare = workflow("field-release-prepare.yml");
  const verify = prepare.indexOf("changelog.mjs verify --version");
  assert.ok(verify > 0 && verify < prepare.indexOf("- name: Create the release tag"), "Prepare verifies the changelog before it tags");
  assert.match(prepare, /- name: Require the changelog\n/);
  const publish = workflow("field-release-publish.yml");
  assert.match(publish, /changelog\.mjs notes --version "\$VERSION"/);
  assert.match(publish, /changelog\.mjs verify --version "\$VERSION" --check-github/);
});
