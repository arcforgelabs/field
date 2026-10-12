import { google } from "googleapis";
import {
  googleServiceAccountCacheId,
  hasGoogleServiceAccountKey,
  loadGoogleServiceAccountCredentials,
} from "./google-service-account.js";
import {
  resolveGmailDelegatedUser,
  resolveGmailLoginHint,
  resolveGmailOAuthConfig,
} from "./send-quote-email.js";

export const GOOGLE_CONTACTS_READONLY_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
const CONTACTS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CONTACTS = 2_000;
const contactsCache = new Map();

export function resetGoogleContactsCache() {
  contactsCache.clear();
}

export async function listGoogleContacts({ config = {}, user = null, peopleClient = null } = {}) {
  const resolved = peopleClient
    ? { people: peopleClient, cacheKey: null, accountEmail: "" }
    : resolveGoogleContactsClient(config, { user });
  if (!resolved?.people) {
    const error = new Error("Google Contacts is not configured for this Field user.");
    error.statusCode = 503;
    error.code = "google_contacts_unconfigured";
    throw error;
  }

  const cached = resolved.cacheKey ? contactsCache.get(resolved.cacheKey) : null;
  if (cached && cached.expiresAt > Date.now()) return cached.contacts;

  const connections = [];
  let pageToken;
  do {
    const response = await resolved.people.people.connections.list({
      resourceName: "people/me",
      personFields: "names,emailAddresses",
      pageSize: Math.min(1_000, MAX_CONTACTS - connections.length),
      pageToken,
      sortOrder: "LAST_NAME_ASCENDING",
    });
    connections.push(...(response.data.connections || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken && connections.length < MAX_CONTACTS);

  const contacts = normalizeGoogleContacts(connections).slice(0, MAX_CONTACTS);
  if (resolved.cacheKey) {
    contactsCache.set(resolved.cacheKey, {
      contacts,
      expiresAt: Date.now() + CONTACTS_CACHE_TTL_MS,
    });
  }
  return contacts;
}

export function normalizeGoogleContacts(connections = []) {
  const byEmail = new Map();
  for (const person of connections) {
    const name = String(person?.names?.find((item) => item?.displayName)?.displayName || "").trim();
    for (const entry of person?.emailAddresses || []) {
      const email = String(entry?.value || "").trim().toLowerCase();
      if (!isEmail(email) || byEmail.has(email)) continue;
      byEmail.set(email, { name: name || email, email });
    }
  }
  return [...byEmail.values()].sort((a, b) => (
    a.name.localeCompare(b.name, "en-AU", { sensitivity: "base" })
      || a.email.localeCompare(b.email, "en-AU", { sensitivity: "base" })
  ));
}

export function googleContactsHttpError(error) {
  if (error?.code === "google_contacts_unconfigured") {
    return {
      statusCode: 503,
      code: error.code,
      message: error.message,
    };
  }
  const status = Number(error?.response?.status || error?.code || error?.statusCode || 500);
  const providerMessage = String(error?.response?.data?.error?.message || error?.message || "");
  if (status === 401 || status === 403 || /unauthorized_client|insufficient.*scope/i.test(providerMessage)) {
    return {
      statusCode: 403,
      code: "google_contacts_authorization_required",
      message: "Google Contacts access needs to be approved for this Field account.",
    };
  }
  return {
    statusCode: status >= 400 && status < 600 ? status : 502,
    code: "google_contacts_unavailable",
    message: "Google Contacts is temporarily unavailable.",
  };
}

function resolveGoogleContactsClient(config, { user }) {
  const delegatedUser = resolveGmailDelegatedUser(config, { user });
  if (hasGoogleServiceAccountKey(config) && delegatedUser) {
    const key = loadGoogleServiceAccountCredentials(config);
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      subject: delegatedUser,
    });
    return {
      people: google.people({ version: "v1", auth }),
      accountEmail: delegatedUser,
      cacheKey: `service:${delegatedUser}:${googleServiceAccountCacheId(config)}`,
    };
  }

  const oauth = resolveGmailOAuthConfig(config, { user });
  if (!oauth.clientId || !oauth.clientSecret || !oauth.refreshToken) return null;
  const auth = new google.auth.OAuth2(oauth.clientId, oauth.clientSecret);
  auth.setCredentials({ refresh_token: oauth.refreshToken });
  const accountEmail = String(oauth.consentEmail || resolveGmailLoginHint(config, { user }) || "").trim().toLowerCase();
  return {
    people: google.people({ version: "v1", auth }),
    accountEmail,
    cacheKey: `oauth:${accountEmail}:${String(oauth.refreshToken).slice(-12)}`,
  };
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
