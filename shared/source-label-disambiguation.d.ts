export interface DisambiguatedSourceLabel {
  baseLabel: string;
  sectionLabel: string | null;
  disambiguationSuffix: string | null;
  displayLabel: string;
}

export function extractSectionFromScopedLineItemCode(
  code: string | null | undefined
): string | null;

export function buildDisambiguatedSourceLabels<T>(
  items?: T[],
  options?: {
    getLabel?: (item: T) => string | null | undefined;
    getSection?: (item: T) => string | null | undefined;
    getCode?: (item: T) => string | null | undefined;
    fallbackLabel?: string;
  }
): DisambiguatedSourceLabel[];
