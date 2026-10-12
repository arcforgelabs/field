import type {
  QuotePresentationComponent,
  QuotePresentationOrganizer,
  QuotePresentationOrganizerSourceNode,
  QuotePresentationScheduleItem,
} from "../client/src/lib/types";

export function isTrivialSelfPresentationComponent(args: {
  sourceItem?: QuotePresentationScheduleItem | null;
  component?: QuotePresentationComponent | null;
}): boolean;

export function getMeaningfulPresentationSourceComponents(
  sourceItem?: QuotePresentationScheduleItem | null
): QuotePresentationComponent[];

export function getPresentationRootComponentCodes(
  node: QuotePresentationOrganizerSourceNode | null | undefined,
  components: QuotePresentationComponent[]
): string[];

export function findPresentationComponentParent(
  node: QuotePresentationOrganizerSourceNode | null | undefined,
  componentCode: string
): string | null;

export function isPresentationComponentDescendant(
  node: QuotePresentationOrganizerSourceNode | null | undefined,
  ancestorCode: string,
  candidateCode: string
): boolean;

export function getOrderedPresentationComponents(args: {
  node: QuotePresentationOrganizerSourceNode;
  sourceItem?: QuotePresentationScheduleItem | null;
}): QuotePresentationComponent[];

export function buildGeneratedPresentationSourceNodeId(
  sourceCode: string,
  componentCode: string
): string | null;

export function materializePresentationOrganizerGeneratedNodes(args: {
  organizer: QuotePresentationOrganizer;
  sourceItems: QuotePresentationScheduleItem[];
}): QuotePresentationOrganizer;

export function calculatePresentationScheduleTotals(args: {
  organizer: QuotePresentationOrganizer | null | undefined;
  sourceItems: QuotePresentationScheduleItem[];
}): {
  charge: number;
  cost: number;
};

export function buildRenderedPresentationScheduleItems(args: {
  organizer: QuotePresentationOrganizer;
  sourceItems: QuotePresentationScheduleItem[];
  includeCollapsedChildren?: boolean;
}): QuotePresentationScheduleItem[];

export function collectOrganizerSubtreeNodeIds(
  organizer: QuotePresentationOrganizer | null | undefined,
  rootNodeId: string
): string[];

export function organizerSubtreeHasOverride(
  organizer: QuotePresentationOrganizer | null | undefined,
  rootNodeId: string
): boolean;
