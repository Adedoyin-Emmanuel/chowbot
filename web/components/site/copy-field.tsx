"use client";

import { Check, Copy, Plug } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

type CopyFieldProps = {
  id: string;
  value: string;
  label: string;
  className?: string;
  variant?: "outline" | "bar";
};

export function CopyField({
  id,
  value,
  label,
  className,
  variant = "outline",
}: CopyFieldProps) {
  const bar = variant === "bar";
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      inputRef.current?.select();
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        "flex w-full items-center gap-2 rounded-full bg-white p-1.5",
        bar ? "h-16 pl-4 sm:p-2 sm:pl-5" : "border-2 border-ink pl-5",
        className,
      )}
    >
      {bar && <Plug className="size-5 shrink-0 text-kiwi" aria-hidden />}
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        readOnly
        value={value}
        onFocus={(event) => event.currentTarget.select()}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-ink outline-none",
          bar
            ? "text-base text-ink/70 sm:text-lg"
            : "font-mono text-sm sm:text-base",
        )}
      />
      <button
        type="button"
        onClick={copy}
        className={cn(
          "inline-flex h-full shrink-0 items-center gap-2 rounded-full font-semibold text-white transition-colors",
          bar
            ? "bg-cucumber px-5 text-base hover:bg-chow-green sm:px-6"
            : "bg-chow-green px-4 py-2.5 text-sm hover:bg-cucumber",
        )}
      >
        {copied ? (
          <Check className="size-4" aria-hidden />
        ) : (
          <Copy className="size-4" aria-hidden />
        )}
        {copied ? "Copied" : bar ? "Copy URL" : "Copy"}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Connector URL copied to clipboard" : ""}
      </span>
    </div>
  );
}
