import { createContext, useContext } from "react";

import type { SignInStore } from "@/lib/state";

export const SignInContext = createContext<SignInStore | null>(null);

export const useSignInStore = () => {
  const store = useContext(SignInContext);
  if (!store)
    throw new Error("useSignInStore must be used inside SignInContext");
  return store;
};
