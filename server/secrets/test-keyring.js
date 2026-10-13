// Keys for tests (#112): fixed, made at runtime, never real. Not a test file.
import { loadSecretsKeyring } from "./keyring.js";

export const TEST_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
export const OTHER_SECRETS_KEY = Buffer.alloc(32, 9).toString("base64");

export function testKeyring(env = {}) {
  return loadSecretsKeyring({ FIELD_SECRETS_KEY: TEST_SECRETS_KEY, ...env });
}
