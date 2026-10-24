import { useSyncExternalStore } from "react";

/*
 * The MCP server embeds this in the page (mirrors AuthorizeState in
 * mcp-server/mcp/authorize-ui.ts). OAuth parameters and the full phone
 * number never reach the page; the server keeps them against a cookie.
 */
export type AuthorizeState =
  | { view: "phone"; csrfToken: string; clientName?: string }
  | { view: "otp"; csrfToken: string; clientName?: string; maskedPhone: string }
  | { view: "error"; title: string; message: string };

const STATE_ELEMENT_ID = "chowbot-authorize-state";

export type Ended = { title: string; message: string };

export type SignIn = {
  csrfToken: string;
  clientName: string;
  maskedPhone?: string;
  // Set once the server has sent a code during this page's lifetime, so
  // "change number" can go back in history instead of losing the URL.
  sentFromPhoneStep: boolean;
  ended?: Ended;
  redirectingTo?: string;
};

const UNAVAILABLE: Ended = {
  title: "Sign-in unavailable",
  message: "Start again from your assistant.",
};

export const readAuthorizeState = (): AuthorizeState | undefined => {
  const element = document.getElementById(STATE_ELEMENT_ID);
  if (!element?.textContent) return undefined;
  try {
    return JSON.parse(element.textContent) as AuthorizeState;
  } catch {
    return undefined;
  }
};

export const initialSignIn = (state = readAuthorizeState()): SignIn => {
  if (!state) {
    return {
      csrfToken: "",
      clientName: "",
      sentFromPhoneStep: false,
      ended: UNAVAILABLE,
    };
  }
  if (state.view === "error") {
    return {
      csrfToken: "",
      clientName: "",
      sentFromPhoneStep: false,
      ended: { title: state.title, message: state.message },
    };
  }
  return {
    csrfToken: state.csrfToken,
    clientName: state.clientName?.trim() || "your assistant",
    sentFromPhoneStep: false,
    ...(state.view === "otp" && { maskedPhone: state.maskedPhone }),
  };
};

/*
 * A tiny store shared by the router (to guard the code step) and the
 * components (to render), without pulling in a state library.
 */
export const createSignInStore = (initial: SignIn) => {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    update: (patch: Partial<SignIn>) => {
      current = { ...current, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export type SignInStore = ReturnType<typeof createSignInStore>;

export const useSignIn = (store: SignInStore) =>
  useSyncExternalStore(store.subscribe, store.get);
