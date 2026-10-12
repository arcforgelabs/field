# Lessons Learned

Chronological log of persistent production bugs and the fixes that finally
resolved them. Newest entries at the top. Each entry names the user-facing
symptom, the wrong diagnoses that delayed the fix, the actual root cause, and
the commit that landed it — so future debugging has the full trail.

---

## 2026-04-12 — "Make Current" on archived quote version freezes the page

**Symptom:** Clicking **Make Current** on an archived quote version caused the
screen to dim and then become completely unresponsive. Refreshing did not
persist the intended version flip. Reported on two customer quotes.
Survived across page refreshes.

**Final root cause (commit `63a8dbe`):** `client/src/features/job-detail/components/versions-sheet.tsx`
— and three sibling sheet components — used `position: absolute, inset: 0` on
the top-level sheet container. The positioned ancestor is the job-detail page's
content column, which grows to the full height of the quote list (**3259 px**
on a long quote). That made the sheet 3259 px tall, which in turn made the
confirm dialog overlay (`position: absolute, inset: 0` inside the sheet) 3259 px
tall as well. The centered dialog card therefore rendered at document
`y ≈ 1529` — **~1100 px below the bottom of a 417-px-tall viewport**. The user
saw the overlay darken the visible sheet area but the actual Cancel / Make
Current buttons were literally off-screen below the fold, so every click just
hit the backdrop and did nothing.

**Fix:** Change the top-level sheet containers (and the two confirm-dialog
overlays inside `versions-sheet.tsx`) from `position: absolute` to
`position: fixed`. `inset: 0` then resolves against the viewport, so the sheet
is always viewport-sized and the centered dialog card always lands in the
visible area regardless of page scroll or quote length.

Files touched:
- `client/src/features/job-detail/components/versions-sheet.tsx` (sheet + 2 confirm overlays)
- `client/src/features/job-detail/components/soil-picker-sheet.tsx`
- `client/src/features/job-detail/components/archive-dialog.tsx`
- `client/src/features/chat/full-chat-overlay.tsx`

**Wrong diagnoses (and the commits that came out of them — each useful in its
own right but none actually fixed the freeze):**

1. **"It's a stale code-split chunk from an old deploy"** (`d3dbfc9`). The
   theory was that the tab still held references to a content-hashed Vite chunk
   the server no longer has, so the lazy `import()` rejected silently and the
   sheet never opened. Matched the `SyntaxError: Unexpected token '<'` pattern
   you get when the SPA fallback serves `index.html` as JS. The enhancement to
   `ErrorBoundary` (auto-reload on `ChunkLoadError` with a sessionStorage guard
   against loops) is worth keeping — it will prevent that *class* of bug — but
   it was not the active cause.

2. **"`findJob` returns rows missing `date_dir`, so `upsertJob` hits
   `NOT NULL constraint failed: jobs.date_dir` and every promote silently
   fails in the best-effort try/catch"** (`5e3a933`). This *was* a real latent
   bug uncovered by the promote-endpoint milestone logs — the DB index refresh
   was failing on every promote — but it wasn't the user-visible freeze
   either. Worth keeping fixed.

3. **"Backend is slow, user needs a loading state and error surface"**
   (`2e163df`, `ff3afb3`). The promote endpoint does a lot of filesystem work
   and had no client feedback. Adding `promoteVersionBusy`, a shared version-
   action error banner, and per-step server milestone logs is good hygiene but
   was not the cause — the backend actually completes in ~500 ms.

**Why the real cause took so long to find:**

- **Playwright reproduces the flow successfully on the exact same URL.**
  Playwright auto-scrolls to click targets, so when it clicked the off-screen
  dialog button it scrolled the page and the click landed. In a human's
  browser, the click hit-tests the coordinate the button *should* be at and
  finds the backdrop instead. The discrepancy wasted at least two debugging
  rounds: "the backend works, Playwright works, the user is wrong" is the
  exact kind of conclusion to distrust.
- **Console was silent.** No JS error, no network failure, no rejected
  promise. The freeze was purely a layout bug, not a runtime bug.
- **The backdrop overlay gave the user enough visual feedback** ("slightly
  darker") to convince me the dialog *had* opened — I just assumed the card
  was visible somewhere.

**How the bug was finally caught:** Scripted a Playwright DOM dump of every
element with `z-index ≥ 20`, including its `getBoundingClientRect`. The
versions sheet returned `51, -1477 / 640×3259` — absurd numbers for a
"fullscreen" sheet. Measuring the confirm dialog box the same way gave
`y = 1529` against `viewport.h = 417` and the problem was obvious.

**Rules to carry forward:**

1. **Don't trust Playwright-passing as proof the UI is reachable.** Playwright
   auto-scrolls. Humans do not. If a user reports a click that silently fails
   and automation says it works, the first thing to check is whether the
   target element is actually within the viewport at the user's scroll
   position — not whether the handler fires.
2. **Any full-screen sheet or modal must use `position: fixed`**, not
   `position: absolute`. `absolute` leaks into whatever the nearest positioned
   ancestor is, and if that ancestor grows (long quotes, infinite scroll,
   data-driven content), the sheet grows with it and its inner centered
   elements drift off-screen. This is non-obvious when the parent is
   viewport-sized in dev and only expands in production with real data.
3. **Dump bounding rects, not just "did it render."** `querySelector` finding
   an element proves it exists in the DOM. `getBoundingClientRect` against
   `window.innerHeight/innerWidth` proves the user can actually see and click
   it. These are different questions.
4. **When the symptom persists across refreshes, the stale-chunk theory is
   almost certainly wrong.** A refresh clears a stale dynamic-import cache
   immediately. If refresh doesn't fix it, the bug lives in the code being
   served *now*, not in the code the tab was holding.
