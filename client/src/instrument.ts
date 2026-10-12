import * as Sentry from "@sentry/react";
import React from "react";
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import { scrubBreadcrumb, scrubEvent } from "../../shared/sentry-scrub.js";

interface FieldSentryConfig {
  dsn?: string;
  environment?: string;
  release?: string;
  tracesSampleRate?: number;
}

declare global {
  interface Window {
    // Written into index.html by the server (server/observability/sentry.js)
    // from its own SENTRY_* settings, so one deployment secret covers both.
    __FIELD_SENTRY__?: FieldSentryConfig;
  }
}

const runtime: FieldSentryConfig = (typeof window !== "undefined" && window.__FIELD_SENTRY__) || {};
const dsn = String(import.meta.env.VITE_SENTRY_DSN || runtime.dsn || "").trim();
const tracesSampleRate = Number(runtime.tracesSampleRate ?? (import.meta.env.PROD ? 0 : 1));

Sentry.init({
  dsn: dsn || undefined,
  environment: String(runtime.environment || import.meta.env.MODE),
  release: String(runtime.release || import.meta.env.VITE_SENTRY_RELEASE || "").trim() || undefined,
  sendDefaultPii: false,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpBodies: [],
  },
  beforeSend: (event) => scrubEvent(event),
  beforeSendTransaction: (event) => scrubEvent(event),
  beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  integrations: [
    Sentry.reactRouterV7BrowserTracingIntegration({
      useEffect: React.useEffect,
      useLocation,
      useNavigationType,
      matchRoutes,
      createRoutesFromChildren,
    }),
    // Field shows customers' names, addresses and prices on screen. A replay
    // keeps the page's shape and clicks, never its words: all text, inputs and
    // the attributes that can carry them are masked, and media, frames and
    // canvases are blocked. The replay library records link URLs as written
    // (the attribute mask skips href), so contact links, job links (older job
    // ids were made from the site address) and links with a query string are
    // blocked whole. No network detail is recorded.
    Sentry.replayIntegration({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
      maskAttributes: ["title", "placeholder", "aria-label", "aria-description", "alt", "download", "value", "data-value"],
      block: [
        "iframe",
        "canvas",
        "embed",
        "object",
        'a[href^="mailto:" i]',
        'a[href^="tel:" i]',
        'a[href^="sms:" i]',
        'a[href*="?"]',
        'a[href*="/jobs/"]',
      ],
      networkDetailAllowUrls: [],
    }),
  ],
  tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 0,
  tracePropagationTargets: [
    "localhost",
  ],
  // Replays are kept only for sessions that hit an error.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
});
