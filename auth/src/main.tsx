import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import "./styles.css";
import { createSignInRouter } from "@/router";
import { SignInContext } from "@/lib/sign-in-context";
import { createSignInStore, initialSignIn } from "@/lib/state";

const store = createSignInStore(initialSignIn());
const router = createSignInRouter(store);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SignInContext value={store}>
      <RouterProvider router={router} />
    </SignInContext>
  </StrictMode>,
);
