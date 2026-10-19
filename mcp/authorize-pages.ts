const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);

export const AUTHORIZE_FONT_PATH = "/authorize/assets/plus-jakarta-sans.woff2";
export const AUTHORIZE_LOGO_PATH = "/authorize/assets/chowbot-logo.svg";
export const AUTHORIZE_ICON_PATH = "/authorize/assets/chowbot-icon.png";

/*
 * The logo is ChowBot's own mark, not Chowdeck's. Palette and type follow
 * Chowdeck's brand (Chow Green, Kiwi, Cucumber, Pepper; Plus Jakarta) so the
 * sign-in feels familiar. Assets are self-hosted so this page loads nothing
 * from third parties.
 */
const STYLES = `
  @font-face {
    font-family: "Plus Jakarta Sans";
    font-style: normal;
    font-weight: 400 700;
    font-display: swap;
    src: url("${AUTHORIZE_FONT_PATH}") format("woff2");
  }
  :root {
    --chow-green: #0c513f;
    --cucumber: #038b5c;
    --kiwi: #02c27f;
    --pepper: #e80b2e;
    --ink: #101b17;
    --muted: #6b7a75;
    --line: #dfe7e4;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2rem 1.25rem 1.25rem;
    background: #fff;
    color: var(--ink);
    font-family: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { width: 100%; max-width: 22rem; margin: auto 0; text-align: center; }
  .logo { display: block; width: 3.5rem; height: 3.5rem; margin: 0 auto 1.5rem; }
  h1 { margin: 0; font-size: clamp(1.375rem, 5vw, 1.5rem); font-weight: 700; letter-spacing: -.02em; }
  .subtitle { margin: .5rem 0 1.75rem; color: var(--muted); }
  .subtitle strong { color: var(--ink); font-weight: 600; }
  form { display: grid; gap: .75rem; }
  input {
    width: 100%; height: 3.25rem; padding: 0 1rem; font: inherit; font-size: 1rem; color: var(--ink);
    border: 1.5px solid var(--line); border-radius: .75rem; background: #fff;
  }
  input::placeholder { color: var(--muted); }
  input:focus { outline: none; border-color: var(--muted); }
  .code { font-size: 1.35rem; letter-spacing: .4em; font-weight: 600; text-align: center; }
  button {
    height: 3.25rem; font: inherit; font-weight: 600; font-size: 1rem; color: #fff;
    border: 0; border-radius: 999px; background: var(--chow-green); cursor: pointer; transition: background .15s;
  }
  button:hover { background: var(--cucumber); }
  button:focus-visible { outline: 3px solid var(--kiwi); outline-offset: 2px; }
  .error { margin: 0 0 1rem; color: var(--pepper); font-weight: 500; font-size: .925rem; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  footer { margin-top: 2rem; color: var(--muted); font-size: .6875rem; opacity: .7; }
  @media (max-width: 30rem) {
    body { padding-top: 12vh; }
    main { margin-top: 0; }
    .logo { width: 3rem; height: 3rem; margin-bottom: 1.25rem; }
    .subtitle { margin-bottom: 1.5rem; }
  }
`;

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ChowBot</title>
<link rel="icon" href="${AUTHORIZE_LOGO_PATH}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${AUTHORIZE_ICON_PATH}">
<link rel="preload" href="${AUTHORIZE_FONT_PATH}" as="font" type="font/woff2" crossorigin>
<style>${STYLES}</style>
</head>
<body>
<main>
  <img class="logo" src="${AUTHORIZE_LOGO_PATH}" alt="" width="56" height="56">
  ${body}
</main>
<footer>ChowBot · not affiliated with Chowdeck</footer>
</body>
</html>`;

export type AuthorizationContext = {
  clientName?: string;
  csrfToken: string;
};

const errorBlock = (error?: string) =>
  error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";

const csrfField = (csrfToken: string) =>
  `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">`;

export const phonePage = (context: AuthorizationContext, error?: string) =>
  layout(
    "Sign in with Chowdeck",
    `<h1>Sign in with Chowdeck</h1>
  <p class="subtitle">to continue to <strong>${escapeHtml(context.clientName ?? "your assistant")}</strong></p>
  ${errorBlock(error)}
  <form method="post" action="/authorize/phone" autocomplete="off">
    ${csrfField(context.csrfToken)}
    <label class="sr-only" for="phone">Phone number</label>
    <input id="phone" name="phone" type="tel" inputmode="tel" placeholder="Phone number" required maxlength="20" autofocus>
    <button type="submit">Continue</button>
  </form>`,
  );

export const otpPage = (
  context: AuthorizationContext,
  maskedPhone: string,
  error?: string,
) =>
  layout(
    "Enter your code",
    `<h1>Enter your code</h1>
  <p class="subtitle">Sent to <strong>${escapeHtml(maskedPhone)}</strong></p>
  ${errorBlock(error)}
  <form method="post" action="/authorize/verify" autocomplete="off">
    ${csrfField(context.csrfToken)}
    <label class="sr-only" for="otp">Login code</label>
    <input class="code" id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,8}" required maxlength="8" autofocus>
    <button type="submit">Verify</button>
  </form>`,
  );

export const errorPage = (title: string, message: string) =>
  layout(
    title,
    `<h1>${escapeHtml(title)}</h1>
  <p class="subtitle">${escapeHtml(message)}</p>`,
  );
