import { cn } from "@/lib/utils";

type SectionHeadingProps = {
  id: string;
  title: React.ReactNode;
  intro?: React.ReactNode;
  tone?: "light" | "dark";
  align?: "center" | "left";
  className?: string;
};

// chowdeck.com's section titles: one colour, bold, tight, with a short line under.
export function SectionHeading({
  id,
  title,
  intro,
  tone = "light",
  align = "center",
  className,
}: SectionHeadingProps) {
  const dark = tone === "dark";
  return (
    <div
      className={cn(
        "max-w-3xl",
        align === "center" ? "mx-auto text-center" : "text-left",
        className,
      )}
    >
      <h2
        id={id}
        className={cn(
          "display text-[2.75rem] sm:text-6xl",
          dark ? "text-white" : "text-black",
        )}
      >
        {title}
      </h2>
      {intro ? (
        <p
          className={cn(
            "mt-5 text-lg sm:text-xl",
            dark ? "text-white/80" : "text-ink/80",
          )}
        >
          {intro}
        </p>
      ) : null}
    </div>
  );
}
