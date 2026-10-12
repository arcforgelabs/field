export function scrubText<T>(value: T, max?: number): T;

export function scrubValue<T>(value: T, depth?: number): T;

export function scrubBreadcrumb<T>(breadcrumb: T): T | null;

export function scrubEvent<T>(event: T): T;

export function createEventThrottle(options?: {
  windowMs?: number;
  maxPerWindow?: number;
  now?: () => number;
}): <T>(event: T) => T | null;

export function scrubLog<T>(log: T): T;
