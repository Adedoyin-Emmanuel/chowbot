import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type SubmitEvent } from "react";

import {
  InputOTP,
  InputOTPSlot,
  InputOTPGroup,
} from "@/components/ui/input-otp";
import { useSignIn } from "@/lib/state";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useSignInStore } from "@/lib/sign-in-context";
import { StepHeading } from "@/components/sign-in-shell";
import { SignInError, resendCode, verifyCode } from "@/lib/api";
import { clearError, showError, showSuccess } from "@/lib/toast";

/*
 * Chowdeck's codes have been six digits in every capture so far; the server
 * accepts 4–8, so a shorter code can still be submitted with the button.
 */
const CODE_LENGTH = 6;
const MIN_CODE_LENGTH = 4;
const RESEND_COOLDOWN_SECONDS = 30;

const useCountdown = (seconds: number) => {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);
  return [remaining, () => setRemaining(seconds)] as const;
};

export function OtpStep() {
  const store = useSignInStore();
  const { csrfToken, maskedPhone, sentFromPhoneStep } = useSignIn(store);
  const navigate = useNavigate();
  const router = useRouter();

  const [code, setCode] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, restartCooldown] = useCountdown(RESEND_COOLDOWN_SECONDS);
  const inFlight = useRef(false);

  const fail = (caught: unknown) => {
    const failure =
      caught instanceof SignInError
        ? caught
        : new SignInError({ message: "Something went wrong." });
    if (failure.restart) {
      clearError();
      store.update({
        ended: {
          title: failure.title ?? "Sign-in ended",
          message: failure.message,
        },
      });
      return;
    }
    setInvalid(true);
    showError(failure.message);
  };

  const verify = async (otp: string) => {
    if (inFlight.current || otp.length < MIN_CODE_LENGTH) return;
    inFlight.current = true;
    setVerifying(true);
    setInvalid(false);
    clearError();
    try {
      const { redirectUrl } = await verifyCode(csrfToken, otp);
      store.update({ redirectingTo: redirectUrl });
      window.location.assign(redirectUrl);
    } catch (caught) {
      fail(caught);
      setCode("");
      setVerifying(false);
      inFlight.current = false;
    }
  };

  const resend = async () => {
    if (resending || cooldown > 0) return;
    setResending(true);
    setInvalid(false);
    clearError();
    try {
      const { maskedPhone: sentTo } = await resendCode(csrfToken);
      store.update({ maskedPhone: sentTo });
      showSuccess(`New code sent to ${sentTo}`);
      setCode("");
      restartCooldown();
    } catch (caught) {
      fail(caught);
    } finally {
      setResending(false);
    }
  };

  // Going back keeps the original /authorize URL (and its OAuth query) intact.
  const changeNumber = () => {
    if (sentFromPhoneStep) router.history.back();
    else void navigate({ to: "/authorize", replace: true });
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (code.length < MIN_CODE_LENGTH) {
      setInvalid(true);
      showError("Enter the code Chowdeck sent you.");
      return;
    }
    void verify(code);
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
      <StepHeading title="Enter your code">
        We sent a code to{" "}
        <strong className="font-semibold text-foreground">{maskedPhone}</strong>
        .{" "}
        <button
          type="button"
          onClick={changeNumber}
          disabled={verifying}
          className="font-semibold text-cucumber underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none disabled:opacity-50"
        >
          Change
        </button>
      </StepHeading>

      <form onSubmit={submit} noValidate className="grid gap-5">
        <div className="flex justify-center">
          <InputOTP
            maxLength={CODE_LENGTH}
            pattern={REGEXP_ONLY_DIGITS}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(value) => {
              setCode(value);
              if (invalid) {
                setInvalid(false);
                clearError();
              }
            }}
            onComplete={(value: string) => void verify(value)}
            disabled={verifying}
            aria-label="One-time code"
            aria-invalid={invalid || undefined}
            containerClassName="gap-2"
          >
            <InputOTPGroup className="gap-2 sm:gap-2.5">
              {Array.from({ length: CODE_LENGTH }, (_, index) => (
                <InputOTPSlot
                  key={index}
                  index={index}
                  aria-invalid={invalid || undefined}
                  className="size-12 rounded-xl border border-transparent bg-muted text-xl font-bold first:rounded-xl last:rounded-xl data-[active=true]:border-kiwi sm:size-13"
                />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>

        <Button
          type="submit"
          size="lg"
          disabled={verifying}
          className="h-15 w-full rounded-2xl text-base font-semibold hover:bg-cucumber"
        >
          {verifying ? (
            <>
              <Spinner className="size-5" />
              Verifying…
            </>
          ) : (
            "Verify and continue"
          )}
        </Button>

        <p className="text-center text-sm text-muted-foreground">
          Didn't get it?{" "}
          <button
            type="button"
            onClick={() => void resend()}
            disabled={resending || verifying || cooldown > 0}
            className="inline-flex items-center gap-1.5 font-semibold text-chow-green underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
          >
            {resending && <Spinner className="size-3.5" />}
            {resending
              ? "Sending…"
              : cooldown > 0
                ? `Resend in ${cooldown}s`
                : "Resend code"}
          </button>
        </p>
      </form>
    </div>
  );
}
