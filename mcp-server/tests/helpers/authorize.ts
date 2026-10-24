import {
  AUTHORIZE_STATE_ELEMENT_ID,
  type AuthorizeUi,
  type AuthorizeState,
} from "../../mcp/authorize-ui";

export const TEST_AUTHORIZE_SHELL =
  '<!doctype html><html><head><title>ChowBot</title></head><body><div id="root"></div></body></html>';

export const testAuthorizeUi = (assetsDir?: string): AuthorizeUi => ({
  shell: async () => TEST_AUTHORIZE_SHELL,
  ...(assetsDir && { assetsDir }),
});

const STATE_PATTERN = new RegExp(
  `<script id="${AUTHORIZE_STATE_ELEMENT_ID}" type="application/json">([^<]*)</script>`,
);

export const authorizeStateFrom = (html: string) => {
  const json = STATE_PATTERN.exec(html)?.[1];
  return json === undefined ? undefined : (JSON.parse(json) as AuthorizeState);
};

export const csrfFrom = (html: string) => {
  const state = authorizeStateFrom(html);
  return state && "csrfToken" in state ? state.csrfToken : undefined;
};

export const postAuthorizeJson = (
  url: string,
  body: Record<string, unknown> | undefined,
  { cookie, csrf }: { cookie?: string; csrf?: string } = {},
) =>
  fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      ...(cookie && { cookie }),
      ...(csrf !== undefined && { "x-csrf-token": csrf }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
