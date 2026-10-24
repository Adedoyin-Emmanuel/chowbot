import Image, { type StaticImageData } from "next/image";

import { cn } from "@/lib/utils";

type PhoneProps = {
  src: StaticImageData;
  alt: string;
  className?: string;
  priority?: boolean;
  sizes?: string;
};

/*
 * An iPhone-style bezel around a real screenshot. The screenshots already
 * include the status bar and Dynamic Island, so the frame is only the body.
 */
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
        "relative aspect-[721/1567] rounded-[2.6rem] bg-ink p-[3.2%] shadow-[inset_0_0_0_1.5px_rgba(255,255,255,0.12)]",
        className,
      )}
    >
      <div className="relative h-full w-full overflow-hidden rounded-[2.2rem] bg-black">
        <Image
          src={src}
          alt={alt}
          fill
          priority={priority}
          sizes={sizes}
          className="object-cover object-top"
        />
      </div>
      <span
        aria-hidden
        className="absolute top-[18%] -left-[3px] h-[6%] w-[3px] rounded-l bg-ink"
      />
      <span
        aria-hidden
        className="absolute top-[27%] -left-[3px] h-[9%] w-[3px] rounded-l bg-ink"
      />
      <span
        aria-hidden
        className="absolute top-[24%] -right-[3px] h-[12%] w-[3px] rounded-r bg-ink"
      />
    </div>
  );
}
