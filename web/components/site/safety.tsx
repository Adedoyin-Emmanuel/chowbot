import { Burst, HalfCircle, Sparkle } from "./shapes";
import { SectionHeading } from "./section-heading";

const POINTS = [
  {
    mark: <Burst className="size-6 text-tangerine" />,
    title: "Sign in on ChowBot's own page",
    body: "You enter your Chowdeck number and the code Chowdeck texts you on ChowBot's sign-in page, not in the chat.",
  },
  {
    mark: <HalfCircle className="h-4 w-8 text-kiwi" />,
    title: "Your session stays with ChowBot",
    body: "Your Chowdeck session is kept on ChowBot's server and is never handed to the assistant.",
  },
  {
    mark: <Sparkle className="size-6 text-lavender" />,
    title: "Chowdeck takes the payment",
    body: "Payment links open Chowdeck's own payment flow. ChowBot never asks for your card or bank details.",
  },
  {
    mark: <HalfCircle className="h-4 w-8 text-deck-pink" />,
    title: "Nothing happens unless you ask",
    body: "An order is placed only when you say so, after you've seen the total. If the total changes, nothing is sent.",
  },
  {
    mark: <Sparkle className="size-6 text-sun" />,
    title: "Unpaid means uncharged",
    body: "An order isn't paid until you pay it, so you can still change items, notes or the address before then.",
  },
  {
    mark: <Burst className="size-6 text-deck-sky" />,
    title: "Disconnect any time",
    body: "Remove ChowBot from your assistant's connector settings whenever you like.",
  },
];

export function Safety() {
  return (
    <section
      aria-labelledby="safety"
      className="px-4 py-20 sm:px-6 lg:px-10 lg:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          id="safety"
          title="Your account. Your call."
          intro="ChowBot acts on your Chowdeck account only because you signed it in, and only when you ask."
        />
        <ul className="mt-14 grid border-t-4 border-black sm:grid-cols-2 sm:gap-x-10 lg:grid-cols-3 lg:gap-x-14">
          {POINTS.map((point) => (
            <li key={point.title} className="border-b border-ink/15 py-8">
              <div className="flex h-6 items-center">{point.mark}</div>
              <h3 className="mt-4 text-xl font-bold tracking-tight text-black">
                {point.title}
              </h3>
              <p className="mt-2 text-ink/80">{point.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
