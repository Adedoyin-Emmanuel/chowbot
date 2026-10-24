import { ArrowRightIcon } from "lucide-react";
import { useState, type SubmitEvent } from "react";
import { useNavigate } from "@tanstack/react-router";

import {
  COUNTRIES,
  formatNational,
  isValidNational,
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
import { Alert, AlertDescription } from "@/components/ui/alert";

export function PhoneStep() {
  const store = useSignInStore();
  const { csrfToken, clientName } = useSignIn(store);
  const navigate = useNavigate();

  const [country, setCountry] = useState<CountryCode>("NG");
  const [digits, setDigits] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const dialCode = COUNTRIES.find((entry) => entry.code === country)!.dialCode;

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    if (!isValidNational(digits)) {
      setError("Enter a valid Nigerian mobile number, e.g. 801 234 5678.");
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      const { maskedPhone } = await requestCode(
        csrfToken,
        toInternational(digits, dialCode),
      );
      store.update({ maskedPhone, sentFromPhoneStep: true });
      await navigate({ to: "/authorize/verify" });
    } catch (caught) {
      const failure =
        caught instanceof SignInError
          ? caught
          : new SignInError({ message: "Something went wrong." });
      if (failure.restart) {
        store.update({
          ended: {
            title: failure.title ?? "Sign-in ended",
            message: failure.message,
          },
        });
      } else {
        setError(failure.message);
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
        <div className="grid gap-2">
          <Label htmlFor="phone" className="text-sm font-semibold">
            Phone number
          </Label>
          <div className="flex gap-2">
            <Select
              value={country}
              onValueChange={(value) => setCountry(value as CountryCode)}
              disabled={submitting}
            >
              <SelectTrigger
                aria-label="Country code"
                className="!h-12 w-[7.5rem] shrink-0 gap-1.5 rounded-xl px-3 text-base font-medium"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" className="rounded-xl">
                {COUNTRIES.map((entry) => (
                  <SelectItem
                    key={entry.code}
                    value={entry.code}
                    className="py-2 text-base"
                  >
                    <span aria-hidden="true">{entry.flag}</span>
                    <span>{entry.dialCode}</span>
                    <span className="sr-only">{entry.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              id="phone"
              name="phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="801 234 5678"
              autoFocus
              maxLength={20}
              value={formatNational(digits)}
              onChange={(event) => {
                setDigits(nationalDigits(event.target.value));
                if (error) setError(undefined);
              }}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "phone-error" : "phone-hint"}
              className="h-12 rounded-xl px-4 text-base font-medium tracking-wide md:text-base"
            />
          </div>
          {!error && (
            <p
              id="phone-hint"
              className="text-[0.8125rem] text-muted-foreground"
            >
              Use the number on your Chowdeck account. We'll text you a code.
            </p>
          )}
        </div>

        {error && (
          <Alert
            id="phone-error"
            variant="destructive"
            className="animate-in fade-in rounded-xl border-pepper/25 bg-pepper/5"
          >
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button
          type="submit"
          size="lg"
          disabled={submitting}
          className="mt-1 h-12 w-full rounded-full text-base font-semibold hover:bg-cucumber"
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
