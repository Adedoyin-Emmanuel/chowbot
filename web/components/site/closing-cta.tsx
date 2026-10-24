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
          <h2 id="closing" className="display text-5xl text-white sm:text-6xl">
            Place your order <br className="hidden sm:block" />
            in a sentence
          </h2>
          <div className="mt-9 flex flex-col items-start gap-4">
            <a
              href="#connect"
              className="inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3 font-semibold text-chow-green transition-colors hover:bg-hero"
            >
              Connect ChowBot
              <ArrowRight className="size-4" aria-hidden />
            </a>
            <a
              href="#faq"
              className="inline-flex items-center rounded-lg bg-white px-6 py-3 font-semibold text-chow-green transition-colors hover:bg-hero"
            >
              Read the FAQ
            </a>
          </div>
          <div className="mt-auto pt-14">
            <p className="inline-flex items-center gap-3 rounded-lg border-4 border-black bg-sun px-5 py-3 text-lg font-bold text-black sm:text-xl">
              <Dot className="border-black bg-chow-green" />
              “What&apos;s on my Chowdeck cart?”
            </p>
            <p className="mt-3 text-white">
              Try this first once you&apos;re connected.
            </p>
          </div>
        </div>

        <div className="relative min-h-[34rem] overflow-hidden rounded-2xl bg-lavender p-8 sm:p-10">
          <p className="display max-w-sm text-4xl text-black sm:text-5xl">
            Works wherever your assistant does
          </p>
          <p className="mt-4 max-w-xs text-lg text-black/80">
            Claude, ChatGPT or any MCP app, on the web, desktop or phone.
          </p>
          <Phone
            src={tracking}
            alt="Claude on an iPhone showing an order on its way and the delivery PIN 5051."
            className="absolute top-64 left-1/2 w-[62%] max-w-[280px] -translate-x-1/2 rotate-6 sm:top-60"
            sizes="300px"
          />
        </div>
      </div>
    </section>
  );
}
