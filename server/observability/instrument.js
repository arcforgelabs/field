// Loaded with `node --import ./server/observability/instrument.js` (the Replit
// start script and `npm start`), so Sentry starts before
// Express is imported and can trace its routes. Without SENTRY_DSN it does
// nothing.
import { initFieldSentry } from "./sentry.js";

await initFieldSentry();
