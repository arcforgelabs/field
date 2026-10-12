// A data migration that refuses to run: its verification failed, or what it
// planned changed underneath it. Nothing it guards has been written.
export class DataMigrationError extends Error {
  constructor(message, { details = null } = {}) {
    super(message);
    this.name = "DataMigrationError";
    this.code = "DATA_MIGRATION_FAILED";
    if (details) this.details = details;
  }
}
