import Image, { type StaticImageData } from "next/image";

import { cn } from "@/lib/utils";

type PhoneProps = {
  alt: string;
  sizes?: string;
  priority?: boolean;
  className?: string;
  src: StaticImageData;
};


export function Phone({
  src,
  alt,
  className,
  priority,
  sizes = "(min-width: 1024px) 300px, 60vw",
}: PhoneProps) {
  return (
    <div
      className={cn(
        "relative rounded-4xl bg-ink p-1.25 shadow-[inset_0_0_0_1.5px_rgba(255,255,255,0.12)] sm:p-1.5",
        className,
      )}
    >

      <Image
        src={src}
        alt={alt}
        priority={priority}
        sizes={sizes}
        className="block h-auto w-full rounded-[1.65rem] bg-black"
      />
      <span
        aria-hidden
        className="absolute top-[18%] -left-0.75 h-[6%] w-0.75 rounded-l bg-ink"
      />
      <span
        aria-hidden
        className="absolute top-[27%] -left-0.75 h-[9%] w-0.75 rounded-l bg-ink"
      />
      <span
        aria-hidden
        className="absolute top-[24%] -right-0.75 h-[12%] w-0.75 rounded-r bg-ink"
      />
    </div>
  );
}
