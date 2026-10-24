import { ArrowDown, ArrowRight } from "lucide-react";

import { Burst, HalfCircle, Sparkle } from "./shapes";

const STEPS = [
  {
    mark: <Burst className="size-7 text-tangerine" />,
    title: "Add the connector",
    body: "In your assistant's settings, add ChowBot as a custom MCP connector with its URL. In Claude, that's Settings, then Connectors.",
    link: { href: "#connect", label: "Get the URL" },
  },
  {
    mark: <HalfCircle className="h-5 w-10 text-kiwi" />,
    title: "Sign in to Chowdeck",
    body: "Your assistant opens ChowBot's sign-in page. Enter the number on your Chowdeck account and the code Chowdeck texts you.",
    link: { href: "#safety", label: "How it's kept safe" },
  },
  {
    mark: <Sparkle className="size-8 text-lavender" />,
    title: "Just ask",
    body: "Talk the way you'd text a friend. Your assistant uses ChowBot to search, fill your cart, check out and track the order.",
    link: { href: "#showcase", label: "See real chats" },
  },
];

export function HowItWorks() {
  return (
    <section
      aria-labelledby="how-it-works"
      className="px-4 py-24 sm:px-6 lg:px-10 lg:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <h2
          id="how-it-works"
          className="flex items-center justify-center gap-3 text-center text-[2.5rem] leading-none font-bold tracking-[-0.03em] text-gray-400 sm:text-6xl lg:text-[4rem]"
        >
          Three steps, then just talk
          <ArrowDown
            className="hidden size-14 shrink-0 sm:block"
            strokeWidth={2.5}
            aria-hidden
          />
        </h2>

        <ol className="mt-14 grid gap-6 lg:grid-cols-3">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="flex flex-col rounded-2xl border-4 border-black p-7 sm:p-8"
            >
              <div className="flex h-8 items-center">{step.mark}</div>
              <h3 className="display mt-5 text-3xl text-black">
                <span className="sr-only">Step {index + 1}: </span>
                {step.title}
              </h3>
              <p className="mt-4 flex-1 text-ink/85">{step.body}</p>
              <a
                href={step.link.href}
                className="label-caps mt-8 inline-flex items-center gap-2 text-black hover:text-cucumber"
              >
                <span className="link-underline">{step.link.label}</span>
                <ArrowRight className="size-4" aria-hidden />
              </a>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
