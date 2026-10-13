// Settings, Integrations, Xero (#93, #112).
//
//   GET  /api/integrations/xero                 the screen, for anyone signed in
//        (read-only unless `canManage`): whether each credential is set, when
//        and by whom, whether the environment overrides them, whether
//        FIELD_SECRETS_KEY is usable, this installation's redirect address,
//        the connection, the settings and the latest audit events. Never a
//        token, a credential or a key.
//   PUT  /api/integrations/xero/credentials     { clientId, clientSecret }: enter or
//        replace the Xero app's credentials (write-only; stored encrypted)
//   DELETE /api/integrations/xero/credentials   remove them (disconnects first)
//   POST /api/integrations/xero/connect          { url }: Xero's sign-in address
//   GET  /api/integrations/xero/callback         Xero sends the owner back here
//        (a browser redirect, so no Field sign-in header): the state recorded
//        by Connect is the proof an owner started it. Redirects to the screen.
//   POST /api/integrations/xero/organisation     { tenantId }: the owner's choice
//   POST /api/integrations/xero/disconnect
//   PUT  /api/integrations/xero/settings         { createMode, salesAccountCode, taxType }:
//        the codes are checked against the organisation's when Xero can be read
//   GET  /api/integrations/xero/codes            the organisation's active revenue
//        accounts and sales tax rates, for the lists ({ available: false } when
//        Xero cannot be read)
//   POST /api/integrations/xero/push/preview     { invoiceUids } or { sinceDays }: what
//        sending invoices issued before the connection would create. Writes nothing.
//   POST /api/integrations/xero/push             { invoiceUids }: send them
//   POST /api/integrations/xero/invoices/:uid/retry
//
//   The Connect wizard (docs/XERO.md "Connect Xero"), owners only, no-store:
//   POST /api/integrations/xero/setup/step       { step: app | credentials | done }:
//        the step the owner finished, with an audit event. `done` ends it.
//   PUT  /api/integrations/xero/pending-credentials  { keyId, clientId, clientSecret }:
//        while FIELD_SECRETS_KEY is not usable, the Xero app's credentials as
//        `fs1` values the browser encrypted with the key it generated
//        (shared/secrets-web.js). Anything else in the body, or a value that
//        is not a well-formed fs1 value of that key id, is refused. No key,
//        no plain value ever reaches this route.
//   DELETE /api/integrations/xero/pending-credentials  forget them (start again)
//
//   GET  /api/jobs/:id/xero                      each invoice's Xero state, for the
//        job's Invoices tab. Any signed-in person may read it; Retry and Send
//        are the owner routes above.
//
// Every route that changes anything needs a signed-in owner (requireOwner:
// with Clerk, a verified owner sign-in; machine tokens never pass). The
// screen and a job's Xero state are read-only for everyone else. The callback
// needs the state an owner's Connect recorded.
import { XERO_CALLBACK_PATH, xeroRedirectUri } from "./config.js";
import { INTEGRATIONS_READ_PERMISSION, hasBody, isMachine, machineGate } from "../secrets/routes.js";

export const XERO_STATUS_PATH = "/api/integrations/xero";
export const XERO_CONNECT_PATH = `${XERO_STATUS_PATH}/connect`;
export const XERO_ORGANISATION_PATH = `${XERO_STATUS_PATH}/organisation`;
export const XERO_DISCONNECT_PATH = `${XERO_STATUS_PATH}/disconnect`;
export const XERO_SETTINGS_PATH = `${XERO_STATUS_PATH}/settings`;
export const XERO_CODES_PATH = `${XERO_STATUS_PATH}/codes`;
export const XERO_CREDENTIALS_PATH = `${XERO_STATUS_PATH}/credentials`;
export const XERO_PUSH_PREVIEW_PATH = `${XERO_STATUS_PATH}/push/preview`;
export const XERO_PUSH_PATH = `${XERO_STATUS_PATH}/push`;
export const XERO_RETRY_PATH = `${XERO_STATUS_PATH}/invoices/:uid/retry`;
export const XERO_JOB_STATUS_PATH = "/api/jobs/:id/xero";
export { XERO_CALLBACK_PATH };

const SCREEN = "/#/settings?section=integrations";

export const XERO_SETUP_STEP_PATH = `${XERO_STATUS_PATH}/setup/step`;
export const XERO_PENDING_CREDENTIALS_PATH = `${XERO_STATUS_PATH}/pending-credentials`;

/** The permission that lets an API or MCP token read the Xero status (never change it). */
export { INTEGRATIONS_READ_PERMISSION };

const PENDING_BODY_KEYS = ["clientId", "clientSecret", "keyId"];

// What someone who is not an owner may see: the status, never who changed
// what, when, or the audit history.
function forReader(status) {
  const fieldState = (state) => ({ set: Boolean(state?.set) });
  return {
    ...status,
    secretsKey: { configured: Boolean(status.secretsKey?.configured), problem: status.secretsKey?.problem || null },
    credentials: {
      ...status.credentials,
      settings: { clientId: fieldState(status.credentials?.settings?.clientId), clientSecret: fieldState(status.credentials?.settings?.clientSecret) },
    },
    history: [],
    connection: { ...status.connection, connectedBy: null },
    setup: null,
  };
}

function codeOf(error, fallback) {
  const code = String(error?.code || "");
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : fallback;
}

/**
 * `connection()` returns the connection service (connection.js) or null when
 * the server has no database. `publicUrl()` the configured public address.
 * `setup()` the Connect wizard's state (server/secrets/setup.js), or null.
 */
export function registerXeroRoutes(app, { requireAuth, requireOwner, isOwner = async () => false, connection, sync = () => null, setup = () => null, publicUrl = () => null, actorOf = () => null, logger = console }) {
  const service = (res) => {
    const found = connection();
    if (!found) res.status(503).json({ error: "Xero needs the database, which this server does not have.", code: "XERO_NO_DATABASE" });
    return found;
  };
  const redirect = () => xeroRedirectUri({ publicUrl: publicUrl() });
  const fail = (res, error, label) => {
    const statusCode = error?.statusCode || (error?.name === "XeroError" ? 502 : 500);
    if (statusCode >= 500) logger.warn?.(`[xero] ${label} failed (${codeOf(error, "XERO_ERROR")})`);
    res.status(statusCode).json({ error: error?.reason || (statusCode >= 500 && error?.name !== "XeroError" ? "Xero could not be reached from Field. Try again shortly." : error?.message), code: codeOf(error, "XERO_ERROR") });
  };

  app.get(XERO_STATUS_PATH, requireAuth, machineGate({ read: true }), async (req, res) => {
    const xero = service(res);
    if (!xero) return;
    try {
      const { redirectUri, configured } = redirect();
      const owner = !isMachine(req.caller) && Boolean(await isOwner(req));
      // The wizard first: it moves pending credentials in once the key is set.
      const wizard = owner && setup() ? await setup().state() : null;
      const status = await xero.status();
      res.setHeader("Cache-Control", "no-store");
      const appUrl = configured ? String(publicUrl()).trim().replace(/\/+$/, "") : null;
      res.json({ ok: true, canManage: owner, redirectUri, appUrl, publicUrlConfigured: configured, ...(owner ? { ...status, setup: wizard } : forReader(status)) });
    } catch (error) {
      fail(res, error, "status");
    }
  });

  const wizardService = (res) => {
    const found = setup();
    if (!found) res.status(503).json({ error: "The wizard needs the database, which this server does not have.", code: "XERO_NO_DATABASE" });
    return found;
  };

  app.post(XERO_SETUP_STEP_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const wizard = wizardService(res);
    if (!wizard) return;
    try {
      const body = req.body || {};
      if (Object.keys(body).some((key) => key !== "step")) return res.status(400).json({ error: "Send only the step.", code: "SETUP_INVALID" });
      res.json({ ok: true, setup: await wizard.recordStep(String(body.step || ""), { actor: actorOf(req) }) });
    } catch (error) {
      fail(res, error, "recording the step");
    }
  });

  app.put(XERO_PENDING_CREDENTIALS_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const wizard = wizardService(res);
    const xero = wizard && service(res);
    if (!xero) return;
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const keys = Object.keys(body).sort();
      if (keys.join(",") !== PENDING_BODY_KEYS.join(",")) {
        return res.status(400).json({ error: "Send only the key id and the two encrypted credentials. The key stays in your browser.", code: "PENDING_INVALID" });
      }
      if ((await xero.status()).credentials.environmentOverride) {
        return res.status(409).json({ error: "XERO_CLIENT_ID and XERO_CLIENT_SECRET are set in the deployment, so Field uses those.", code: "XERO_ENVIRONMENT_OVERRIDE" });
      }
      const state = await wizard.storePending({ keyId: body.keyId, values: { client_id: body.clientId, client_secret: body.clientSecret } }, { actor: actorOf(req) });
      res.json({ ok: true, setup: state });
    } catch (error) {
      fail(res, error, "storing the pending credentials");
    }
  });

  app.delete(XERO_PENDING_CREDENTIALS_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const wizard = wizardService(res);
    if (!wizard) return;
    if (hasBody(req.body)) return res.status(400).json({ error: "This takes no body.", code: "SETUP_INVALID" });
    try {
      res.json({ ok: true, setup: await wizard.discardPending({ actor: actorOf(req) }) });
    } catch (error) {
      fail(res, error, "starting again");
    }
  });

  app.post(XERO_CONNECT_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    const xero = service(res);
    if (!xero) return;
    try {
      res.json({ ok: true, ...(await xero.startConnect({ redirectUri: redirect().redirectUri, actor: actorOf(req) })) });
    } catch (error) {
      fail(res, error, "connect");
    }
  });

  app.get(XERO_CALLBACK_PATH, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const xero = connection();
    if (!xero) return res.redirect(`${SCREEN}&xero=error&code=XERO_NO_DATABASE`);
    if (typeof req.query.error === "string") {
      // The owner cancelled at Xero, or Xero refused the request.
      const code = req.query.error === "access_denied" ? "XERO_ACCESS_DENIED" : "XERO_AUTHORISE_REFUSED";
      return res.redirect(`${SCREEN}&xero=error&code=${code}`);
    }
    try {
      const result = await xero.completeConnect({
        code: typeof req.query.code === "string" ? req.query.code : "",
        state: typeof req.query.state === "string" ? req.query.state : "",
        redirectUri: redirect().redirectUri,
      });
      res.redirect(`${SCREEN}&xero=${result.status === "connected" ? "connected" : "choose"}`);
    } catch (error) {
      logger.warn?.(`[xero] connecting failed (${codeOf(error, "XERO_ERROR")})`);
      res.redirect(`${SCREEN}&xero=error&code=${codeOf(error, "XERO_ERROR")}`);
    }
  });

  app.post(XERO_ORGANISATION_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    const xero = service(res);
    if (!xero) return;
    try {
      res.json({ ok: true, ...(await xero.chooseOrganisation({ tenantId: String(req.body?.tenantId || ""), actor: actorOf(req) })) });
    } catch (error) {
      fail(res, error, "choosing the organisation");
    }
  });

  app.post(XERO_DISCONNECT_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    const xero = service(res);
    if (!xero) return;
    try {
      res.json({ ok: true, ...(await xero.disconnect({ actor: actorOf(req) })) });
    } catch (error) {
      fail(res, error, "disconnect");
    }
  });

  app.put(XERO_CREDENTIALS_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    const xero = service(res);
    if (!xero) return;
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json({ ok: true, ...(await xero.setCredentials({ clientId: req.body?.clientId, clientSecret: req.body?.clientSecret }, { actor: actorOf(req) })) });
    } catch (error) {
      fail(res, error, "saving the credentials");
    }
  });

  app.delete(XERO_CREDENTIALS_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    const xero = service(res);
    if (!xero) return;
    try {
      res.json({ ok: true, ...(await xero.removeCredentials({ actor: actorOf(req) })) });
    } catch (error) {
      fail(res, error, "removing the credentials");
    }
  });

  app.get(XERO_CODES_PATH, requireAuth, machineGate(), requireOwner, async (_req, res) => {
    const xero = service(res);
    if (!xero) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...(await xero.codes()) });
  });

  app.put(XERO_SETTINGS_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    const xero = service(res);
    if (!xero) return;
    try {
      const body = req.body || {};
      const settings = await xero.updateSettings({ createMode: body.createMode, salesAccountCode: body.salesAccountCode, taxType: body.taxType }, { actor: actorOf(req) });
      res.json({ ok: true, settings });
    } catch (error) {
      fail(res, error, "saving the settings");
    }
  });

  const syncService = (res) => {
    const found = sync();
    if (!found) res.status(503).json({ error: "Xero needs the database, which this server does not have.", code: "XERO_NO_DATABASE" });
    return found;
  };
  const uids = (value) => (Array.isArray(value) ? value.filter((uid) => typeof uid === "string" && /^inv_[0-9A-HJKMNP-TV-Z]{26}$/.test(uid)).slice(0, 200) : null);

  app.post(XERO_PUSH_PREVIEW_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    const xero = syncService(res);
    if (!xero) return;
    try {
      const days = Number(req.body?.sinceDays);
      const issuedSince = Number.isFinite(days) && days > 0 ? new Date(Date.now() - Math.min(days, 3660) * 86_400_000) : null;
      const invoiceUids = uids(req.body?.invoiceUids);
      if (!invoiceUids && !issuedSince) return res.status(400).json({ error: "Name the invoices (invoiceUids) or a period (sinceDays).", code: "XERO_PUSH_INVALID" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, wroteNothing: true, ...(await xero.preview({ invoiceUids, issuedSince })) });
    } catch (error) {
      fail(res, error, "the preview");
    }
  });

  app.post(XERO_PUSH_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    const xero = syncService(res);
    if (!xero) return;
    try {
      const invoiceUids = uids(req.body?.invoiceUids);
      if (!invoiceUids?.length) return res.status(400).json({ error: "Choose at least one invoice.", code: "XERO_PUSH_INVALID" });
      res.json({ ok: true, ...(await xero.push({ invoiceUids, actor: actorOf(req) })) });
    } catch (error) {
      fail(res, error, "sending invoices");
    }
  });

  app.post(XERO_RETRY_PATH, requireAuth, machineGate(), requireOwner, async (req, res) => {
    const xero = syncService(res);
    if (!xero) return;
    try {
      const [invoiceUid] = uids([req.params.uid]) || [];
      if (!invoiceUid) return res.status(400).json({ error: "That is not an invoice.", code: "XERO_PUSH_INVALID" });
      res.json({ ok: true, ...(await xero.retry({ invoiceUid, actor: actorOf(req) })) });
    } catch (error) {
      fail(res, error, "retry");
    }
  });

  app.get(XERO_JOB_STATUS_PATH, requireAuth, async (req, res) => {
    const xero = sync();
    res.setHeader("Cache-Control", "no-store");
    if (!xero) return res.json({ ok: true, connected: false, connection: "disconnected", createMode: "off", invoices: {} });
    try {
      res.json({ ok: true, ...(await xero.jobStatus(req.params.id)) });
    } catch (error) {
      fail(res, error, "the job's Xero status");
    }
  });
}
