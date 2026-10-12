// Offline stand-in for `googleapis` used by the quote/invoice proof harness.
// Gmail sends are captured to $FIELD_PROOF_MAIL_DIR instead of leaving the box.
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const mailDir = process.env.FIELD_PROOF_MAIL_DIR;
if (!mailDir) throw new Error("FIELD_PROOF_MAIL_DIR is required for the fake googleapis module");
mkdirSync(mailDir, { recursive: true });

function nextIndex() {
  return readdirSync(mailDir).filter((name) => name.endsWith(".eml")).length + 1;
}

class FakeAuth {
  constructor(...args) { this.args = args; }
  setCredentials() {}
  generateAuthUrl() { return "https://accounts.example.invalid/o/oauth2/auth"; }
  async getToken() { throw new Error("fake googleapis: OAuth token exchange is not available"); }
  async authorize() { return {}; }
}

const gmailUsers = {
  async getProfile() { return { data: { emailAddress: "proof.sender@example.invalid" } }; },
  messages: {
    async send({ requestBody }) {
      const index = nextIndex();
      const raw = Buffer.from(String(requestBody.raw), "base64url");
      writeFileSync(join(mailDir, `${String(index).padStart(3, "0")}.eml`), raw);
      return { data: { id: `proof-message-${index}`, threadId: `proof-thread-${index}` } };
    },
    async list() { return { data: { messages: [] } }; },
  },
};

export const google = {
  auth: { JWT: FakeAuth, OAuth2: FakeAuth, GoogleAuth: FakeAuth },
  gmail: () => ({ users: gmailUsers }),
  drive: () => { throw new Error("fake googleapis: Drive is not available in the proof harness"); },
  people: () => { throw new Error("fake googleapis: People is not available in the proof harness"); },
};
export default { google };
