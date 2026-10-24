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
 * A thin iPhone-style bezel around a real screenshot. The screenshots already
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
        "relative rounded-[2rem] bg-ink p-[5px] shadow-[inset_0_0_0_1.5px_rgba(255,255,255,0.12)] sm:p-1.5",
        className,
      )}
    >
      {/*
       * The screenshot keeps its own aspect ratio, so nothing is cropped;
       * the bezel is thin and the corner radius small enough not to clip text.
       */}
      <Image
        src={src}
        alt={alt}
        priority={priority}
        sizes={sizes}
        className="block h-auto w-full rounded-[1.65rem] bg-black"
      />
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
