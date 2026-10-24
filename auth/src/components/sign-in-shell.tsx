import {
  CircleAlertIcon,
  CircleCheckIcon,
  LockKeyholeIcon,
} from "lucide-react";
import { cn } from "cn";
import type { ReactNode } from "react";
import { Toaster } from "react-hot-toast";

import { Spinner } from "@/components/ui/spinner";
import chowbotLogoUrl from "@/assets/images/chowbot-logo.svg";
import chowdeckLogoUrl from "@/assets/images/chowdeck-logo.svg";

function ConnectionMark() {
  return (
    <div
      className="mb-7 flex items-center justify-center gap-3"
      aria-hidden="true"
    >
      <img
        src={chowdeckLogoUrl}
        alt=""
        width={56}
        height={56}
        className="size-14 rounded-full"
      />
      <span className="flex gap-1">
        {[0, 1, 2].map((dot) => (
          <span key={dot} className="size-1.5 rounded-full bg-kiwi/70" />
        ))}
      </span>
      <img
        src={chowbotLogoUrl}
        alt=""
        width={56}
        height={56}
        className="size-14 rounded-full"
      />
    </div>
  );
}

export function SignInShell({
  showMark = true,
  children,
}: {
  showMark?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <Toaster
        position="top-center"
        gutter={8}
        containerStyle={{ top: "max(1rem, env(safe-area-inset-top))" }}
        toastOptions={{
          duration: 4000,
          error: {
            duration: 5000,
            iconTheme: { primary: "#e80b2e", secondary: "#fff" },
          },
          success: { iconTheme: { primary: "#02c27f", secondary: "#fff" } },
          style: {
            maxWidth: "24rem",
            padding: "0.75rem 1rem",
            borderRadius: "1rem",
            border: "1px solid #dfe7e4",
            boxShadow: "0 12px 32px -16px rgba(12, 81, 63, 0.35)",
            color: "#101b17",
            fontFamily: "inherit",
            fontSize: "0.9375rem",
            fontWeight: 500,
          },
        }}
      />
      <main className="flex flex-1 flex-col items-center px-5 pt-[max(3.5rem,10vh)] pb-8 sm:justify-center sm:pt-8">
        <div className="w-full max-w-102">
          {showMark && <ConnectionMark />}
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
