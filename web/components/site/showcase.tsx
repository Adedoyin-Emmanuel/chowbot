import cart from "@/public/screenshots/cart.png";
import payment from "@/public/screenshots/order-payment.png";
import tracking from "@/public/screenshots/order-tracking.png";

import { cn } from "@/lib/utils";

import { Phone } from "./phone";
import { Burst, HalfCircle, Sparkle, TornEdge } from "./shapes";


const SHOTS = [
  {
    src: cart,
    prompt: "“What's on my Chowdeck cart?”",
    caption: "Every item with the running total.",
    alt: "Claude on an iPhone listing a cart at Item 7 (Go), Allen: chicken shawarma 4,400 naira and beef shawarma 4,200 naira, total 8,600 naira before fees.",
  },
  {
    src: payment,
    prompt: "“I have made payment”",
    caption: "Paid through Chowdeck's own link, then checked.",
    alt: "Claude on an iPhone showing order 43694228 created with a 5FOR5 discount and a link to pay 10,090 naira with OPay, then confirming Chowdeck shows the payment as successful.",
  },
  {
    src: tracking,
    prompt: "“What's my delivery PIN?”",
    caption: "Rider timeline, arrival estimate and PIN.",
    alt: "Claude on an iPhone showing the order on its way with a timeline of rider steps, an estimate of 15:50, a live tracking link and the delivery PIN 5051.",
  },
];

// Laid out like chowdeck.com's dark green "Chowdeck has you covered" section.
export function Showcase() {
  return (
    <section aria-labelledby="showcase" className="bg-white">
      <div className="bg-chow-green pt-20 pb-16 lg:pt-28 lg:pb-24">
        <div className="mx-auto grid max-w-7xl gap-6 px-4 sm:px-6 lg:grid-cols-2 lg:gap-16 lg:px-10">
          <h2
            id="showcase"
            className="display text-[2.75rem] text-white sm:text-6xl lg:text-7xl"
          >
            Real chats.
            <br />
            Real food.
          </h2>
          <p className="text-lg text-white/90 sm:text-2xl lg:pt-2">
            These are screenshots from Claude on an iPhone, ordering shawarma in
            Lagos with ChowBot. It works the same in any assistant that
            supports MCP.
          </p>
        </div>


        {/* Scrolls sideways on small screens, so it is focusable for keyboard users. */}
        <div
          role="region"
          aria-label="Screenshots of ChowBot in a chat"
          tabIndex={0}
          className="mx-auto mt-16 max-w-6xl snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] focus-visible:outline-offset-[-3px] lg:overflow-visible"
        >
          <ul className="flex w-max gap-6 px-6 sm:px-10 lg:grid lg:w-auto lg:grid-cols-3 lg:gap-12">
            {SHOTS.map((shot, index) => (
              <li
                key={shot.prompt}
                className={cn(
                  "w-[70vw] max-w-[300px] shrink-0 snap-center lg:w-auto lg:max-w-none",
                  index === 1 && "lg:-mt-8",
                )}
              >
                <figure>
                  <Phone
                    src={shot.src}
                    alt={shot.alt}
                    className="mx-auto w-full max-w-[290px] ring-8 ring-white/10"
                    sizes="(min-width: 1024px) 290px, 70vw"
                  />
                  <figcaption className="mt-6 text-center">
                    <span className="block text-lg font-bold text-white">
                      {shot.prompt}
                    </span>
                    <span className="mt-1 block text-white/70">
                      {shot.caption}
                    </span>
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <TornEdge className="text-chow-green" />
    </section>
  );
}
