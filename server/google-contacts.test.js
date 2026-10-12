import test from "node:test";
import assert from "node:assert/strict";
import {
  googleContactsHttpError,
  listGoogleContacts,
  normalizeGoogleContacts,
} from "./google-contacts.js";

test("Google contacts normalize names, deduplicate emails, and discard unusable entries", () => {
  assert.deepEqual(normalizeGoogleContacts([
    {
      names: [{ displayName: "Zoe Client" }],
      emailAddresses: [{ value: "ZOE@EXAMPLE.COM" }, { value: "invalid" }],
    },
    {
      names: [{ displayName: "Alex Builder" }],
      emailAddresses: [{ value: "alex@example.com" }, { value: "zoe@example.com" }],
    },
    { emailAddresses: [{ value: "office@example.com" }] },
  ]), [
    { name: "Alex Builder", email: "alex@example.com" },
    { name: "office@example.com", email: "office@example.com" },
    { name: "Zoe Client", email: "zoe@example.com" },
  ]);
});

test("Google contacts follow People API pagination", async () => {
  const calls = [];
  const peopleClient = {
    people: {
      connections: {
        async list(args) {
          calls.push(args);
          if (!args.pageToken) {
            return { data: { connections: [{ names: [{ displayName: "A" }], emailAddresses: [{ value: "a@example.com" }] }], nextPageToken: "next" } };
          }
          return { data: { connections: [{ names: [{ displayName: "B" }], emailAddresses: [{ value: "b@example.com" }] }] } };
        },
      },
    },
  };

  const contacts = await listGoogleContacts({ peopleClient });
  assert.equal(calls.length, 2);
  assert.deepEqual(contacts.map((contact) => contact.email), ["a@example.com", "b@example.com"]);
});

test("Google contacts maps missing delegated scope to an actionable response", () => {
  assert.deepEqual(googleContactsHttpError({
    response: { status: 403, data: { error: { message: "unauthorized_client" } } },
  }), {
    statusCode: 403,
    code: "google_contacts_authorization_required",
    message: "Google Contacts access needs to be approved for this Field account.",
  });
});

test("Google contacts preserves the unconfigured error contract", () => {
  assert.deepEqual(googleContactsHttpError(Object.assign(
    new Error("Google Contacts is not configured for this Field user."),
    { statusCode: 503, code: "google_contacts_unconfigured" },
  )), {
    statusCode: 503,
    code: "google_contacts_unconfigured",
    message: "Google Contacts is not configured for this Field user.",
  });
});
