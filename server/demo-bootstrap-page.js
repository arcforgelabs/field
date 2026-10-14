// The page GET /demo answers: it keeps the demo session's token where the
// client looks for it (`fr_token`), reads the signed-in person from
// /api/auth/me with it (`fr_user`), and opens the jobs list. No person's
// details are written into the page, so nothing a person can edit (their
// name) reaches its script.
export function renderDemoBootstrapPage({ token }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Opening Field Demo</title>
  <style>
    :root { color-scheme: dark; }
    body {
      min-height: 100dvh;
      margin: 0;
      display: grid;
      place-items: center;
      background: #050505;
      color: #f4f3ef;
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
  </style>
</head>
<body>
  <span>Opening Field demo...</span>
  <script>
    const token = ${scriptLiteral(String(token))};
    localStorage.setItem("fr_token", token);
    fetch("/api/auth/me", { headers: { Authorization: "Bearer " + token } })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (body && body.user) localStorage.setItem("fr_user", JSON.stringify(body.user)); })
      .catch(() => {})
      .finally(() => window.location.replace("/jobs"));
  </script>
</body>
</html>`;
}

// A JSON literal that cannot end the script element or open a comment in it,
// and that is JavaScript as well as JSON (U+2028 and U+2029).
export function scriptLiteral(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
