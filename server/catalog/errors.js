// Typed catalogue errors: { code, path, message }, plus the HTTP status the
// API answers with. Codes are stable names: UNIT_MISMATCH, UNKNOWN_REF,
// VERSION_CONFLICT, ... so the API, CLI and MCP report the same thing.
const STATUS_BY_CODE = Object.freeze({
  NOT_FOUND: 404,
  UNKNOWN_REF: 400,
  VERSION_CONFLICT: 409,
  CODE_CONFLICT: 409,
  CODE_READ_ONLY: 400,
  NAME_CONFLICT: 409,
  CATEGORY_CONFLICT: 409,
  CYCLE: 409,
  UNIT_MISMATCH: 400,
  UNKNOWN_UNIT: 400,
  INVALID: 400,
  INVALID_QUANTITY: 400,
  INVALID_EXPRESSION: 400,
  INVALID_ASSEMBLY: 400,
  PRICING_BASIS: 400,
  IN_USE: 409,
  FUTURE_PRICE_UNSUPPORTED: 400,
  PENDING_PRICE_CHANGE: 409,
});

export class CatalogError extends Error {
  constructor(code, message, { path = null, status = null, details = null } = {}) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
    this.path = path;
    this.statusCode = status || STATUS_BY_CODE[code] || 400;
    if (details) this.details = details;
  }

  toJSON() {
    return { code: this.code, path: this.path, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

/**
 * Thrown when a create/rename/reactivate would give two ACTIVE items the same
 * name key. `conflict` names the item already holding it.
 */
export class CatalogNameConflictError extends CatalogError {
  constructor(message, conflict) {
    super("NAME_CONFLICT", message, { path: "name" });
    this.name = "CatalogNameConflictError";
    this.conflict = conflict;
  }
}

export function notFound(message = "not found") {
  return new CatalogError("NOT_FOUND", message);
}
