export const SEALED_VALUE: RegExp;
export const KEY_ID: RegExp;
export function generateSecretsKey(): { bytes: Uint8Array; text: string };
export function secretsKeyIdOf(keyBytes: Uint8Array): Promise<string>;
export function sealForServer(input: { keyBytes: Uint8Array; orgUid: string; integration: string; values: Record<string, string> }): Promise<{ keyId: string; values: Record<string, string> }>;
export function isWellFormedSealed(value: unknown, keyId?: string | null): boolean;
export function wipe(bytes: Uint8Array | null | undefined): void;
