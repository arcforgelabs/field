import * as Sentry from "@sentry/react";
import React from "react";
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import { createEventThrottle, scrubBreadcrumb, scrubEvent, scrubText } from "../../shared/sentry-scrub.js";
import { tagNotify } from "./lib/sentry-feedback";

interface FieldSentryConfig {
  dsn?: string;
  environment?: string;
  release?: string;
  tags?: Record<string, string>;
  tracesSampleRate?: number;
  replaysSessionSampleRate?: number;
  replaysOnErrorSampleRate?: number;
  feedback?: boolean;
}

declare global {
  interface Window {
    // Written into index.html by the server (server/observability/sentry.js)
    // from its own SENTRY_* settings, so one deployment secret covers both.
    // Without SENTRY_DSN there is none, and Sentry stays off.
    __FIELD_SENTRY__?: FieldSentryConfig;
  }
}

const runtime: FieldSentryConfig = (typeof window !== "undefined" && window.__FIELD_SENTRY__) || {};
const dsn = String(import.meta.env.VITE_SENTRY_DSN || runtime.dsn || "").trim();

function rate(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// product and client (SENTRY_CLIENT), from the server, as on its events. The
// scrub redacts any key that names a client, so they are put back after it.
const routingTags: Record<string, string> = runtime.tags || { product: "field" };
function withRoutingTags<T extends { tags?: Record<string, unknown> }>(event: T | null): T | null {
  if (event) event.tags = { ...event.tags, ...routingTags };
  return event;
}

// Trace headers go only to Field's own server, never to a third party.
const ownOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost";

if (dsn) {
  const throttle = createEventThrottle();
  Sentry.init({
    dsn,
    environment: String(runtime.environment || import.meta.env.MODE),
    release: String(runtime.release || import.meta.env.VITE_SENTRY_RELEASE || "").trim() || undefined,
    initialScope: { tags: routingTags },
    sendDefaultPii: false,
    // A cancelled fetch (the user left the page, a newer request replaced it)
    // rejects with AbortError. Nothing failed, so it is not reported.
    ignoreErrors: [/^AbortError\b/],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpBodies: [],
    },
    // Same error at most once an hour, at most 20 an hour in all, per open tab.
    beforeSend: (event) => {
      const allowed = throttle(event);
      return allowed && withRoutingTags(scrubEvent(allowed));
    },
    beforeSendTransaction: (event) => withRoutingTags(scrubEvent(event)),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    integrations: [
      // Page loads and navigations, with Web Vitals: how fast the page shows,
      // and INP, how long the screen takes to respond to a click.
      Sentry.reactRouterV7BrowserTracingIntegration({
        useEffect: React.useEffect,
        useLocation,
        useNavigationType,
        matchRoutes,
        createRoutesFromChildren,
        enableInp: true,
      }),
      // Field shows customers' names, addresses and prices on screen. A replay
      // keeps the page's shape and clicks, never its words: all text, inputs and
      // the attributes that can carry them are masked, and media, frames and
      // canvases are blocked. The replay library records link URLs as written
      // (the attribute mask skips href), so contact links, job links (older job
      // ids were made from the site address) and links with a query string are
      // blocked whole. No network detail is recorded. Rage clicks and dead
      // clicks (no response within 7 seconds) are detected from the replay.
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
        // Click breadcrumbs inside the replay name the clicked element by CSS
        // path, attribute values included; scrub them like any breadcrumb.
        // Page-load spans in the replay carry the page URL; scrub those too.
        beforeAddRecordingEvent: (event) => {
          const payload = (event as unknown as { data?: { payload?: Record<string, unknown> } }).data?.payload;
          if (!payload || typeof payload !== "object") return event;
          let next: Record<string, unknown> | null = payload;
          if ("category" in payload) next = scrubBreadcrumb(payload);
          else if (typeof payload.description === "string") next = { ...payload, description: scrubText(payload.description) };
          if (!next) return null;
          return { ...event, data: { ...(event.data as object), payload: next } } as unknown as typeof event;
        },
      }),
      ...(runtime.feedback === false
        ? []
        : [
          // A small "report a problem" button. It asks for no name; a
          // screenshot is optional and can be cropped or blacked out first.
          // The email field keeps Sentry's defaults (shown, optional, Sentry's
          // own words) and is the "tell me when it is fixed" opt-in, so it is
          // never filled from the signed-in person: useSentryUser points at a
          // key setUser never sets.
          Sentry.feedbackIntegration({
            autoInject: true,
            colorScheme: "system",
            showBranding: false,
            showName: false,
            useSentryUser: { name: "username", email: "notify_email" },
            enableScreenshot: true,
            triggerLabel: "",
            triggerAriaLabel: "Report a problem",
            formTitle: "Report a problem",
            messageLabel: "What went wrong?",
            messagePlaceholder: "What were you doing, and what did you expect to happen?",
            submitButtonLabel: "Send report",
            successMessageText: "Thanks. The report was sent.",
            themeLight: { accentBackground: "var(--primary)", accentForeground: "var(--primary-foreground)" },
            themeDark: { accentBackground: "var(--primary)", accentForeground: "var(--primary-foreground)" },
          }),
        ]),
    ],
    tracesSampleRate: rate(runtime.tracesSampleRate, import.meta.env.PROD ? 0.2 : 1),
    tracePropagationTargets: [new RegExp(`^${escapeRegExp(ownOrigin)}(?:/|$)`), /^\/(?!\/)/],
    replaysSessionSampleRate: rate(runtime.replaysSessionSampleRate, 0.05),
    replaysOnErrorSampleRate: rate(runtime.replaysOnErrorSampleRate, 1),
  });
  // Feedback events skip beforeSend; this hook sees each one before it is sent.
  Sentry.getClient()?.on("beforeSendFeedback", tagNotify);
}
