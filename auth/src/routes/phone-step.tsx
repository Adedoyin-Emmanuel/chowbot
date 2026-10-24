import { ArrowRightIcon } from "lucide-react";
import { cn } from "cn";
import { useState, type ReactNode, type SubmitEvent } from "react";
import { useNavigate } from "@tanstack/react-router";

import {
  COUNTRIES,
  isValidNational,
  localDigits,
  nationalDigits,
  toInternational,
  type CountryCode,
} from "@/lib/phone";
import {
  Select,
  SelectItem,
  SelectValue,
  SelectContent,
  SelectTrigger,
} from "@/components/ui/select";
import { useSignIn } from "@/lib/state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SignInError, requestCode } from "@/lib/api";
import { useSignInStore } from "@/lib/sign-in-context";
import { StepHeading } from "@/components/sign-in-shell";
import { clearError, showError, showSuccess } from "@/lib/toast";

// Chowdeck form labels: small, bold, spaced capitals with a red asterisk.
function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <Label
      htmlFor={htmlFor}
      className="gap-0.5 text-xs font-extrabold tracking-[0.15em] uppercase"
    >
      {children}
      <span className="text-pepper" aria-hidden="true">
        *
      </span>
    </Label>
  );
}

// Drawn rather than an emoji, which Windows shows as the letters "NG".
function NigeriaFlag() {
  return (
    <svg viewBox="0 0 3 2" className="h-4 w-6 rounded-[2px]" aria-hidden="true">
      <rect width="3" height="2" fill="#008751" />
      <rect x="1" width="1" height="2" fill="#fff" />
    </svg>
  );
}

const FIELD = "h-15 rounded-2xl border-0 bg-muted";

export function PhoneStep() {
  const store = useSignInStore();
  const { csrfToken, clientName } = useSignIn(store);
  const navigate = useNavigate();

  const [country, setCountry] = useState<CountryCode>("NG");
  const [phone, setPhone] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const dialCode = COUNTRIES.find((entry) => entry.code === country)!.dialCode;

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const digits = nationalDigits(phone);
    if (!isValidNational(digits)) {
      setInvalid(true);
      showError("Enter a valid Nigerian mobile number, e.g. 08012345678.");
      return;
    }
    setInvalid(false);
    clearError();
    setSubmitting(true);
    try {
      const { maskedPhone } = await requestCode(
        csrfToken,
        toInternational(digits, dialCode),
      );
      store.update({ maskedPhone, sentFromPhoneStep: true });
      showSuccess(`Code sent to ${maskedPhone}`);
      await navigate({ to: "/authorize/verify" });
    } catch (caught) {
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
      } else {
        setInvalid(true);
        showError(failure.message);
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
      <StepHeading title="Sign in with Chowdeck">
        to continue to{" "}
        <strong className="font-semibold text-foreground">{clientName}</strong>
      </StepHeading>

      <form onSubmit={submit} noValidate className="grid gap-4">
        <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5">
          <FieldLabel htmlFor="country">Country</FieldLabel>
          <FieldLabel htmlFor="phone">Phone number</FieldLabel>
          <Select
            value={country}
            onValueChange={(value) => setCountry(value as CountryCode)}
            disabled={submitting}
          >
            <SelectTrigger
              id="country"
              className={cn(
                FIELD,
                "w-full justify-center gap-4 px-3 data-[size=default]:h-15 [&_svg]:opacity-100 [&>svg]:size-5 [&>svg]:text-cucumber!",
              )}
            >
              <SelectValue>
                <NigeriaFlag />
                <span className="sr-only">
                  {COUNTRIES.find((entry) => entry.code === country)!.name}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" className="rounded-xl">
              {COUNTRIES.map((entry) => (
                <SelectItem
                  key={entry.code}
                  value={entry.code}
                  className="gap-2.5 py-2 text-base"
                >
                  <NigeriaFlag />
                  <span>{entry.name}</span>
                  <span className="text-muted-foreground">
                    {entry.dialCode}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div
            className={cn(
              FIELD,
              "flex items-center gap-2.5 px-5 transition-[box-shadow] focus-within:ring-[3px] focus-within:ring-ring/50",
              invalid && "ring-2 ring-pepper/40 focus-within:ring-pepper/40",
              submitting && "opacity-50",
            )}
          >
            <span className="text-base font-semibold text-foreground">
              {dialCode}
            </span>
            <Input
              id="phone"
              name="phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="08000000000"
              autoFocus
              maxLength={20}
              value={phone}
              onChange={(event) => {
                setPhone(localDigits(event.target.value));
                if (invalid) {
                  setInvalid(false);
                  clearError();
                }
              }}
              disabled={submitting}
              aria-invalid={invalid || undefined}
              aria-describedby="phone-hint"
              className="h-full rounded-none border-0 bg-transparent p-0 text-base font-medium tracking-wide focus-visible:ring-0 aria-invalid:ring-0 disabled:opacity-100 md:text-base"
            />
          </div>
        </div>
        <p id="phone-hint" className="text-[0.8125rem] text-muted-foreground">
          Use the number on your Chowdeck account. We'll text you a code.
        </p>

        <Button
          type="submit"
          size="lg"
          disabled={submitting}
          className="mt-2 h-15 w-full rounded-2xl text-base font-semibold hover:bg-cucumber"
        >
          {submitting ? (
            <>
              <Spinner className="size-5" />
              Sending code…
            </>
          ) : (
            <>
              Continue
              <ArrowRightIcon className="size-5" aria-hidden="true" />
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
