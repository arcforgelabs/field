/* Verification reset only: deterministic clock, UUID, and nonce source. */
const crypto = require("node:crypto");
const { createHash } = crypto;
const { syncBuiltinESMExports } = require("node:module");

if (process.env.FIELD_VERIFICATION_DETERMINISTIC !== "1") {
  throw new Error("deterministic verification preload requires FIELD_VERIFICATION_DETERMINISTIC=1");
}

const FIXED_NOW = "2026-01-15T12:00:00.000Z";
let sequence = 0;
function nextBytes(size) {
  const value = createHash("sha256").update(`field-verification-nonce:${sequence++}`).digest();
  const output = Buffer.alloc(Number(size));
  for (let index = 0; index < output.length; index += 1) output[index] = value[index % value.length];
  return output;
}
function deterministicUuid() {
  const bytes = nextBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
crypto.randomUUID = deterministicUuid;
crypto.randomBytes = (size, callback) => {
  const bytes = nextBytes(size);
  if (typeof callback === "function") queueMicrotask(() => callback(null, bytes));
  return callback ? undefined : bytes;
};
syncBuiltinESMExports();

const NativeDate = Date;
global.Date = class VerificationDate extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : [FIXED_NOW]));
  }

  static now() {
    return NativeDate.parse(FIXED_NOW);
  }
};
