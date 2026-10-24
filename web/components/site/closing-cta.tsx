import { ArrowRight } from "lucide-react";

import tracking from "@/public/screenshots/order-tracking.png";

import { Phone } from "./phone";
import { Dot } from "./shapes";

// Laid out like chowdeck.com's "Place your order in seconds" pair of cards.
export function ClosingCta() {
  return (
    <section
      aria-labelledby="closing"
      className="bg-black px-4 pb-20 sm:px-6 lg:px-10 lg:pb-28"
    >
      <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-2">
        <div className="flex flex-col rounded-2xl bg-chow-green p-8 sm:p-10">
          <h2 id="closing" className="display text-4xl text-white sm:text-5xl">
            Place your order <br className="hidden sm:block" />
            in a sentence
          </h2>
          <div className="mt-7 flex flex-wrap gap-3">
            <a
              href="#connect"
              className="inline-flex items-center gap-2 rounded-lg bg-white px-5 py-3 font-semibold text-chow-green transition-colors hover:bg-hero"
            >
              Connect ChowBot
              <ArrowRight className="size-4" aria-hidden />
            </a>
            <a
              href="#faq"
              className="inline-flex items-center rounded-lg px-5 py-3 font-semibold text-white ring-1 ring-white/40 transition-colors hover:bg-white/10"
            >
              Read the FAQ
            </a>
          </div>
          <div className="mt-auto pt-10">
            <p className="inline-flex items-center gap-3 rounded-lg border-4 border-black bg-sun px-4 py-2.5 text-base font-bold text-black sm:text-lg">
              <Dot className="border-black bg-chow-green" />
              “What&apos;s on my Chowdeck cart?”
            </p>
            <p className="mt-2 text-sm text-white/80">
              Try this first once you&apos;re connected.
            </p>
          </div>
        </div>

        {/* The phone sits to the right and runs off the bottom edge. */}
        <div className="relative min-h-[20rem] overflow-hidden rounded-2xl bg-lavender p-8 sm:min-h-[22rem] sm:p-10">
          <p className="display max-w-[58%] text-3xl text-black sm:text-5xl">
            Works wherever your assistant does
          </p>
          <p className="mt-4 max-w-[50%] text-base text-black/80 sm:text-lg">
            Claude, ChatGPT or any MCP app, on the web, desktop or phone.
          </p>
          <Phone
            src={tracking}
            alt="Claude on an iPhone showing an order on its way and the delivery PIN 5051."
            className="absolute top-10 right-5 w-[38%] max-w-[230px] rotate-6 sm:right-10"
            sizes="230px"
          />
        </div>
      </div>
    </section>
  );
}
