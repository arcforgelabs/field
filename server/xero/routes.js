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
//   PUT  /api/integrations/xero/settings         { createMode, salesAccountCode, taxType }
//
// Every route but the callback needs a signed-in owner (requireOwner: with
// Clerk, a verified owner sign-in; machine tokens never pass).
import { XERO_CALLBACK_PATH, xeroRedirectUri } from "./config.js";

export const XERO_STATUS_PATH = "/api/integrations/xero";
export const XERO_CONNECT_PATH = `${XERO_STATUS_PATH}/connect`;
export const XERO_ORGANISATION_PATH = `${XERO_STATUS_PATH}/organisation`;
export const XERO_DISCONNECT_PATH = `${XERO_STATUS_PATH}/disconnect`;
export const XERO_SETTINGS_PATH = `${XERO_STATUS_PATH}/settings`;
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
export function registerXeroRoutes(app, { requireAuth, requireOwner, connection, publicUrl = () => null, actorOf = () => null, logger = console }) {
  const service = (res) => {
    const found = connection();
    if (!found) res.status(503).json({ error: "Xero needs the database, which this server does not have.", code: "XERO_NO_DATABASE" });
    return found;
  };
  const redirect = (req) => xeroRedirectUri({ publicUrl: publicUrl(), req });
  const fail = (res, error, label) => {
    const statusCode = error?.statusCode || (error?.name === "XeroError" ? 502 : 500);
    if (statusCode >= 500) logger.warn?.(`[xero] ${label} failed (${codeOf(error, "XERO_ERROR")})`);
    res.status(statusCode).json({ error: error?.reason || (statusCode >= 500 && error?.name !== "XeroError" ? "Xero could not be reached from Field. Try again shortly." : error?.message), code: codeOf(error, "XERO_ERROR") });
  };

  app.get(XERO_STATUS_PATH, requireAuth, requireOwner, async (req, res) => {
    const xero = service(res);
    if (!xero) return;
    try {
      const { redirectUri, fromRequest } = redirect(req);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, redirectUri, publicUrlConfigured: !fromRequest, ...(await xero.status()) });
    } catch (error) {
      fail(res, error, "status");
    }
  });

  app.post(XERO_CONNECT_PATH, requireAuth, requireOwner, async (req, res) => {
    const xero = service(res);
    if (!xero) return;
    try {
      res.json({ ok: true, ...(await xero.startConnect({ redirectUri: redirect(req).redirectUri, actor: actorOf(req) })) });
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
        redirectUri: redirect(req).redirectUri,
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
}
