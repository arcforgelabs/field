import { reset, verify } from "./reset.js";

const VERIFICATION_ENV = "field-verification";

function restoreEnv(env, name, value) {
  if (value === undefined) delete env[name];
  else env[name] = value;
}

export async function ensureVerificationFixtureState({
  env = process.env,
  verifyState = () => verify(),
  resetState = () => reset(),
  logger = console,
} = {}) {
  if (env.FIELD_ENV !== VERIFICATION_ENV) return { verificationRuntime: false, reset: false };

  try {
    const marker = await verifyState();
    return { verificationRuntime: true, reset: false, marker: marker?.marker || null };
  } catch (error) {
    logger.warn(`[field-verification-start] fixture state is stale or invalid; rebuilding the isolated synthetic state: ${error.message}`);
  }

  const previousDeterministic = env.FIELD_VERIFICATION_DETERMINISTIC;
  const previousPrebackup = env.FIELD_RESET_PREBACKUP;
  env.FIELD_VERIFICATION_DETERMINISTIC = "1";
  // The promotion controller snapshots the candidate data root before starting
  // the image. Do not create a second container-owned backup inside that root.
  env.FIELD_RESET_PREBACKUP = "host";
  try {
    await resetState();
    const marker = await verifyState();
    return { verificationRuntime: true, reset: true, marker: marker?.marker || null };
  } finally {
    restoreEnv(env, "FIELD_VERIFICATION_DETERMINISTIC", previousDeterministic);
    restoreEnv(env, "FIELD_RESET_PREBACKUP", previousPrebackup);
  }
}
