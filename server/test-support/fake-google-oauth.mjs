// Preload (node --import) for tests that boot the real server: `googleapis`
// becomes an offline fake whose OAuth client exchanges any code, and Google's
// tokeninfo answers with FAKE_GOOGLE_EMAIL. The code "fail" makes the
// exchange throw with FAKE_GOOGLE_ERROR as its message.
import { registerHooks } from "node:module";

const fakeModule = `
class OAuth2 {
  constructor(clientId, clientSecret, redirectUri) { this.redirectUri = redirectUri; }
  generateAuthUrl(options) {
    const url = new URL("https://accounts.example.invalid/o/oauth2/auth");
    url.searchParams.set("state", options.state);
    url.searchParams.set("redirect_uri", this.redirectUri);
    return url.href;
  }
  async getToken(code) {
    if (code === "fail") throw new Error(process.env.FAKE_GOOGLE_ERROR || "invalid_grant");
    return { tokens: { access_token: "fake-access-" + code, refresh_token: "fake-refresh-" + code } };
  }
  setCredentials(tokens) { this.tokens = tokens; }
  async getAccessToken() { return { token: this.tokens?.access_token || null }; }
}
class Unavailable { constructor() { throw new Error("fake googleapis: not available"); } }
export const google = {
  auth: { OAuth2, JWT: Unavailable, GoogleAuth: Unavailable },
  gmail() { throw new Error("fake googleapis: Gmail is not available"); },
  people() { throw new Error("fake googleapis: People is not available"); },
  drive() { throw new Error("fake googleapis: Drive is not available"); },
};
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "googleapis") return { url: "field-test:fake-googleapis", shortCircuit: true, format: "module" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "field-test:fake-googleapis") return { format: "module", source: fakeModule, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://www.googleapis.com/oauth2/v3/tokeninfo?")) {
    return new Response(JSON.stringify({ email: process.env.FAKE_GOOGLE_EMAIL || "" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};
