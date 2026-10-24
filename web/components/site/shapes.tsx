import { cn } from "@/lib/utils";

/*
 * The small flat shapes chowdeck.com uses as bullets and card marks, and the
 * cloud and torn-paper edges between its sections. All decorative.
 */
type ShapeProps = { className?: string };

export function Burst({ className }: ShapeProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-6", className)}>
      <path
        fill="currentColor"
        d="M12 0l2.6 4.1L19.4 3l-.9 4.8L23 10.1l-3.7 3.1 1.4 4.7-4.9-.2L13.9 22 12 17.5 10.1 22l-1.9-4.3-4.9.2 1.4-4.7L1 10.1l4.5-2.3L4.6 3l4.8 1.1z"
      />
    </svg>
  );
}

export function HalfCircle({ className }: ShapeProps) {
  return (
    <svg viewBox="0 0 24 12" aria-hidden className={cn("h-3 w-6", className)}>
      <path fill="currentColor" d="M0 12a12 12 0 0124 0z" />
    </svg>
  );
}

export function Sparkle({ className }: ShapeProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-6", className)}>
      <path
        fill="currentColor"
        d="M12 0c.8 6.4 5.6 11.2 12 12-6.4.8-11.2 5.6-12 12-.8-6.4-5.6-11.2-12-12C6.4 11.2 11.2 6.4 12 0z"
      />
    </svg>
  );
}

export function Dot({ className }: ShapeProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-3 rounded-full border-[3px] border-ink",
        className,
      )}
    />
  );
}

export function Cloud({ className }: ShapeProps) {
  return (
    <svg viewBox="0 0 220 90" aria-hidden className={className}>
      <path
        fill="#fff"
        stroke="#fde7b0"
        strokeWidth="6"
        d="M30 84c-15 0-26-10-26-23s11-23 26-23c2-17 17-30 35-30 12 0 23 6 29 15 5-4 12-7 19-7 15 0 28 11 30 25 4-2 9-3 13-3 17 0 31 13 31 29 0 9-7 17-17 17z"
      />
    </svg>
  );
}

/* The bumpy white edge chowdeck.com's hero sinks into. */
export function CloudEdge({ className }: ShapeProps) {
  return (
    <svg
      viewBox="0 0 1440 80"
      preserveAspectRatio="none"
      aria-hidden
      className={cn("block h-12 w-full sm:h-20", className)}
    >
      <path
        fill="#fff"
        d="M0 80V52Q52 6 105 52Q167 20 229 52Q286 9 342 52Q407 6 472 52Q519 24 566 52Q640 9 714 52Q767 7 820 52Q872 18 924 52Q992 9 1059 52Q1121 7 1183 52Q1243 12 1303 52Q1368 20 1433 52Q1436 20 1440 52V80Z"
      />
    </svg>
  );
}

/* The torn-paper edge under chowdeck.com's dark green section. */
export function TornEdge({ className }: ShapeProps) {
  return (
    <svg
      viewBox="0 0 1440 60"
      preserveAspectRatio="none"
      aria-hidden
      className={cn("block h-10 w-full sm:h-14", className)}
    >
      <path
        fill="currentColor"
        d="M0 0H1440V30L1440 30L1436 46L1413 35L1379 25L1359 41L1332 36L1291 32L1245 37L1211 31L1175 24L1150 46L1110 27L1085 31L1056 36L1020 36L992 46L961 39L922 37L898 41L879 40L859 44L824 25L795 28L757 40L721 25L698 43L654 39L627 40L606 39L584 35L557 26L522 23L497 23L467 40L431 23L395 42L357 29L336 40L292 23L261 39L241 29L221 35L190 24L171 28L137 23L101 33L80 39L60 23L22 34L0 32Z"
      />
    </svg>
  );
}
