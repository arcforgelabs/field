// Settings, Integrations, Xero (#93): the owner routes.
//
//   GET  /api/integrations/xero                 the screen: whether each secret
//        is set, this installation's redirect address, the connection and the
//        settings. Never a token or a secret.
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
//   GET  /api/jobs/:id/xero                      each invoice's Xero state, for the
//        job's Invoices tab. Any signed-in person may read it; Retry and Send
//        are the owner routes above.
//
// Every route but the callback needs a signed-in owner (requireOwner: with
// Clerk, a verified owner sign-in; machine tokens never pass).
import { XERO_CALLBACK_PATH, xeroRedirectUri } from "./config.js";

export const XERO_STATUS_PATH = "/api/integrations/xero";
export const XERO_CONNECT_PATH = `${XERO_STATUS_PATH}/connect`;
export const XERO_ORGANISATION_PATH = `${XERO_STATUS_PATH}/organisation`;
export const XERO_DISCONNECT_PATH = `${XERO_STATUS_PATH}/disconnect`;
export const XERO_SETTINGS_PATH = `${XERO_STATUS_PATH}/settings`;
export const XERO_CODES_PATH = `${XERO_STATUS_PATH}/codes`;
export const XERO_PUSH_PREVIEW_PATH = `${XERO_STATUS_PATH}/push/preview`;
export const XERO_PUSH_PATH = `${XERO_STATUS_PATH}/push`;
export const XERO_RETRY_PATH = `${XERO_STATUS_PATH}/invoices/:uid/retry`;
export const XERO_JOB_STATUS_PATH = "/api/jobs/:id/xero";
export { XERO_CALLBACK_PATH };

const SCREEN = "/#/settings?section=integrations";

function codeOf(error, fallback) {
  const code = String(error?.code || "");
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : fallback;
}

/**
 * `connection()` returns the connection service (connection.js) or null when
 * the server has no database. `publicUrl()` the configured public address.
 */
export function registerXeroRoutes(app, { requireAuth, requireOwner, connection, sync = () => null, publicUrl = () => null, actorOf = () => null, logger = console }) {
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

  app.get(XERO_STATUS_PATH, requireAuth, requireOwner, async (req, res) => {
    const xero = service(res);
    if (!xero) return;
    try {
      const { redirectUri, configured } = redirect();
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, redirectUri, publicUrlConfigured: configured, ...(await xero.status()) });
    } catch (error) {
      fail(res, error, "status");
    }
  });

  app.post(XERO_CONNECT_PATH, requireAuth, requireOwner, async (req, res) => {
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

  app.post(XERO_ORGANISATION_PATH, requireAuth, requireOwner, async (req, res) => {
    const xero = service(res);
    if (!xero) return;
    try {
      res.json({ ok: true, ...(await xero.chooseOrganisation({ tenantId: String(req.body?.tenantId || ""), actor: actorOf(req) })) });
    } catch (error) {
      fail(res, error, "choosing the organisation");
    }
  });

  app.post(XERO_DISCONNECT_PATH, requireAuth, requireOwner, async (req, res) => {
    const xero = service(res);
    if (!xero) return;
    try {
      res.json({ ok: true, ...(await xero.disconnect({ actor: actorOf(req) })) });
    } catch (error) {
      fail(res, error, "disconnect");
    }
  });

  app.get(XERO_CODES_PATH, requireAuth, requireOwner, async (_req, res) => {
    const xero = service(res);
    if (!xero) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...(await xero.codes()) });
  });

  app.put(XERO_SETTINGS_PATH, requireAuth, requireOwner, async (req, res) => {
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

  app.post(XERO_PUSH_PREVIEW_PATH, requireAuth, requireOwner, async (req, res) => {
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

  app.post(XERO_PUSH_PATH, requireAuth, requireOwner, async (req, res) => {
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

  app.post(XERO_RETRY_PATH, requireAuth, requireOwner, async (req, res) => {
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
