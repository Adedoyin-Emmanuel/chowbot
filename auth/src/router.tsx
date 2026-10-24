import {
  Outlet,
  redirect,
  createRoute,
  createRouter,
  createRootRouteWithContext,
} from "@tanstack/react-router";

import {
  EndedView,
  SignInShell,
  RedirectingView,
} from "@/components/sign-in-shell";
import { OtpStep } from "@/routes/otp-step";
import { PhoneStep } from "@/routes/phone-step";
import { useSignInStore } from "@/lib/sign-in-context";
import { useSignIn, type SignInStore } from "@/lib/state";

type RouterContext = { signIn: SignInStore };

/*
 * The server owns the flow: it serves this app at /authorize (phone step)
 * and /authorize/verify (code step, e.g. after a refresh) and embeds which
 * step the sign-in is on. An ended sign-in replaces whichever step is shown.
 */
function Root() {
  const store = useSignInStore();
  const { clientName, ended, redirectingTo } = useSignIn(store);

  return (
    <SignInShell showMark={!ended}>
      {ended ? (
        <EndedView title={ended.title} message={ended.message} />
      ) : redirectingTo ? (
        <RedirectingView clientName={clientName} />
      ) : (
        <Outlet />
      )}
    </SignInShell>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: () => (
    <EndedView
      title="Page not found"
      message="Start again from your assistant."
    />
  ),
});

const phoneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/authorize",
  component: PhoneStep,
});

const verifyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/authorize/verify",
  beforeLoad: ({ context }) => {
    if (!context.signIn.get().maskedPhone)
      throw redirect({ to: "/authorize", replace: true });
  },
  component: OtpStep,
});

const routeTree = rootRoute.addChildren([phoneRoute, verifyRoute]);

export const createSignInRouter = (signIn: SignInStore) =>
  createRouter({ routeTree, context: { signIn }, defaultPreload: false });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createSignInRouter>;
  }
}
