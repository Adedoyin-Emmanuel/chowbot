import {
  CircleAlertIcon,
  CircleCheckIcon,
  LockKeyholeIcon,
} from "lucide-react";
import { cn } from "cn";
import type { ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner";
import logoUrl from "@/assets/images/chowbot-logo.svg";

/*
 * ChowBot's own mark next to the app being connected. The logo is
 * ChowBot's, never Chowdeck's.
 */
function ConnectionMark({ clientName }: { clientName?: string }) {
  const initial =
    clientName && clientName !== "your assistant"
      ? clientName.trim().charAt(0).toUpperCase()
      : undefined;
  return (
    <div
      className="mb-7 flex items-center justify-center gap-3"
      aria-hidden="true"
    >
      <img
        src={logoUrl}
        alt=""
        width={56}
        height={56}
        className="size-14 rounded-full shadow-sm"
      />
      {initial && (
        <>
          <span className="flex gap-1">
            {[0, 1, 2].map((dot) => (
              <span key={dot} className="size-1.5 rounded-full bg-kiwi/70" />
            ))}
          </span>
          <span className="flex size-14 items-center justify-center rounded-full border border-border bg-cream text-xl font-bold text-chow-green shadow-sm">
            {initial}
          </span>
        </>
      )}
    </div>
  );
}

export function SignInShell({
  clientName,
  children,
}: {
  clientName?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-white sm:bg-[radial-gradient(120%_80%_at_50%_0%,var(--color-accent)_0%,var(--color-cream)_55%,#fff_100%)]">
      <main className="flex flex-1 flex-col items-center px-5 pt-[max(3.5rem,10vh)] pb-8 sm:justify-center sm:pt-8">
        <div className="w-full max-w-[24rem] sm:rounded-3xl sm:border sm:border-border/70 sm:bg-white sm:px-9 sm:py-10 sm:shadow-[0_24px_60px_-28px_rgba(12,81,63,0.35)]">
          <ConnectionMark clientName={clientName} />
          {children}
        </div>
      </main>
      <footer className="flex flex-col items-center gap-1 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-center text-[0.6875rem] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <LockKeyholeIcon className="size-3" aria-hidden="true" />
          You sign in with a one-time code from Chowdeck.
        </span>
        <span className="opacity-80">
          ChowBot · Not affiliated with Chowdeck
        </span>
      </footer>
    </div>
  );
}

export function StepHeading({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="mb-7 text-center">
      <h1 className="text-[1.625rem] leading-tight font-extrabold tracking-[-0.02em] text-foreground">
        {title}
      </h1>
      {children && (
        <p className="mt-2 text-[0.9375rem] text-muted-foreground">
          {children}
        </p>
      )}
    </header>
  );
}

function StatusIcon({
  tone,
  children,
}: {
  tone: "error" | "success";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto mb-5 flex size-14 items-center justify-center rounded-full",
        tone === "error"
          ? "bg-pepper/10 text-pepper"
          : "bg-kiwi/15 text-cucumber",
      )}
      aria-hidden="true"
    >
      {children}
    </div>
  );
}

export function EndedView({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <div className="text-center animate-in fade-in duration-300">
      <StatusIcon tone="error">
        <CircleAlertIcon className="size-7" />
      </StatusIcon>
      <StepHeading title={title}>{message}</StepHeading>
      <p className="rounded-2xl bg-muted px-4 py-3 text-sm text-muted-foreground">
        You can close this page and connect ChowBot again from your assistant.
      </p>
    </div>
  );
}

export function RedirectingView({ clientName }: { clientName: string }) {
  return (
    <div
      className="text-center animate-in fade-in zoom-in-95 duration-300"
      aria-live="polite"
    >
      <StatusIcon tone="success">
        <CircleCheckIcon className="size-7" />
      </StatusIcon>
      <StepHeading title="You're signed in">
        Taking you back to {clientName}…
      </StepHeading>
      <div className="flex justify-center text-chow-green">
        <Spinner className="size-6" />
      </div>
    </div>
  );
}
