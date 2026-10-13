export type Region = { country: string | null; region: string | null };
export declare const AU_REGIONS: ReadonlyArray<{ code: string; name: string }>;
export declare const KNOWN_REGIONS: Readonly<Record<string, ReadonlyArray<{ code: string; name: string }>>>;
export declare function regionFromAddress(address: unknown): Region;
export declare function normalizeCountryCode(value: unknown): string | null;
export declare function normalizeRegionCode(value: unknown): string | null;
export declare function describeRegion(region?: Partial<Region>): string;
