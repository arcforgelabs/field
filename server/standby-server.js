import { createServer } from "node:http";

// While another Field process holds the storage lock, this answers on the
// app's port so a republish can hand over:
//
//   1. Replit starts the new copy while the old copy still serves and holds
//      the lock. The new copy waits for the lock and opens this server.
//   2. Replit's health check asks GET / and gets 200, so Replit promotes the
//      new copy and stops the old one. The old copy drains, stores its last
//      changes and releases the lock.
//   3. The new copy takes the lock, rebuilds and hands this same server to
//      Express (handOver).
//
// Until then, every other request gets 503 with Retry-After, and GET /health
// says the app is starting, so a monitor never reads it as healthy.
export function openStandbyServer({ port, host = "0.0.0.0", logger = console } = {}) {
  const standby = (req, res) => {
    const path = String(req.url || "").split("?")[0];
    const head = req.method === "HEAD";
    if ((req.method === "GET" || head) && path === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(head ? undefined : "Field is starting\n");
      return;
    }
    res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "5" });
    res.end(head ? undefined : JSON.stringify(
      path === "/health"
        ? { ok: false, starting: true, storage: { state: "waiting-for-lock" } }
        : { error: "Field is starting. Try again in a few seconds." },
    ));
  };
  const server = createServer(standby);
  server.listen(port, host, () => {
    logger.log?.(`[field] standby on http://${host}:${port} while another Field process holds the storage lock`);
  });
  return {
    server,
    // Serve `app` on the same port from now on; nothing is closed or re-bound.
    handOver(app) {
      server.removeListener("request", standby);
      server.on("request", app);
      return server;
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
