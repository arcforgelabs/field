#!/usr/bin/env python3
"""Fail when a pull request body is missing the required sections.

The body must contain authored text under all four headings, in any order
(.github/pull_request_template.md lists them). HTML comments
and placeholder lines do not count. Maintainer authorship does not skip this.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REQUIRED = (
    "What Problem This Solves",
    "User Impact",
    "Why This Change Was Made",
    "Evidence",
)

PLACEHOLDER = re.compile(
    r"^(?:n/?a|none|not applicable|tbd|todo|unknown|unsure|none provided|"
    r"no evidence|not tested|untested|did not test|didn't test|"
    r"could not test|couldn't test|-|(?:-{3,}|\*{3,}|_{3,})|\[[^\]]*\])\.?$",
    re.IGNORECASE,
)
HEADING = re.compile(r"^#{2,6}[ \t]+(.+?)[ \t]*$", re.MULTILINE)
COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)


def section_text(body: str) -> dict[str, str]:
    text = COMMENT.sub("", body or "")
    matches = list(HEADING.finditer(text))
    found: dict[str, str] = {}
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        found[match.group(1).strip()] = text[start:end].strip()
    return found


def is_placeholder(value: str) -> bool:
    collapsed = re.sub(r"\s+", " ", value).strip()
    if not collapsed:
        return True
    return PLACEHOLDER.fullmatch(collapsed) is not None


def missing_sections(body: str) -> list[str]:
    found = section_text(body)
    return [name for name in REQUIRED if is_placeholder(found.get(name, ""))]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: pr-context-check.py BODY_FILE", file=sys.stderr)
        return 2
    body = Path(argv[1]).read_text(encoding="utf-8")
    missing = missing_sections(body)
    if missing:
        print("Pull request body is missing authored sections:")
        for name in missing:
            print(f"- {name}")
        print("Write them in the pull request body. A comment thread does not replace the body.")
        return 1
    print("Pull request body includes problem, impact, why, and evidence.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
