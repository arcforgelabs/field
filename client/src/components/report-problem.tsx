// The "Report a problem" button, for signed-in people only. Rendered by App
// once the person has Field access, so the sign-in screen has no button and
// nobody can send a report without signing in. Nothing shows when Sentry or
// its feedback form is off.
import { useEffect } from "react";
import * as Sentry from "@sentry/react";
import { addResponseBox, feedbackRoot } from "@/lib/sentry-feedback";

export function ReportProblem() {
  useEffect(() => {
    const feedback = Sentry.getFeedback();
    if (!feedback) return undefined;
    const widget = feedback.createWidget();
    // The form draws itself inside the shadow root when it opens, and again
    // after each sent report; add "Request a response" whenever it does.
    const root = feedbackRoot();
    const watch = root ? new MutationObserver(() => addResponseBox(root)) : null;
    if (root) watch?.observe(root, { childList: true, subtree: true });
    return () => {
      watch?.disconnect();
      widget.removeFromDom();
    };
  }, []);
  return null;
}
