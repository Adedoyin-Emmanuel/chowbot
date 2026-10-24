"use client";

import {
  BadgePercent,
  Bike,
  Search,
  ShoppingBasket,
  Star,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { cn } from "@/lib/utils";

import {
  BasketArt,
  JollofArt,
  NotesArt,
  ReceiptArt,
  RiderArt,
  StarsArt,
} from "./illustrations";
import { SectionHeading } from "./section-heading";

type Deck = {
  key: string;
  icon: LucideIcon;
  title: string;
  body: string;
  prompt: string;
  art: (props: { className?: string }) => React.ReactNode;
  card: string;
  accent: string;
};

// Each card maps to real ChowBot tools (mcp-server/features/*/tools.ts).
const DECKS: Deck[] = [
  {
    key: "find",
    icon: Search,
    title: "Find food",
    body: "Search for a dish or a place, see what's open near you, Chowdeck's picks and your usual spots. Full menus with every option, plus shops and pharmacies.",
    prompt: "Find jollof rice near me that's open now",
    art: JollofArt,
    card: "bg-deck-lilac",
    accent: "text-lavender",
  },
  {
    key: "cart",
    icon: ShoppingBasket,
    title: "Build your cart",
    body: "Add dishes with their options, double up or take things out, and leave notes for the kitchen and the rider. One cart per restaurant, like the app.",
    prompt: "Add another beef shawarma, no onions",
    art: BasketArt,
    card: "bg-cream",
    accent: "text-sun",
  },
  {
    key: "checkout",
    icon: BadgePercent,
    title: "Check out",
    body: "Pick a saved address or add a new one, see Chowdeck's real delivery and service fees, and apply your promo codes before anything is placed.",
    prompt: "Any promo codes I can use here?",
    art: ReceiptArt,
    card: "bg-deck-sky",
    accent: "text-[#336bad]",
  },
  {
    key: "pay",
    icon: Wallet,
    title: "Pay your way",
    body: "Card, transfer, USSD, OPay, Pocket or Zap through Chowdeck's own payment link, your Chowdeck wallet, or a pay-for-me link for someone else.",
    prompt: "Make it a pay-for-me link for my brother",
    art: NotesArt,
    card: "bg-mint",
    accent: "text-[#68b99d]",
  },
  {
    key: "track",
    icon: Bike,
    title: "Track it",
    body: "Every step from kitchen to door, an arrival estimate, the rider's name and rating, a live tracking link and the PIN they'll ask for.",
    prompt: "Where's my rider? What's my PIN?",
    art: RiderArt,
    card: "bg-deck-pink",
    accent: "text-[#d9437a]",
  },
  {
    key: "rate",
    icon: Star,
    title: "Rate it",
    body: "Once it's delivered, rate the restaurant and give each item a thumbs up or down, in your own words.",
    prompt: "Rate Item 7 five stars, it was very tasty",
    art: StarsArt,
    card: "bg-peach",
    accent: "text-tangerine",
  },
];

// Measured from chowdeck.com: closed cards are 180px, the open one ~760px.
const CLOSED = 180;
const GAP = 16;
const MAX_OPEN = 760;
// Scroll distance that moves the deck on by one card.
const STEP = 420;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/*
 * Each card holds fully open for most of its share of the scroll and hands
 * over to the next in the middle third, so cards are rarely caught halfway.
 */
const dwell = (progress: number) => {
  const card = Math.floor(progress);
  const t = clamp((progress - card - 0.35) / 0.3, 0, 1);
  return card + t * t * (3 - 2 * t);
};

/*
 * chowdeck.com's "What's on Deck?": on wide screens the section pins while
 * you scroll, the open card shrinks as the next one grows, and the row
 * slides left. Scroll position alone drives it, so it never animates on its
 * own. On phones the cards stack, all open.
 */
export function Features() {
  const sectionRef = useRef<HTMLElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [rowWidth, setRowWidth] = useState(1280);

  useEffect(() => {
    const section = sectionRef.current;
    const row = rowRef.current;
    if (!section || !row) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const travel = section.offsetHeight - window.innerHeight;
      if (travel <= 0) return setProgress(0);
      const scrolled = clamp(
        -section.getBoundingClientRect().top / travel,
        0,
        1,
      );
      setProgress(dwell(scrolled * (DECKS.length - 1)));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(([entry]) =>
      setRowWidth(entry!.contentRect.width),
    );

    resize.observe(row);
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  const open = Math.min(MAX_OPEN, rowWidth - 2 * (CLOSED + GAP));
  const total =
    DECKS.length * CLOSED + (open - CLOSED) + (DECKS.length - 1) * GAP;
  const shift = clamp(
    progress * (CLOSED + GAP),
    0,
    Math.max(0, total - rowWidth),
  );

  return (
    <section
      ref={sectionRef}
      aria-labelledby="features"
      className="px-4 pt-20 pb-24 sm:px-6 lg:h-[calc(100vh+2100px)] lg:px-10 lg:py-0"
    >
      <div className="lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:justify-center lg:pt-24">
        <SectionHeading
          id="features"
          title="What can ChowBot do?"
          intro="Everything you'd tap in the Chowdeck app, now in a sentence."
        />

        <div
          ref={rowRef}
          className="mx-auto mt-12 w-full max-w-7xl lg:mt-10 lg:overflow-hidden"
        >
          <ul
            className="flex flex-col gap-4 lg:h-[min(34rem,calc(100vh-17rem))] lg:w-max lg:translate-x-(--shift) lg:flex-row"
            style={{ "--shift": `${-shift}px` } as CSSProperties}
          >
            {DECKS.map((deck, index) => {
              const openness = clamp(1 - Math.abs(progress - index), 0, 1);
              const width = CLOSED + (open - CLOSED) * openness;
              // Never show a card's text and its sideways title at once.
              const textOpacity = clamp((openness - 0.5) / 0.2, 0, 1);
              const titleOpacity = clamp((0.5 - openness) / 0.2, 0, 1);
              return (
                <li
                  key={deck.key}
                  className={cn(
                    "relative overflow-hidden rounded-2xl border-4 border-black lg:w-(--width)",
                    deck.card,
                  )}
                  style={
                    {
                      "--width": `${width}px`,
                      "--open": textOpacity,
                      "--closed": titleOpacity,
                      "--card": `${open}px`,
                    } as CSSProperties
                  }
                >
                  <deck.icon
                    className="absolute top-7 left-7 size-11 text-black lg:top-8 lg:left-8"
                    strokeWidth={1.75}
                    aria-hidden
                  />

                  <div className="flex h-full flex-col p-7 pt-24 lg:w-(--card) lg:p-10 lg:pt-28 lg:opacity-(--open)">
                    <h3 className="display text-4xl text-black sm:text-[3.25rem]">
                      {deck.title}
                    </h3>
                    <p className="mt-4 max-w-md text-lg text-ink/85">
                      {deck.body}
                    </p>
                    <p className="mt-6 w-fit max-w-md rounded-2xl rounded-br-sm bg-black px-5 py-3 text-base font-medium text-white">
                      “{deck.prompt}”
                    </p>
                    <deck.art className="mt-8 w-full max-w-sm self-center lg:absolute lg:right-6 lg:bottom-4 lg:mt-0 lg:w-[46%] lg:max-w-none" />
                  </div>

                  <span
                    aria-hidden
                    className={cn(
                      "display pointer-events-none absolute bottom-6 left-1/2 hidden -translate-x-1/2 rotate-180 text-[3.75rem] whitespace-nowrap [writing-mode:vertical-rl] lg:block lg:opacity-(--closed)",
                      deck.accent,
                    )}
                  >
                    {deck.title}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
