export function resolveDatabaseTestMode({ databaseUrl, dockerRequested } = {}) {
  const normalizedDatabaseUrl = typeof databaseUrl === "string" ? databaseUrl.trim() : "";
  const wantsDocker = dockerRequested === true || dockerRequested === "1";

  if (normalizedDatabaseUrl && wantsDocker) {
    throw new Error(
      "FIELD_DB_TEST_DATABASE_URL and FIELD_DB_TEST_DOCKER=1 cannot be used together; choose URL-only or Docker-only test mode",
    );
  }

  if (normalizedDatabaseUrl) {
    return { kind: "url", databaseUrl: normalizedDatabaseUrl };
  }
  if (wantsDocker) {
    return { kind: "docker", databaseUrl: "" };
  }
  return { kind: "none", databaseUrl: "" };
}
