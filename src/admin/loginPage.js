// Admin sign-in page.

export function loginPage({ nonce, error = '' }) {
  const message = error ? `<p class="err">${error.replace(/[<>&]/g, '')}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Relay admin</title>
  <style>
    :root { color-scheme: light dark; --bg: #f4f5f7; --card: #fff; --text: #1d2330; --muted: #667085; --line: #d9dde5; --accent: #2f6fde; --bad: #c4372d; }
    @media (prefers-color-scheme: dark) { :root { --bg: #111418; --card: #1b2027; --text: #e6e9ef; --muted: #9aa3b2; --line: #2c333d; --accent: #5b8ff0; --bad: #ef6b60; } }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, sans-serif; padding: 16px; }
    form { width: 100%; max-width: 340px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 24px; }
    h1 { margin: 0 0 18px; font-size: 18px; }
    label { display: block; margin: 12px 0 4px; color: var(--muted); font-size: 13px; }
    input { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; font: inherit; }
    button { width: 100%; margin-top: 18px; padding: 10px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    .err { color: var(--bad); margin: 0 0 6px; font-size: 14px; }
  </style>
</head>
<body>
  <form method="post" action="/admin/login" autocomplete="on">
    <h1>Stream relay admin</h1>
    ${message}
    <label for="u">Username</label>
    <input id="u" name="username" autocomplete="username" required autofocus>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
  <script nonce="${nonce}"></script>
</body>
</html>`;
}
