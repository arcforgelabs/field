// How the job page names a quote's versions: by what happened to each one
// (draft, sent, superseded), not by its number. A single version needs no
// list, so the rail shows versions only once a quote has been revised.
import type { QuoteVersion } from "@/lib/types";
import { shortDate } from "@/lib/job-status";

export interface VersionRow {
  version: number;
  /** What it is: "Draft", "Sent", "Superseded" or "Earlier draft". */
  state: string;
  /** The detail beside it: "Editing", "11 Oct" or "Sent 3 Oct". */
  detail: string;
  /** The same as a phrase, for notices: "the quote sent on 3 Oct". */
  phrase: string;
}

/** Newest first. Empty when there's only one version, since there's nothing to compare. */
export function describeVersions(versions: QuoteVersion[], lastSentVersion: number | null | undefined): VersionRow[] {
  if (versions.length < 2) return [];
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const latest = sorted[0].version;
  const wasSent = (item: QuoteVersion) => item.status === "final" || item.version === lastSentVersion;
  const newestSent = lastSentVersion ?? sorted.find(wasSent)?.version ?? null;
  return sorted.map((item) => {
    const date = shortDate(item.createdAt);
    if (wasSent(item)) {
      return item.version === newestSent
        ? { version: item.version, state: "Sent", detail: date, phrase: `the quote sent on ${date}` }
        : { version: item.version, state: "Superseded", detail: `Sent ${date}`, phrase: `the quote sent on ${date}, since revised` };
    }
    return item.version === latest
      ? { version: item.version, state: "Draft", detail: "Editing", phrase: "the draft revision" }
      : { version: item.version, state: "Earlier draft", detail: date, phrase: `an earlier draft from ${date}` };
  });
}
