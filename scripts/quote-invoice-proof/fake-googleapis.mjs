// Offline stand-in for `googleapis` used by the quote/invoice proof harness.
// Gmail sends are captured to $FIELD_PROOF_MAIL_DIR instead of leaving the box.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mailDir = process.env.FIELD_PROOF_MAIL_DIR;
if (!mailDir) throw new Error("FIELD_PROOF_MAIL_DIR is required for the fake googleapis module");
mkdirSync(mailDir, { recursive: true });

function nextIndex() {
  return readdirSync(mailDir).filter((name) => name.endsWith(".eml")).length + 1;
}

// A test can make the next send fail the way Gmail or the network does, by
// writing next-send-failure.json in the mail directory (used once):
//   { "mode": "timeout" | "reset" | "status", "status": 400, "deliver": true }
// "deliver" captures the message first: Gmail took it, but Field never heard.
const FAILURE_FILE = join(mailDir, "next-send-failure.json");
function takeFailure() {
  if (!existsSync(FAILURE_FILE)) return null;
  const failure = JSON.parse(readFileSync(FAILURE_FILE, "utf8"));
  rmSync(FAILURE_FILE, { force: true });
  return failure;
}
function failureError(failure) {
  if (failure.mode === "timeout") return Object.assign(new Error("network timeout at: https://gmail.googleapis.com/gmail/v1/users/me/messages/send"), { code: "ETIMEDOUT" });
  if (failure.mode === "reset") return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const status = Number(failure.status) || 400;
  return Object.assign(new Error(failure.message || "Invalid To header"), { status, response: { status } });
}

class FakeAuth {
  // A service-account client acts as its `subject` (the delegated mailbox).
  constructor(...args) { this.args = args; this.subject = args[0]?.subject || null; }
  setCredentials() {}
  generateAuthUrl() { return "https://accounts.example.invalid/o/oauth2/auth"; }
  async getToken() { throw new Error("fake googleapis: OAuth token exchange is not available"); }
  async authorize() { return {}; }
}

// Each captured message's mailbox, so Sent Mail search sees only the
// mailbox it is asked as (kept in memory: the mail directory holds only .eml).
const DEFAULT_MAILBOX = "proof.sender@example.invalid";
const mailboxOf = new Map();

const gmailUsersFor = (mailbox) => ({
  async getProfile() { return { data: { emailAddress: mailbox } }; },
  messages: {
    // The JSON form (requestBody.raw) and, for messages over about 4 MB, the
    // media upload form (media.body, message/rfc822) Field uses for them.
    async send({ requestBody, media }) {
      const failure = takeFailure();
      if (failure && !failure.deliver) throw failureError(failure);
      const index = nextIndex();
      const raw = media?.body ? Buffer.from(media.body) : Buffer.from(String(requestBody.raw), "base64url");
      const name = `${String(index).padStart(3, "0")}.eml`;
      writeFileSync(join(mailDir, name), raw);
      mailboxOf.set(name, mailbox);
      if (failure) throw failureError(failure);
      return { data: { id: `proof-message-${index}`, threadId: `proof-thread-${index}` } };
    },
    // Sent Mail search by Message-ID (q: "in:sent rfc822msgid:<...>").
    async list({ q = "" } = {}) {
      const wanted = String(q).match(/rfc822msgid:(\S+)/)?.[1];
      if (!wanted) return { data: { messages: [] } };
      const messages = readdirSync(mailDir).filter((name) => name.endsWith(".eml")).sort()
        .filter((name) => (mailboxOf.get(name) || DEFAULT_MAILBOX) === mailbox)
        .filter((name) => readFileSync(join(mailDir, name), "latin1").includes(`\r\nMessage-ID: ${wanted}\r\n`))
        .map((name) => {
          const index = Number.parseInt(name, 10);
          return { id: `proof-message-${index}`, threadId: `proof-thread-${index}` };
        });
      return { data: { messages } };
    },
  },
});

export const google = {
  auth: { JWT: FakeAuth, OAuth2: FakeAuth, GoogleAuth: FakeAuth },
  gmail: ({ auth } = {}) => ({ users: gmailUsersFor(auth?.subject || DEFAULT_MAILBOX) }),
  drive: () => { throw new Error("fake googleapis: Drive is not available in the proof harness"); },
  people: () => { throw new Error("fake googleapis: People is not available in the proof harness"); },
};
export default { google };
