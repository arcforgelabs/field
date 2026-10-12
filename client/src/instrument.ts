import * as Sentry from "@sentry/react";
import React from "react";
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from "react-router-dom";

declare global {
  interface Window {
    __FIELD_SENTRY_DSN__?: string;
  }
}

const dsn =
  String(import.meta.env.VITE_SENTRY_DSN || "").trim()
  || (typeof window !== "undefined" ? String(window.__FIELD_SENTRY_DSN__ || "").trim() : "");

Sentry.init({
  dsn: dsn || undefined,
  environment: import.meta.env.MODE,
  release: String(import.meta.env.VITE_SENTRY_RELEASE || "").trim() || undefined,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpBodies: [],
  },
  integrations: [
    Sentry.reactRouterV7BrowserTracingIntegration({
      useEffect: React.useEffect,
      useLocation,
      useNavigationType,
      matchRoutes,
      createRoutesFromChildren,
    }),
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
  tracesSampleRate: import.meta.env.PROD ? 0.2 : 1.0,
  tracePropagationTargets: [
    "localhost",
  ],
  replaysSessionSampleRate: 0.05,
  replaysOnErrorSampleRate: 1.0,
});
