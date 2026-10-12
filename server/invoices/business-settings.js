// The organisation's business settings (business_settings, migration 0016;
// #28, step 4b). One row per organisation; none means every default.
//
// creditNoteOnReissue: when an invoice that was returned to draft (unsent,
// or marked unpaid) is issued again with different content, whether the
// issue service first credits the earlier invoice with a credit note:
//
//   when-emailed  (default) only when Field has evidence the customer was
//                 sent it: an `emailed` event on its issued document, or a
//                 delivered send record (a `sent` quote snapshot of it)
//   always        every time
//   never         never: the earlier invoice stays void
//
// "Credit and reissue" always credits, whatever this says: that action is
// the operator saying the customer has the invoice.
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";

const { businessSettings, CREDIT_NOTE_ON_REISSUE } = schema;

export const DEFAULT_CREDIT_NOTE_ON_REISSUE = "when-emailed";

/** The three choices, with the one sentence Settings shows for each. */
export const CREDIT_NOTE_ON_REISSUE_CHOICES = Object.freeze([
  {
    value: "when-emailed",
    label: "Only if it was emailed",
    description: "Field credits the old invoice when it emailed it to the customer; an invoice the customer never received is reissued under a new number. Recommended.",
  },
  {
    value: "always",
    label: "Always",
    description: "Field credits the old invoice every time, even if it never left Field.",
  },
  {
    value: "never",
    label: "Never",
    description: "Field never credits it: the old invoice stays void and the new one takes a new number.",
  },
]);

export class BusinessSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = "BusinessSettingsError";
    this.code = "BUSINESS_SETTINGS_INVALID";
    this.statusCode = 400;
  }
}

/** The setting, inside the caller's organisation transaction. */
export async function readCreditNoteOnReissue(tx) {
  const [row] = await tx.select({ value: businessSettings.creditNoteOnReissue }).from(businessSettings);
  return row?.value || DEFAULT_CREDIT_NOTE_ON_REISSUE;
}

function settingsFromRow(row) {
  return {
    creditNoteOnReissue: row?.creditNoteOnReissue || DEFAULT_CREDIT_NOTE_ON_REISSUE,
    updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    updatedBy: row?.updatedBy || null,
  };
}

export function createBusinessSettingsService({ db, orgUid = undefined, now = () => new Date() }) {
  if (!db) throw new Error("createBusinessSettingsService needs a database");
  const scope = db.isOrgScope ? db : orgScope(db, orgUid);
  return {
    async get() {
      return scope.transaction(async (tx) => settingsFromRow((await tx.select().from(businessSettings))[0]));
    },
    async update({ creditNoteOnReissue }, { actor = null } = {}) {
      if (!CREDIT_NOTE_ON_REISSUE.includes(creditNoteOnReissue)) {
        throw new BusinessSettingsError(`creditNoteOnReissue must be one of ${CREDIT_NOTE_ON_REISSUE.join(", ")}`);
      }
      return scope.transaction(async (tx) => {
        const at = now();
        const [row] = await tx.insert(businessSettings)
          .values({ creditNoteOnReissue, createdAt: at, updatedAt: at, updatedBy: actor })
          .onConflictDoUpdate({ target: businessSettings.orgUid, set: { creditNoteOnReissue, updatedAt: at, updatedBy: actor } })
          .returning();
        return settingsFromRow(row);
      });
    },
  };
}
