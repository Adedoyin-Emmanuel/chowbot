import cart from "@/public/screenshots/cart.png";
import payment from "@/public/screenshots/order-payment.png";
import tracking from "@/public/screenshots/order-tracking.png";

import { cn } from "@/lib/utils";

import { JollofArt, RiderArt } from "./illustrations";
import { Phone } from "./phone";
import { Dot, TornEdge } from "./shapes";

const STOPS = [
  {
    label: "Ask",
    tone: "bg-sun",
    src: cart,
    prompt: "“What's on my Chowdeck cart?”",
    caption: "Every item in your cart, with the running total.",
    alt: "Claude on an iPhone listing a cart at Item 7 (Go), Allen: chicken shawarma 4,400 naira and beef shawarma 4,200 naira, total 8,600 naira before fees.",
  },
  {
    label: "Pay",
    tone: "bg-kiwi",
    src: payment,
    prompt: "“I have made payment”",
    caption: "Paid on Chowdeck's own link, then checked with Chowdeck.",
    alt: "Claude on an iPhone showing order 43694228 created with a 5FOR5 discount and a link to pay 10,090 naira with OPay, then confirming Chowdeck shows the payment as successful.",
  },
  {
    label: "Track",
    tone: "bg-deck-pink",
    src: tracking,
    prompt: "“What's my delivery PIN?”",
    caption: "The rider's timeline, an arrival estimate and your PIN.",
    alt: "Claude on an iPhone showing the order on its way with a timeline of rider steps, an estimate of 15:50, a live tracking link and the delivery PIN 5051.",
  },
];

/*
 * The three real screenshots as stops on a delivery route, labelled like
 * the location tags on chowdeck.com's map. On wide screens a dashed road
 * links the stops and the middle one sits lower; on phones they scroll
 * sideways.
 */
export function Showcase() {
  return (
    <section aria-labelledby="showcase" className="bg-white">
      <div className="overflow-hidden bg-chow-green pt-20 pb-20 lg:pt-28 lg:pb-28">
        <div className="mx-auto grid max-w-7xl gap-6 px-4 sm:px-6 lg:grid-cols-2 lg:gap-16 lg:px-10">
          <div className="flex items-center gap-5">
            <h2 id="showcase" className="display text-[2.75rem] text-white sm:text-6xl lg:text-7xl">
              Real chats.
              <br />
              Real food.
            </h2>
            <span aria-hidden className="hidden size-28 shrink-0 place-items-center rounded-full bg-sun sm:grid lg:size-32">
              <JollofArt className="w-24 lg:w-28" />
            </span>
          </div>
          <p className="text-lg text-white/90 sm:text-2xl lg:pt-2">
            Screenshots from Claude on an iPhone, ordering shawarma in Lagos with ChowBot. It works the same in any
            assistant that supports MCP.
          </p>
        </div>

        <div className="relative mx-auto mt-16 max-w-6xl lg:mt-20 lg:px-10">
          {/* The road between the stops. Its bends meet the labels below. */}
          <svg
            aria-hidden
            viewBox="0 0 1200 200"
            preserveAspectRatio="none"
            className="absolute inset-x-10 top-0 hidden h-[200px] lg:block"
          >
            <path
              d="M0 23C90 23 120 23 200 23C360 23 440 119 600 119C760 119 840 23 1000 23C1080 23 1120 23 1200 23"
              fill="none"
              stroke="#02c27f"
              strokeWidth="5"
              strokeDasharray="14 12"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <RiderArt className="absolute top-[-46px] left-0 z-10 hidden w-28 lg:block" />

          {/* Scrolls sideways on small screens, so it is focusable for keyboard users. */}
          <div
            role="region"
            aria-label="Screenshots of ChowBot in a chat"
            tabIndex={0}
            className="snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] focus-visible:outline-offset-[-3px] lg:overflow-visible"
          >
            <ol className="flex w-max gap-6 px-6 sm:px-10 lg:grid lg:w-auto lg:grid-cols-3 lg:gap-10 lg:px-0">
              {STOPS.map((stop, index) => (
                <li
                  key={stop.label}
                  className={cn(
                    "flex w-[72vw] max-w-[300px] shrink-0 snap-center flex-col items-center lg:w-auto lg:max-w-none",
                    index === 1 && "lg:mt-24",
                  )}
                >
                  <p
                    className={cn(
                      "relative z-10 inline-flex items-center gap-2.5 rounded-lg border-[3px] border-black px-4 py-1.5 text-xl font-bold text-black",
                      stop.tone,
                    )}
                  >
                    <Dot className="bg-white" />
                    <span className="sr-only">Step {index + 1}: </span>
                    {stop.label}
                  </p>
                  <figure className="mt-8 w-full">
                    <Phone
                      src={stop.src}
                      alt={stop.alt}
                      className="mx-auto w-full max-w-[280px]"
                      sizes="(min-width: 1024px) 280px, 72vw"
                    />
                    <figcaption className="mx-auto mt-6 max-w-[280px] text-center">
                      <span className="block text-lg font-bold text-white">{stop.prompt}</span>
                      <span className="mt-1 block text-white/70">{stop.caption}</span>
                    </figcaption>
                  </figure>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
      <TornEdge className="text-chow-green" />
    </section>
  );
}
