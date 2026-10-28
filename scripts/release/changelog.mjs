#!/usr/bin/env node
// The changelog: one file per release in CHANGELOG/, its contribution record
// again in CHANGELOG/records/, and CHANGELOG.md, an index of them that this
// script writes. The layout, the entry and record formats and the rules are
// openclaw/openclaw's split changelog (its openclaw-changelog-update skill and
// verify-release-notes.mjs). Pull requests never edit these files; the release
// cut writes a release's file from the history since the previous release
// (CONTRIBUTING.md, .agents/skills/field-changelog-update).
// Copied from arcforgelabs/flow at 5d2e092 (flow#197); only the repository
// constants below differ.
//
//   node scripts/release/changelog.mjs draft --version <v> [--base <tag>] [--target <ref>] [--output <file>] [--manifest <file>]
//     A first section for <v>: Highlights, Changes and Fixes from feat,
//     improve and fix pull requests, and the complete contribution record of
//     every pull request in the range, with its related issues and thanks.
//     --manifest also writes the inventory (pull requests, credit, direct
//     commits) as JSON. Edit the prose, then `write` it.
//   node scripts/release/changelog.mjs write --version <v> --file <section.md>
//     Saves the section as CHANGELOG/<v>.md, its record as
//     CHANGELOG/records/<v>.md, and writes the index again.
//   node scripts/release/changelog.mjs read --version <v> [--record]
//     The section, or its record, as saved.
//   node scripts/release/changelog.mjs notes --version <v>
//     The GitHub Release body for <v>: the section, or, when it is too long
//     for GitHub, the prose and a link to the record.
//   node scripts/release/changelog.mjs verify --version <v> [--target <ref>] [--check-github [--post-docs] [--release-tag <tag>] [--body-file <file>]]
//     Whether the record lists exactly the pull requests in the range, with
//     the related issues and thanks GitHub gives, and whether the prose keeps
//     the rules below. Field Release Prepare runs it before it tags.
//     --check-github: whether the published GitHub Release body is `notes`;
//     --body-file checks that body instead (a draft release's, which only the
//     publish run can read).
//   node scripts/release/changelog.mjs index
//     Writes CHANGELOG.md again from the files in CHANGELOG/, and the
//     docs-site page of each stable release and correction,
//     docs/releases/<v>.md (write does this too).
//   node scripts/release/changelog.mjs thanks --version <v>
//     The GitHub Release body after the docs site serves <v>'s page: the
//     version and its numbers, the docs, Raw changelog and record links, and
//     one roster of every person GitHub credits, the maintainer included.
//     It keeps the published body's `### Release verification` section.
//     `verify --check-github --post-docs` checks the published body is this.
//   node scripts/release/changelog.mjs check
//     Whether the index, every file and every docs page keep the format rules
//     (npm test runs it).
//
// Each exits 1 with a reason on stderr. draft and verify read GitHub through
// `gh api` and keep the answers in .git/field-changelog/ (--refresh-github-snapshot
// asks again).
//
// A release's range: a stable release covers the history since the previous
// stable release; a beta covers the history since the version npm's `beta`
// tag selects before the beta is published; a correction (YYYY.M.N-C)
// covers the history since the stable release before YYYY.M.N, as its stable
// release did, so it replaces that file's notes whole. Each release is tagged
// on its own release branch (docs/RELEASING.md), so the base tag is often not
// in the target's history: the range then starts where the two branches
// split, less every pull request the base already shipped (as a cherry-pick
// with `-x`, or as its release commit), as OpenClaw's verifier subtracts a
// shipped record. Only `feat`, `improve` and `fix`
// pull requests (and any type marked breaking with `!`) appear in the prose;
// `docs`, `chore`, `refactor`, `test`, `ci`, `build` and `style` appear only in
// the record. A stable release aims for 5-8 highlights, a beta 0-8. Thanks never go
// to bots, to Claude or Codex, to the organization or to the maintainer.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareTags, parseTag } from "./release.mjs";

export const REPOSITORY = "arcforgelabs/field";
export const PACKAGE = "@arcforgelabs/field";
export const INDEX_MARKER = "<!-- field:split-changelog -->";
export const PRODUCT = "Field";
// The docs site (arcforgelabs/docs) renders docs/ of this repository here.
export const DOCS_SITE = "https://arcforgelabs.github.io/docs/field";
export const DOCS_RELEASES = "docs/releases";
export const UNRELEASED = "Unreleased";
// GitHub refuses a release body longer than this (characters, and bytes).
export const GITHUB_BODY_LIMIT = 125_000;
// Handles the changelog never thanks: the maintainer, the organization and
// the agents that write most pull requests. Bots ([bot], app/) are refused too.
// The roster after the docs deploy thanks the maintainer, as OpenClaw's
// thanks @steipete there; the agents, bots and organization stay out.
export const MAINTAINER_HANDLES = new Set(["iamsamuelrodda"]);
export const AGENT_HANDLES = new Set(["arcforgelabs", "claude", "codex", "copilot", "github-actions", "dependabot", "clawsweeper", "arc-forge-clawsweeper"]);
export const EXCLUDED_HANDLES = new Set([...MAINTAINER_HANDLES, ...AGENT_HANDLES]);

const PROSE = ["Highlights", "Changes", "Fixes"];
const RECORD = "Complete contribution record";
const PULL_REQUESTS = "#### Pull requests";
const EDITORIAL_TYPES = new Set(["feat", "improve", "fix"]);
const TITLE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s*(?<description>.+)$/;
const PR_SUFFIX = /\s*\(#(\d+)\)\s*$/;
// `#N` in this repository; `owner/repo#N` stays literal text.
const REFERENCE = /(?<![\w/.-])#(\d+)\b/g;
const HANDLE = /@([-_/A-Za-z0-9]+(?:\[bot\])?)/g;
const RECORD_ROW = /^- \*\*PR #(\d+)\*\*(?: Related (#\d+(?:, #\d+)*)\.)?(?: Thanks (@[-_A-Za-z0-9]+(?: and @[-_A-Za-z0-9]+)*)\.)?$/;
const PROVENANCE = /^This audited record covers the complete (?:(?<base>[0-9a-f]{40})\.\.(?<target>[0-9a-f]{40}) history|history through (?<first>[0-9a-f]{40})): (?<inRange>[\d,]+) in-range PRs \+ (?<seed>[\d,]+) retained seed-only PRs = (?<total>[\d,]+) unique PRs\. The generation manifest also supplies direct commits as editorial input; the grouped notes above prioritize user impact\.$/;
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?<![\w/.-])#(\d+)\b/gi;

export class ChangelogError extends Error {}

export function pullUrl(number) {
  return `https://github.com/${REPOSITORY}/pull/${number}`;
}

// A changelog version: a release version without the "v" of its tag.
export function parseVersion(version) {
  try {
    return parseTag(`v${version}`);
  } catch {
    throw new ChangelogError(`"${version}" is not a release version (YYYY.M.N, YYYY.M.N-beta.B or YYYY.M.N-C)`);
  }
}

// Oldest first: a beta, its stable release, then that release's corrections.
export function compareVersions(a, b) {
  return compareTags(`v${parseVersion(a).version}`, `v${parseVersion(b).version}`);
}

// A merged pull request's squash subject, `type(scope)!: description (#N)`.
export function parseSubject(subject) {
  const pr = PR_SUFFIX.exec(subject);
  const title = subject.replace(PR_SUFFIX, "").trim();
  const match = TITLE.exec(title);
  const type = match?.groups.type ?? null;
  const breaking = Boolean(match?.groups.breaking);
  return {
    number: pr ? Number(pr[1]) : null,
    title,
    type,
    scope: match?.groups.scope ?? null,
    breaking,
    description: match ? match.groups.description.trim() : title,
    editorial: Boolean(type && (EDITORIAL_TYPES.has(type) || breaking)),
    section: type === "fix" ? "Fixes" : "Changes",
  };
}

export function isEligibleHandle(handle, { roster = false } = {}) {
  const normalized = String(handle ?? "").toLowerCase();
  const excluded = roster ? AGENT_HANDLES : EXCLUDED_HANDLES;
  return normalized !== "" && normalized !== "null" && normalized !== "undefined" && !normalized.endsWith("[bot]") && !normalized.startsWith("app/") && !excluded.has(normalized);
}

export function references(text) {
  return [...text.matchAll(REFERENCE)].map((match) => Number(match[1]));
}

function sentence(text) {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

function thanksProse(handles) {
  if (handles.length === 0) return "";
  const named = handles.map((handle) => `@${handle}`);
  const list = named.length < 3 ? named.join(" and ") : `${named.slice(0, -1).join(", ")}, and ${named.at(-1)}`;
  return ` Thanks ${list}.`;
}

// One prose bullet for one pull request: `- Text. (#N) Thanks @a.`
export function entry(pr, credit = {}) {
  return `- ${sentence(pr.description)} (#${pr.number})${thanksProse(credit.thanks ?? [])}`;
}

// One record row: `- **PR #N** Related #I. Thanks @a and @b.`
export function recordRow(number, { related = [], thanks = [] } = {}) {
  const parts = [`- **PR #${number}**`];
  if (related.length) parts.push(`Related ${related.map((issue) => `#${issue}`).join(", ")}.`);
  if (thanks.length) parts.push(`Thanks ${thanks.map((handle) => `@${handle}`).join(" and ")}.`);
  return parts.join(" ");
}

const count = (value) => value.toLocaleString("en-US");

export function provenance({ base, target, total }) {
  const range = base ? `${base}..${target} history` : `history through ${target}`;
  return `This audited record covers the complete ${range}: ${count(total)} in-range PRs + 0 retained seed-only PRs = ${count(total)} unique PRs. The generation manifest also supplies direct commits as editorial input; the grouped notes above prioritize user impact.`;
}

// The record block, from its heading to its last row.
export function renderRecord({ base, target, prs, credits = new Map() }) {
  return [`### ${RECORD}`, "", provenance({ base, target, total: prs.length }), "", PULL_REQUESTS, "", ...prs.map((pr) => recordRow(pr.number, credits.get(pr.number))), ""].join("\n");
}

export function renderSection({ version, base, target, prs, credits = new Map(), highlights }) {
  const prose = prs.filter((pr) => pr.editorial);
  const changes = prose.filter((pr) => pr.section === "Changes");
  const fixes = prose.filter((pr) => pr.section === "Fixes");
  const seeded = highlights ?? [...changes, ...fixes].slice(0, 8);
  const lines = [`## ${version}`, ""];
  for (const [heading, items] of [["Highlights", seeded], ["Changes", changes], ["Fixes", fixes]]) {
    lines.push(`### ${heading}`, "");
    if (items.length) lines.push(...items.map((pr) => entry(pr, credits.get(pr.number))), "");
  }
  lines.push(renderRecord({ base, target, prs, credits }));
  return `${lines.join("\n").trimEnd()}\n`;
}

// The record file: the release heading and the section's record block.
export function renderRecordFile(version, text) {
  const at = text.indexOf(`### ${RECORD}`);
  if (at < 0) throw new ChangelogError(`CHANGELOG/${version}.md has no "### ${RECORD}"`);
  return `## ${version}\n\n${text.slice(at).trimEnd()}\n`;
}

// A section's parts: its heading and each ### block's lines.
export function parseSection(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const heading = /^## (.+)$/.exec(lines[0] ?? "")?.[1];
  const blocks = [];
  for (const line of lines.slice(1)) {
    const block = /^### (.+)$/.exec(line);
    if (block) blocks.push({ heading: block[1], lines: [] });
    else if (/^##? /.test(line)) throw new ChangelogError(`a section has one "## " heading; found "${line}"`);
    else if (blocks.length > 0) blocks.at(-1).lines.push(line);
    else if (line.trim() !== "") throw new ChangelogError(`text before the first "### " heading: "${line}"`);
  }
  return { heading, blocks };
}

function bullets(block) {
  return block?.lines.filter((line) => line.startsWith("- ")) ?? [];
}

// A record block's provenance and rows; refuses a malformed or forged count.
export function parseRecord(block, fail) {
  const text = block.lines.filter((line) => line.trim() !== "");
  const match = PROVENANCE.exec(text[0] ?? "");
  if (!match) fail(`the record opens with OpenClaw's audited-record sentence; found "${text[0] ?? ""}"`);
  if (text[1] !== PULL_REQUESTS) fail(`the record's rows follow "${PULL_REQUESTS}"`);
  const rows = new Map();
  for (const line of text.slice(2)) {
    const row = RECORD_ROW.exec(line);
    if (!row) fail(`a record row is "- **PR #N** Related #I. Thanks @a and @b."; found "${line}"`);
    const number = Number(row[1]);
    if (rows.has(number)) fail(`PR #${number} is in the record twice`);
    rows.set(number, { related: row[2] ? references(row[2]) : [], thanks: row[3] ? [...row[3].matchAll(HANDLE)].map((h) => h[1]) : [] });
  }
  const [inRange, seed, total] = ["inRange", "seed", "total"].map((name) => Number(match.groups[name].replaceAll(",", "")));
  if (seed !== 0) fail("Field keeps no seed-only rows; the record says it does");
  if (inRange + seed !== total || total !== rows.size) fail(`the record's sum must match its ${rows.size} rows`);
  return { base: match.groups.base ?? null, target: match.groups.target ?? match.groups.first, rows };
}

// The format rules one file in CHANGELOG/ keeps. Returns its record, or null.
export function checkSection(name, text) {
  const version = name.replace(/\.md$/, "");
  const unreleased = version === UNRELEASED;
  if (!unreleased) parseVersion(version);
  const { heading, blocks } = parseSection(text);
  const fail = (reason) => {
    throw new ChangelogError(`CHANGELOG/${name}: ${reason}`);
  };
  if (heading !== version) fail(`the first line must be "## ${version}"`);
  const order = [...PROSE, RECORD];
  let last = -1;
  for (const block of blocks) {
    const at = order.indexOf(block.heading);
    if (at < 0) fail(`"### ${block.heading}" is not one of ${order.map((h) => `"${h}"`).join(", ")}`);
    if (at <= last) fail(`"### ${block.heading}" is out of order or repeated (order: ${order.join(", ")})`);
    last = at;
    for (const line of block.lines) {
      if (line.trim() !== "" && !line.startsWith("- ") && !line.startsWith("  ") && block.heading !== RECORD) {
        fail(`"### ${block.heading}" holds only bullets; found "${line}"`);
      }
    }
  }
  for (const line of text.split("\n")) {
    if (!/\bThanks\b/i.test(line)) continue;
    for (const [, handle] of line.matchAll(HANDLE)) {
      if (!isEligibleHandle(handle)) fail(`never thank @${handle} (bots, agents, the organization and the maintainer get no thanks): "${line}"`);
    }
  }
  const record = blocks.find((block) => block.heading === RECORD);
  if (unreleased) {
    if (record) fail("Unreleased has no record; the release cut writes one");
    return null;
  }
  if (!record) fail(`a release ends with "### ${RECORD}"`);
  const parsed = parseRecord(record, fail);
  for (const headingName of PROSE) {
    for (const line of bullets(blocks.find((block) => block.heading === headingName))) {
      for (const number of references(line).filter((n) => parsed.rows.has(n))) {
        for (const handle of parsed.rows.get(number).thanks) {
          if (!line.toLowerCase().includes(`@${handle.toLowerCase()}`)) fail(`"### ${headingName}" names PR #${number}, so it keeps its credit @${handle}: "${line}"`);
        }
      }
    }
  }
  return parsed;
}

// OpenClaw's highlight budget: 0-8 bullets. A stable release aims for 5-8,
// but that is a guideline for the writing, not a gate on the release: a small
// patch release ships with the stories it has (highlightCountWarning).
export function highlightCountError(version, text) {
  const found = bullets(parseSection(text).blocks.find((block) => block.heading === "Highlights")).length;
  const minimum = parseVersion(version).channel === "beta" ? 0 : 1;
  return found >= minimum && found <= 8 ? null : `### Highlights must contain ${minimum}-8 top-level bullets; found ${found}`;
}

export function highlightCountWarning(version, text) {
  if (parseVersion(version).channel === "beta") return null;
  const found = bullets(parseSection(text).blocks.find((block) => block.heading === "Highlights")).length;
  return found >= 1 && found < 5 ? `### Highlights has ${found} bullets; a stable release aims for 5-8. Fine for a small patch release; never invent highlights` : null;
}

// The docs-site page of a stable release or correction, OpenClaw's
// docs/releases/<version>.md: the prose of CHANGELOG/<v>.md for readers, with
// its pull requests, issues and people as links, and a link to the record.
// Written from the file, so the page, the file and the release body agree.
export function hasDocsPage(version) {
  return parseVersion(version).channel !== "beta";
}

function plain(line) {
  return line
    .replace(/^- /, "")
    .replace(/\s*\bThanks\b.*$/, "")
    .replace(/\s*\((?:#\d+(?:,\s*)?)+\)/g, "")
    .trim();
}

function linked(line, pulls) {
  return line
    .replace(REFERENCE, (all, number) => `[#${number}](https://github.com/${REPOSITORY}/${pulls.has(Number(number)) ? "pull" : "issues"}/${number})`)
    .replace(/(^|[\s(])@([-_A-Za-z0-9]+)\b/g, (all, before, handle) => `${before}[@${handle}](https://github.com/${handle})`);
}

function plural(number, one, many = `${one}s`) {
  return `${count(number)} ${number === 1 ? one : many}`;
}

function uniqueHandles(handles) {
  const seen = new Map();
  for (const handle of handles) if (!seen.has(handle.toLowerCase())) seen.set(handle.toLowerCase(), handle);
  return [...seen.values()];
}

export function renderDocsPage(version, text) {
  const fail = (reason) => {
    throw new ChangelogError(`CHANGELOG/${version}.md: ${reason}`);
  };
  const { blocks } = parseSection(text);
  const block = blocks.find((found) => found.heading === RECORD);
  if (!block) fail(`a release ends with "### ${RECORD}"`);
  const record = parseRecord(block, fail);
  const pulls = new Set(record.rows.keys());
  const people = uniqueHandles([...record.rows.values()].flatMap((row) => row.thanks));
  const prose = PROSE.map((heading) => [heading, bullets(blocks.find((found) => found.heading === heading))]);
  const first = prose.find(([, lines]) => lines.length)?.[1][0];
  const summary = first ? plain(first) : `What changed in ${PRODUCT} ${version}.`;
  const covers = people.length ? `${plural(record.rows.size, "pull request")}, with thanks to ${plural(people.length, "contributor")}` : plural(record.rows.size, "pull request");
  const lines = [
    "---",
    `title: ${JSON.stringify(`v${version}`)}`,
    `summary: ${JSON.stringify(summary)}`,
    `description: ${JSON.stringify(`${PRODUCT} v${version} release notes: what changed, and who contributed.`)}`,
    "keywords:",
    `  - ${PRODUCT}`,
    `  - v${version}`,
    "  - release notes",
    "---",
    "",
    `# v${version}`,
    "",
    `<!-- Written by scripts/release/changelog.mjs from CHANGELOG/${version}.md. Do not edit it: the release cut writes it again. -->`,
    "",
    `AI agents and tools can read these release notes as [plain Markdown](https://raw.githubusercontent.com/${REPOSITORY}/main/CHANGELOG/${version}.md).`,
    "",
    `This release covers **${covers}.**`,
    "",
  ];
  for (const [heading, items] of prose) {
    if (items.length) lines.push(`## ${heading}`, "", ...items.map((line) => linked(line, pulls)), "");
  }
  lines.push(
    "## Contribution record",
    "",
    `[CHANGELOG/records/${version}.md](https://github.com/${REPOSITORY}/blob/main/CHANGELOG/records/${version}.md) lists every pull request in this release once, with its related issues and thanks.`,
    "",
  );
  return lines.join("\n");
}

export function renderIndex(versions) {
  const sorted = [...versions].sort((a, b) => compareVersions(b, a));
  const row = (name) => `- [${name}](CHANGELOG/${name}.md) · [Raw](https://github.com/${REPOSITORY}/raw/refs/heads/main/CHANGELOG/${name}.md)`;
  return [
    "# Changelog",
    "",
    INDEX_MARKER,
    "",
    `Release notes: https://github.com/${REPOSITORY}/releases`,
    "",
    "Each release has its complete changelog below. Audited contribution records are retained separately when available.",
    "",
    row(UNRELEASED),
    ...sorted.map(row),
    "",
  ].join("\n");
}

export function listVersions(root) {
  const dir = join(root, "CHANGELOG");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== `${UNRELEASED}.md`)
    .map((name) => name.replace(/\.md$/, ""));
}

export function checkChangelog(root) {
  const dir = join(root, "CHANGELOG");
  const names = existsSync(dir) ? readdirSync(dir) : [];
  if (!names.includes(`${UNRELEASED}.md`)) throw new ChangelogError(`CHANGELOG/${UNRELEASED}.md is missing`);
  const records = existsSync(join(dir, "records")) ? readdirSync(join(dir, "records")) : [];
  const versions = [];
  for (const name of names) {
    if (name === "records") continue;
    if (!name.endsWith(".md")) throw new ChangelogError(`CHANGELOG/${name}: only .md files and records/ belong here`);
    const text = readFileSync(join(dir, name), "utf8");
    if (!checkSection(name, text)) continue;
    const version = name.replace(/\.md$/, "");
    versions.push(version);
    if (!records.includes(name)) throw new ChangelogError(`CHANGELOG/records/${name} is missing. Run: node scripts/release/changelog.mjs write --version ${version} --file CHANGELOG/${name}`);
    if (readFileSync(join(dir, "records", name), "utf8") !== renderRecordFile(version, text)) {
      throw new ChangelogError(`CHANGELOG/records/${name} is not the record in CHANGELOG/${name}`);
    }
  }
  for (const name of records) {
    if (!names.includes(name)) throw new ChangelogError(`CHANGELOG/records/${name} has no CHANGELOG/${name}`);
  }
  const docsDir = join(root, DOCS_RELEASES);
  const pages = existsSync(docsDir) ? readdirSync(docsDir).filter((name) => name !== "index.md") : [];
  for (const version of versions.filter(hasDocsPage)) {
    const page = join(docsDir, `${version}.md`);
    const want = renderDocsPage(version, readFileSync(join(dir, `${version}.md`), "utf8"));
    if (!existsSync(page) || readFileSync(page, "utf8") !== want) {
      throw new ChangelogError(`${DOCS_RELEASES}/${version}.md is not the docs page of CHANGELOG/${version}.md. Run: node scripts/release/changelog.mjs index`);
    }
  }
  for (const name of pages) {
    const version = name.replace(/\.md$/, "");
    if (!versions.includes(version) || !hasDocsPage(version)) throw new ChangelogError(`${DOCS_RELEASES}/${name} has no stable CHANGELOG/${name}`);
  }
  const index = existsSync(join(root, "CHANGELOG.md")) ? readFileSync(join(root, "CHANGELOG.md"), "utf8") : "";
  if (index !== renderIndex(versions)) {
    throw new ChangelogError("CHANGELOG.md is not the index of CHANGELOG/. Run: node scripts/release/changelog.mjs index");
  }
  return { versions: versions.sort((a, b) => compareVersions(b, a)) };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function revParse(root, ref) {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch {
    throw new ChangelogError(`"${ref}" is not a commit here`);
  }
}

function isAncestor(root, ancestor, ref) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, ref], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function releaseTags(root) {
  return git(root, ["tag", "--list", "v20*"]).split("\n").map((tag) => tag.trim()).filter(Boolean);
}

// The previous release a version's notes start from: the newest older stable
// tag for a stable release, or older tag of either channel. A correction
// starts where its stable release started. Release branches mean the tag
// need not be in the target's history (historyRange).
export function baseTag({ version, tags }) {
  const release = parseVersion(version);
  const older = [];
  for (const tag of tags) {
    let parsed;
    try {
      parsed = parseTag(tag.trim());
    } catch {
      continue;
    }
    if (release.channel === "stable" && parsed.channel !== "stable") continue;
    if (release.correction && parsed.base === release.base) continue;
    if (compareVersions(parsed.version, release.version) >= 0) continue;
    older.push(parsed);
  }
  older.sort((a, b) => compareVersions(b.version, a.version));
  return older[0]?.tag ?? null;
}

function npmBeta() {
  try {
    return execFileSync("npm", ["view", PACKAGE, "dist-tags.beta"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

// Where a new section starts. A stable release: the previous stable tag. A
// beta: the version npm's `beta` tag selects now, before this beta publishes.
export function resolveBase(root, { version, base, target, npm = npmBeta }) {
  if (base && base !== "npm-beta") return base;
  const release = parseVersion(version);
  const previous = baseTag({ version, tags: releaseTags(root) });
  if (release.channel === "stable") return previous;
  // The first release of all has no earlier tag: its notes cover the whole
  // history through its target.
  if (!previous) return null;
  const selected = npm();
  if (!selected) throw new ChangelogError(`npm's beta tag for ${PACKAGE} could not be read. Pass --base <the tag it selected>`);
  if (compareVersions(selected, version) >= 0) throw new ChangelogError(`npm's beta tag already selects ${selected}, so it cannot be ${version}'s base. Pass --base <the tag captured before publishing>`);
  return `v${selected}`;
}

// Pull requests in a list of commits ({ sha, subject }), oldest first. A
// commit with no "(#N)" is a direct commit and has no row, as the release
// commit has. A revert of a pull request in the same range removes both.
export function pullRequestsIn(commits) {
  const prs = [];
  const reverted = new Set();
  for (const commit of commits) {
    const revert = /^Revert "(.+)"/.exec(commit.subject);
    if (revert) reverted.add(revert[1].trim());
  }
  for (const commit of commits) {
    if (reverted.has(commit.subject.trim())) continue;
    if (/^Revert "/.test(commit.subject) && commits.some((other) => other.subject.trim() === /^Revert "(.+)"/.exec(commit.subject)[1].trim())) continue;
    const pr = parseSubject(commit.subject);
    if (pr.number !== null && !prs.some((other) => other.number === pr.number)) prs.push({ ...pr, sha: commit.sha });
  }
  return prs;
}

function commitsIn(root, range) {
  return git(root, ["log", "--topo-order", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", range])
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, body = ""] = record.split("\x1f");
      return { sha, subject, body };
    });
}

// The pull requests a release branch shipped that its target lacks: each
// commit's own "(#N)", and the pull request of the main commit a `-x`
// cherry-pick names.
function shippedPullRequests(root, commits) {
  const shipped = new Set();
  for (const commit of commits) {
    const own = parseSubject(commit.subject).number;
    if (own !== null) shipped.add(own);
    for (const [, origin] of commit.body.matchAll(/\(cherry picked from commit ([0-9a-f]{40})\)/g)) {
      try {
        const number = parseSubject(git(root, ["log", "-1", "--format=%s", origin]).trim()).number;
        if (number !== null) shipped.add(number);
      } catch {
        // The original commit is not in this clone; its own subject counted.
      }
    }
  }
  return shipped;
}

// Every commit the target has and the base does not, oldest first. When the
// base is on another release branch, the range starts at the commit the two
// share, and the pull requests the base branch already shipped drop out.
export function historyRange(root, { base, target }) {
  if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new ChangelogError("this clone is shallow, so its history is cut short. Run: git fetch --unshallow --tags origin");
  }
  const to = revParse(root, target);
  const from = base ? revParse(root, base) : null;
  let start = from;
  let shipped = new Set();
  if (from && !isAncestor(root, from, to)) {
    try {
      start = git(root, ["merge-base", from, to]).trim();
    } catch {
      throw new ChangelogError(`${base} and ${target} share no history`);
    }
    shipped = shippedPullRequests(root, commitsIn(root, `${start}..${from}`));
  }
  const commits = commitsIn(root, start ? `${start}..${to}` : to).map(({ sha, subject }) => ({ sha, subject }));
  const direct = commits.filter((commit) => parseSubject(commit.subject).number === null && !/^Merge /.test(commit.subject));
  const prs = pullRequestsIn(commits).filter((pr) => !shipped.has(pr.number));
  return { base: from, target: to, prs, direct, shipped: [...shipped].sort((a, b) => a - b) };
}

// GitHub through `gh api`, with each answer kept in .git/field-changelog/ so
// repeated drafts and checks of one range ask once. Live reads skip the cache.
export function githubClient(root, { refresh = false, request } = {}) {
  const ask =
    request ??
    ((path) => {
      try {
        return JSON.parse(execFileSync("gh", ["api", path], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }));
      } catch (error) {
        if (/HTTP 404/.test(String(error.stderr ?? ""))) return null;
        throw new ChangelogError(`GitHub did not answer ${path} (gh api needs GH_TOKEN or gh auth login): ${String(error.stderr ?? error.message).trim()}`);
      }
    });
  let file = null;
  let cache = {};
  if (!request) {
    const dir = resolve(root, git(root, ["rev-parse", "--git-dir"]).trim(), "field-changelog");
    file = join(dir, "github.json");
    if (!refresh && existsSync(file)) cache = JSON.parse(readFileSync(file, "utf8"));
    mkdirSync(dir, { recursive: true });
  }
  return (path, { live = false } = {}) => {
    if (!live && path in cache) return cache[path];
    const value = ask(path);
    if (!live && file) {
      cache[path] = value;
      writeFileSync(file, JSON.stringify(cache));
    }
    return value;
  };
}

function handleFromNoreply(email) {
  return /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email ?? "")?.[1] ?? null;
}

function human(user, options) {
  return user && user.type !== "Bot" && isEligibleHandle(user.login, options) ? user.login : null;
}

function coAuthors(message, options) {
  const handles = [];
  for (const [, email] of String(message ?? "").matchAll(/^Co-authored-by:.*<([^>]+)>\s*$/gim)) {
    const login = handleFromNoreply(email);
    handles.push(login && isEligibleHandle(login, options) ? login : null);
  }
  return handles;
}

// A pull request's credit, as OpenClaw gives it: the issues it closes
// (`Related #I`), and thanks to its author, its known co-authors and the
// people who reported those issues, never to bots or excluded handles.
// { roster: true } also credits the maintainer, for the roster (`thanks`).
export function creditFor(github, number, options = {}) {
  const pull = github(`repos/${REPOSITORY}/pulls/${number}`);
  if (!pull) throw new ChangelogError(`#${number} is not a pull request in ${REPOSITORY}`);
  const commits = [];
  for (let page = 1; ; page += 1) {
    const batch = github(`repos/${REPOSITORY}/pulls/${number}/commits?per_page=100&page=${page}`) ?? [];
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  const handles = [human(pull.user, options)];
  for (const commit of commits) {
    handles.push(human(commit.author, options), ...coAuthors(commit.commit?.message, options));
  }
  const related = [];
  for (const match of String(pull.body ?? "").matchAll(CLOSING)) {
    const issue = Number(match[1]);
    if (related.includes(issue) || issue === number) continue;
    const found = github(`repos/${REPOSITORY}/issues/${issue}`);
    if (!found || found.pull_request) continue;
    related.push(issue);
    handles.push(human(found.user, options));
  }
  const thanks = [];
  for (const handle of handles) {
    if (handle && !thanks.some((known) => known.toLowerCase() === handle.toLowerCase())) thanks.push(handle);
  }
  return { related, thanks };
}

export function readSection(root, version, { record = false } = {}) {
  const relative = record ? `CHANGELOG/records/${version}.md` : `CHANGELOG/${version}.md`;
  if (!existsSync(join(root, relative))) throw new ChangelogError(`${relative} does not exist. The release cut writes it (.agents/skills/field-changelog-update).`);
  return readFileSync(join(root, relative), "utf8");
}

// The GitHub Release body: the whole section when GitHub accepts it, else the
// prose and a link to the tag's record file. Never a cut bullet or row.
export function releaseNotes(text, version) {
  if (text.length <= GITHUB_BODY_LIMIT && Buffer.byteLength(text) <= GITHUB_BODY_LIMIT) return text;
  const prose = text.slice(0, text.indexOf(`### ${RECORD}`)).trimEnd();
  const link = `https://github.com/${REPOSITORY}/blob/v${version}/CHANGELOG/records/${version}.md`;
  return `${prose}\n\n### ${RECORD}\n\nThe complete contribution record is in [CHANGELOG/records/${version}.md](${link}).\n`;
}

// Whether a published release body is the notes, with only an optional
// `### Release verification` tail after them.
export function checkReleaseBody(body, notes) {
  const normal = (text) => String(text ?? "").replace(/\r\n/g, "\n").trimEnd();
  const [have, want] = [normal(body), normal(notes)];
  if (have === want) return null;
  if (have.startsWith(want) && /^\n+### Release verification\n/.test(have.slice(want.length))) return null;
  return "the GitHub Release body is not the changelog section";
}

// OpenClaw's GitHub Release body after the docs deploy: the version and its
// numbers, the docs, Raw changelog and record links, and one alphabetical
// roster of every person GitHub credits on the release's pull requests and
// direct commits (authors, co-authors, issue reporters), the maintainer
// included and bots never. The published body's `### Release verification`
// section stays as it is.
export function rosterFor(root, github, version) {
  const text = readSection(root, version);
  const record = checkSection(`${version}.md`, text);
  const history = historyRange(root, { base: record.base, target: record.target });
  const handles = [];
  for (const number of record.rows.keys()) handles.push(...creditFor(github, number, { roster: true }).thanks);
  for (const commit of history.direct) {
    const found = github(`repos/${REPOSITORY}/commits/${commit.sha}`);
    handles.push(human(found?.author, { roster: true }), ...coAuthors(found?.commit?.message, { roster: true }));
  }
  const roster = uniqueHandles(handles.filter(Boolean)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { pullRequests: record.rows.size, directCommits: history.direct.length, roster };
}

export function verificationTail(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const at = text.search(/(^|\n)### Release verification\n/);
  return at < 0 ? "" : text.slice(at).replace(/^\n/, "").trimEnd();
}

export function renderThanksBody({ version, pullRequests, directCommits, roster, verification = "" }) {
  const lines = [
    `## ${version}`,
    "",
    `This release covers **${plural(pullRequests, "pull request")}, ${plural(directCommits, "direct commit")}, and ${plural(roster.length, "contributor")}.**`,
    "",
    `- Release notes: ${DOCS_SITE}/releases/${version}/`,
    `- Raw changelog: https://github.com/${REPOSITORY}/raw/refs/tags/v${version}/CHANGELOG/${version}.md`,
    `- Contribution record: https://github.com/${REPOSITORY}/blob/v${version}/CHANGELOG/records/${version}.md`,
    "",
    "### Thanks",
    "",
    roster.length ? `${roster.map((handle) => `@${handle}`).join(", ")}` : "No person is credited on this release.",
  ];
  if (verification) lines.push("", verification);
  const body = `${lines.join("\n")}\n`;
  if (body.length > GITHUB_BODY_LIMIT || Buffer.byteLength(body) > GITHUB_BODY_LIMIT) {
    throw new ChangelogError(`the ${version} roster body is longer than GitHub accepts; it is never cut short`);
  }
  return body;
}

// The rules that need git and GitHub: the record lists exactly the range's
// pull requests with GitHub's credit, the prose names only editorial pull
// requests in the range, and the highlight budget holds.
export function verifySection(root, { version, target, github }) {
  const name = `${version}.md`;
  const text = readSection(root, version);
  const record = checkSection(name, text);
  const fail = (reason) => {
    throw new ChangelogError(`CHANGELOG/${name}: ${reason}`);
  };
  const errors = [];
  const highlight = highlightCountError(version, text);
  if (highlight) errors.push(highlight);
  const fewer = highlightCountWarning(version, text);
  if (fewer) console.warn(`CHANGELOG/${name}: ${fewer}`);
  const { blocks } = parseSection(text);
  for (const heading of PROSE) if (!blocks.some((block) => block.heading === heading)) errors.push(`missing ### ${heading}`);
  const tags = releaseTags(root);
  const finalTarget = target ?? (tags.includes(`v${version}`) ? `v${version}` : "HEAD");
  const finalSha = revParse(root, finalTarget);
  if (!isAncestor(root, record.target, finalSha)) fail(`the record's target ${record.target} is not in ${finalTarget}`);
  const tagCommits = new Map(tags.map((tag) => [revParse(root, tag), tag]));
  if (parseVersion(version).channel === "stable") {
    const expected = baseTag({ version, tags });
    const expectedSha = expected ? revParse(root, expected) : null;
    if (record.base !== expectedSha) fail(`a stable record starts at the previous stable release ${expected ? `${expected} (${expectedSha})` : "(none: the first commit)"}; it starts at ${record.base ?? "the first commit"}`);
  } else if (record.base ? !tagCommits.has(record.base) : baseTag({ version, tags }) !== null) {
    fail(`a beta record starts at the release npm's beta tag selected; ${record.base ?? "the first commit"} is no release tag`);
  }
  const history = historyRange(root, { base: record.base, target: finalSha });
  const listed = [...record.rows.keys()];
  const expected = history.prs.map((pr) => pr.number);
  const missing = expected.filter((number) => !listed.includes(number));
  const extra = listed.filter((number) => !expected.includes(number));
  if (missing.length || extra.length) {
    fail(`the record does not match ${tagCommits.get(record.base) ?? record.base ?? "the first commit"}..${finalTarget}: missing ${missing.map((n) => `#${n}`).join(", ") || "none"}; not in range ${extra.map((n) => `#${n}`).join(", ") || "none"}`);
  }
  const subjects = new Map(history.prs.map((pr) => [pr.number, pr]));
  for (const heading of PROSE) {
    for (const line of bullets(blocks.find((block) => block.heading === heading))) {
      if (/@undefined\b/i.test(line)) errors.push(`invalid @undefined credit: "${line}"`);
      for (const number of references(line)) {
        if (subjects.has(number)) {
          if (!subjects.get(number).editorial) errors.push(`PR #${number} (${subjects.get(number).type ?? "no type"}) belongs only in the record, not in "### ${heading}"`);
          continue;
        }
        const found = github(`repos/${REPOSITORY}/issues/${number}`);
        if (!found) errors.push(`#${number} in "### ${heading}" does not resolve in ${REPOSITORY}`);
        else if (found.pull_request) errors.push(`PR #${number} in "### ${heading}" is outside the release range`);
      }
    }
  }
  for (const number of listed) {
    const want = recordRow(number, creditFor(github, number));
    const have = recordRow(number, record.rows.get(number));
    if (want !== have) errors.push(`the record row is "${have}"; GitHub gives "${want}"`);
  }
  if (errors.length) fail(errors.join("\n  "));
  return { finalTarget, count: listed.length };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args, name) {
  const value = option(args, name);
  if (!value) throw new ChangelogError(`${name} is required`);
  return value;
}

function writeIndex(root) {
  const versions = listVersions(root);
  writeFileSync(join(root, "CHANGELOG.md"), renderIndex(versions));
  const pages = versions.filter(hasDocsPage);
  if (pages.length) mkdirSync(join(root, DOCS_RELEASES), { recursive: true });
  for (const version of pages) {
    writeFileSync(join(root, DOCS_RELEASES, `${version}.md`), renderDocsPage(version, readSection(root, version)));
  }
  return pages.map((version) => `${DOCS_RELEASES}/${version}.md`);
}

// `request` and `npm` stand in for `gh api` and `npm view` in tests.
export function main(argv, root = resolve(import.meta.dirname, "../.."), { request, npm } = {}) {
  const [command, ...args] = argv;
  const github = () => githubClient(root, { refresh: args.includes("--refresh-github-snapshot"), request });
  if (command === "draft") {
    const version = parseVersion(required(args, "--version")).version;
    const target = option(args, "--target") ?? "HEAD";
    const base = resolveBase(root, { version, base: option(args, "--base"), target, npm });
    const history = historyRange(root, { base, target });
    const client = github();
    const credits = new Map(history.prs.map((pr) => [pr.number, creditFor(client, pr.number)]));
    const manifest = option(args, "--manifest");
    if (manifest) {
      const inventory = {
        schemaVersion: 1,
        version,
        baseRef: base ?? null,
        base: history.base,
        target: history.target,
        pullRequests: history.prs.map((pr) => ({ number: pr.number, title: pr.title, type: pr.type, editorial: pr.editorial, section: pr.section, ...credits.get(pr.number) })),
        directCommits: history.direct,
        shippedByBase: history.shipped,
      };
      writeFileSync(isAbsolute(manifest) ? manifest : resolve(manifest), `${JSON.stringify(inventory, null, 2)}\n`);
    }
    return renderSection({ version, base: history.base, target: history.target, prs: history.prs, credits });
  }
  if (command === "write") {
    const version = parseVersion(required(args, "--version")).version;
    const text = readFileSync(required(args, "--file"), "utf8");
    checkSection(`${version}.md`, text);
    mkdirSync(join(root, "CHANGELOG", "records"), { recursive: true });
    writeFileSync(join(root, "CHANGELOG", `${version}.md`), text);
    writeFileSync(join(root, "CHANGELOG", "records", `${version}.md`), renderRecordFile(version, text));
    const pages = writeIndex(root).filter((page) => page.endsWith(`/${version}.md`));
    return [`CHANGELOG/${version}.md`, `CHANGELOG/records/${version}.md`, ...pages, ""].join("\n");
  }
  if (command === "read") return readSection(root, parseVersion(required(args, "--version")).version, { record: args.includes("--record") });
  if (command === "notes") {
    const version = parseVersion(required(args, "--version")).version;
    return releaseNotes(readSection(root, version), version);
  }
  if (command === "verify") {
    const version = parseVersion(required(args, "--version")).version;
    const client = github();
    if (args.includes("--check-github")) {
      const tag = option(args, "--release-tag") ?? `v${version}`;
      const bodyFile = option(args, "--body-file");
      const release = bodyFile ? { body: readFileSync(bodyFile, "utf8").replace(/\n$/, "") } : client(`repos/${REPOSITORY}/releases/tags/${tag}`, { live: true });
      if (!release) throw new ChangelogError(`GitHub has no release ${tag}`);
      if (args.includes("--post-docs")) {
        const want = renderThanksBody({ version, ...rosterFor(root, client, version), verification: verificationTail(release.body) });
        const normal = (text) => String(text ?? "").replace(/\r\n/g, "\n").trimEnd();
        if (normal(release.body) !== normal(want)) throw new ChangelogError(`${tag}: the GitHub Release body is not the roster body. Fix: node scripts/release/changelog.mjs thanks --version ${version} > body.md && gh release edit ${tag} --notes-file body.md`);
        return `the ${tag} GitHub Release body is the roster body of CHANGELOG/${version}.md\n`;
      }
      const error = checkReleaseBody(release.body, releaseNotes(readSection(root, version), version));
      if (error) throw new ChangelogError(`${tag}: ${error}. Fix: node scripts/release/changelog.mjs notes --version ${version} > notes.md && gh release edit ${tag} --notes-file notes.md`);
      return `the ${tag} GitHub Release body is CHANGELOG/${version}.md\n`;
    }
    const { finalTarget, count: listed } = verifySection(root, { version, target: option(args, "--target"), github: client });
    return `CHANGELOG/${version}.md lists the ${listed} pull requests through ${finalTarget}, with GitHub's credit\n`;
  }
  if (command === "index") {
    return ["CHANGELOG.md", ...writeIndex(root), ""].join("\n");
  }
  if (command === "thanks") {
    const version = parseVersion(required(args, "--version")).version;
    const client = github();
    const tag = option(args, "--release-tag") ?? `v${version}`;
    const release = client(`repos/${REPOSITORY}/releases/tags/${tag}`, { live: true });
    if (!release) throw new ChangelogError(`GitHub has no release ${tag}`);
    return renderThanksBody({ version, ...rosterFor(root, client, version), verification: verificationTail(release.body) });
  }
  if (command === "check") {
    const { versions } = checkChangelog(root);
    return `CHANGELOG.md, CHANGELOG/records/ and ${versions.length + 1} files in CHANGELOG/ follow the rules\n`;
  }
  throw new ChangelogError("usage: changelog.mjs draft|write|read|notes|verify|index|thanks|check (see the header of this file)");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const out = main(process.argv.slice(2));
    const file = process.argv[2] === "draft" ? option(process.argv, "--output") : undefined;
    if (file) writeFileSync(file, out);
    else process.stdout.write(out);
  } catch (error) {
    console.error(error instanceof ChangelogError ? error.message : error);
    process.exit(1);
  }
}
