import { join } from "node:path";

import { logger } from "../utils/logger";

/*
 * What the sign-in app needs to render its first screen. It is embedded in
 * the page as JSON, so the app shows the right step without a round trip and
 * a refresh lands on the same step. Mirrors auth/src/lib/state.ts.
 */
export type AuthorizeState =
  | { view: "phone"; csrfToken: string; clientName?: string }
  | {
      view: "otp";
      csrfToken: string;
      clientName?: string;
      maskedPhone: string;
    }
  | { view: "error"; title: string; message: string };

export const AUTHORIZE_STATE_ELEMENT_ID = "chowbot-authorize-state";
export const AUTHORIZE_ASSETS_PATH = "/authorize/assets";

/*
 * The built sign-in app (auth/dist): index.html plus hashed files under
 * assets/. Tests pass their own shell instead of a build.
 */
export type AuthorizeUi = {
  shell: () => Promise<string | undefined>;
  assetsDir?: string;
};

const JSON_SCRIPT_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/*
 * The state holds the client's self-registered name, so it is escaped to
 * never close the script element or open a comment, whatever the name is.
 */
export const serializeState = (state: AuthorizeState) =>
  JSON.stringify(state).replace(
    /[<>&\u2028\u2029]/g,
    (char) => JSON_SCRIPT_ESCAPES[char]!,
  );

export const renderAuthorizePage = (shell: string, state: AuthorizeState) => {
  const script = `<script id="${AUTHORIZE_STATE_ELEMENT_ID}" type="application/json">${serializeState(state)}</script>`;
  return shell.includes("</head>")
    ? shell.replace("</head>", () => `${script}</head>`)
    : `${script}${shell}`;
};

/*
 * Shown only when the app has not been built (bun run --filter ./auth build),
 * so a misconfigured deploy fails visibly instead of with a blank page.
 */
export const UNBUILT_SHELL = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ChowBot</title></head>
<body><p>ChowBot sign-in is unavailable right now. Try again later.</p></body>
</html>`;

/*
 * index.html is read per request (it is small) so a rebuild during
 * development never leaves the server pointing at stale asset hashes.
 */
export const createAuthorizeUi = (dir: string): AuthorizeUi => ({
  shell: async () => {
    const file = Bun.file(join(dir, "index.html"));
    if (await file.exists()) return file.text();
    logger.error(`Sign-in app not found in ${dir}; build the auth workspace.`);
    return undefined;
  },
  assetsDir: join(dir, "assets"),
});
