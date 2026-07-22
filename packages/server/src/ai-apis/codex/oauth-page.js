// HTML pages shown in the user's browser after the OAuth redirect lands
// on the local callback server.

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"/><path fill="#fff" d="M517.36 400 H634.72 V634.72 H517.36 Z"/></svg>`

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
}

function renderPage({ title, heading, message, details }) {
	const t = escapeHtml(title)
	const h = escapeHtml(heading)
	const m = escapeHtml(message)
	const d = details ? escapeHtml(details) : undefined

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${t}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center;
      justify-content: center; padding: 24px; background: #09090b;
      color: #fafafa; text-align: center;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    main { width: 100%; max-width: 560px; }
    .logo { width: 72px; height: 72px; margin: 0 auto 24px; display: block; }
    h1 { margin: 0 0 10px; font-size: 28px; font-weight: 650; line-height: 1.15; }
    p { margin: 0; line-height: 1.7; color: #a1a1aa; font-size: 15px; }
    .details {
      margin-top: 16px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px; color: #a1a1aa; white-space: pre-wrap; word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <h1>${h}</h1>
    <p>${m}</p>
    ${d ? `<div class="details">${d}</div>` : ""}
  </main>
</body>
</html>`
}

export function oauthSuccessHtml(message) {
	return renderPage({
		title: "Authentication successful",
		heading: "Authentication successful",
		message,
	})
}

export function oauthErrorHtml(message, details) {
	return renderPage({
		title: "Authentication failed",
		heading: "Authentication failed",
		message,
		details,
	})
}
