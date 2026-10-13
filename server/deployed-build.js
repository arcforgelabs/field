// What build is running, for GET /health: the git commit (FIELD_REVISION),
// and on a Replit deployment the ref it was fetched as and where it came from
// ("github", or "workspace" for an emergency build), and whether its GitHub CI
// passed before it was built ("passed", or "unchecked" when an emergency
// override built it anyway), which scripts/replit-deploy.sh sets. The
// repository is public, so none of these is a secret. Each is null when
// unknown.
export function deployedBuildStatus(env = process.env) {
  const read = (value) => String(value ?? "").trim() || null;
  return {
    revision: read(env.FIELD_REVISION),
    ref: read(env.FIELD_DEPLOYED_REF),
    source: read(env.FIELD_DEPLOYED_FROM),
    checks: read(env.FIELD_DEPLOYED_CHECKS),
  };
}
