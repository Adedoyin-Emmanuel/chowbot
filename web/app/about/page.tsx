import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";

import {
  Burst,
  Cloud,
  Sparkle,
  CloudEdge,
  HalfCircle,
} from "@/components/site/shapes";
import { LINKS } from "@/lib/site";
import { Footer } from "@/components/site/footer";
import { Header } from "@/components/site/header";
import { GithubIcon, XIcon } from "@/components/site/brand-icons";

export const metadata: Metadata = {
  title: "About ChowBot",
  description:
    "What ChowBot is, how it signs you in and keeps your Chowdeck session safe, the tools it gives your AI assistant, and who built it.",
};

const TOOLS = [
  {
    title: "Restaurants and menus",
    card: "bg-deck-lilac",
    tools: [
      "search_restaurants",
      "browse_restaurants",
      "get_restaurant_menu",
      "get_menu_item",
    ],
  },
  {
    title: "Carts",
    card: "bg-cream",
    tools: [
      "list_carts",
      "get_cart",
      "add_to_cart",
      "duplicate_cart_pack",
      "remove_cart_pack",
      "clear_cart",
      "get_cart_notes",
      "set_cart_notes",
      "set_cart_bags",
    ],
  },
  {
    title: "Addresses",
    card: "bg-deck-sky",
    tools: [
      "list_addresses",
      "set_active_address",
      "search_address_places",
      "add_address",
    ],
  },
  {
    title: "Checkout and payment",
    card: "bg-mint",
    tools: [
      "get_checkout_quote",
      "list_promo_codes",
      "list_beneficiaries",
      "place_order",
      "start_payment",
    ],
  },
  {
    title: "Orders and delivery",
    card: "bg-deck-pink",
    tools: [
      "list_orders",
      "get_order",
      "track_order",
      "get_order_timeline",
      "get_delivery_pin",
      "update_order_delivery_note",
      "rate_order",
    ],
  },
  {
    title: "Sign-in (local use)",
    card: "bg-peach",
    tools: ["request_login_otp", "verify_login_otp"],
  },
];

const STACK = [
  "TypeScript",
  "Bun",
  "Model Context Protocol SDK",
  "Express",
  "PostgreSQL and Drizzle",
  "React and TanStack Router",
  "Next.js",
  "Tailwind CSS",
  "shadcn/ui",
];

const SAFETY = [
  {
    mark: <Burst className="size-6 text-tangerine" />,
    title: "You sign in on ChowBot's page",
    body: "When you connect, your assistant opens ChowBot's own sign-in page. You enter your Chowdeck number and the code Chowdeck texts you there, never in the chat.",
  },
  {
    mark: <HalfCircle className="h-4 w-8 text-kiwi" />,
    title: "Standard OAuth, with PKCE",
    body: "Assistants register and sign in with OAuth's code flow and PKCE, the same way they connect to other remote MCP servers. They get a ChowBot token, not your Chowdeck one.",
  },
  {
    mark: <Sparkle className="size-6 text-lavender" />,
    title: "Your Chowdeck session is encrypted",
    body: "Your Chowdeck session is stored in PostgreSQL encrypted with AES-256-GCM, and it only ever leaves the server to talk to Chowdeck on your behalf.",
  },
  {
    mark: <Burst className="size-6 text-deck-sky" />,
    title: "Nothing is ordered without you",
    body: "Orders are placed only when you ask, after you've seen Chowdeck's quote, and payment happens on Chowdeck's own payment link.",
  },
];

export default function AboutPage() {
  return (
    <>
      <Header />
      <main id="main">
        <section
          aria-labelledby="about-title"
          className="relative overflow-hidden bg-hero pt-36 pb-28 lg:pt-44 lg:pb-36"
        >
          <Cloud className="absolute top-8 -left-16 w-56 sm:w-72" />
          <Cloud className="absolute top-24 -right-20 hidden w-64 sm:block lg:right-[6%]" />
          <div className="relative mx-auto max-w-4xl px-4 text-center sm:px-6">
            <h1
              id="about-title"
              className="display text-[3.25rem] text-black sm:text-7xl lg:text-[6rem]"
            >
              About ChowBot
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-ink/80 sm:text-xl">
              ChowBot is an open-source MCP server that lets AI assistants use
              your Chowdeck account. Ask for food in a chat, and your assistant
              can search, fill your cart, check out, pay and track the rider for
              you.
            </p>
          </div>
          <CloudEdge className="absolute inset-x-0 bottom-0" />
        </section>

        <section
          aria-labelledby="what"
          className="px-4 py-20 sm:px-6 lg:px-10 lg:py-28"
        >
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-2 lg:gap-16">
            <h2
              id="what"
              className="display text-[2.75rem] text-black sm:text-6xl"
            >
              What it is
            </h2>
            <div className="space-y-5 text-lg text-ink/85">
              <p>
                MCP (the Model Context Protocol) is how AI assistants plug into
                other services. ChowBot speaks it on one side and
                Chowdeck&apos;s API on the other, so any assistant that supports
                remote MCP connectors, like Claude or ChatGPT, can order from
                Chowdeck for you.
              </p>
              <p>
                It works with your real Chowdeck account. Your carts, saved
                addresses, promo codes, wallet and past orders are all there,
                and every price, fee and discount comes straight from Chowdeck.
              </p>
              <p>
                ChowBot is an independent project. It isn&apos;t affiliated with
                Chowdeck; orders, payments and deliveries are Chowdeck&apos;s,
                under its own terms.
              </p>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="safety"
          className="px-4 pb-20 sm:px-6 lg:px-10 lg:pb-28"
        >
          <div className="mx-auto max-w-7xl overflow-hidden rounded-2xl border-4 border-black">
            <div
              aria-hidden
              className="scallop-band h-5.5 border-b-4 border-black"
            />
            <div className="p-7 sm:p-10 lg:p-14">
              <h2
                id="safety"
                className="display text-[2.75rem] text-black sm:text-6xl"
              >
                How your account stays safe
              </h2>
              <ul className="mt-10 grid gap-x-12 gap-y-10 sm:grid-cols-2">
                {SAFETY.map((point) => (
                  <li key={point.title}>
                    <div className="flex h-6 items-center">{point.mark}</div>
                    <h3 className="mt-4 text-xl font-bold tracking-tight text-black">
                      {point.title}
                    </h3>
                    <p className="mt-2 text-ink/80">{point.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="tools"
          className="px-4 pb-20 sm:px-6 lg:px-10 lg:pb-28"
        >
          <div className="mx-auto max-w-7xl">
            <h2
              id="tools"
              className="display text-[2.75rem] text-black sm:text-6xl"
            >
              31 tools for your assistant
            </h2>
            <p className="mt-5 max-w-2xl text-lg text-ink/80">
              These are what your assistant can call. You never type them; you
              just ask, and the assistant picks the right ones.
            </p>
            <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {TOOLS.map((group) => (
                <li
                  key={group.title}
                  className={`rounded-2xl border-4 border-black p-6 sm:p-7 ${group.card}`}
                >
                  <h3 className="text-2xl font-bold tracking-tight text-black">
                    {group.title}
                  </h3>
                  <ul className="mt-5 flex flex-wrap gap-2">
                    {group.tools.map((tool) => (
                      <li
                        key={tool}
                        className="rounded-lg border-2 border-black bg-white/80 px-2.5 py-1 font-mono text-[0.8125rem] text-ink"
                      >
                        {tool}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm text-ink/65">
              The two sign-in tools are only for running ChowBot locally over
              stdio. The hosted server signs you in on its own page instead.
            </p>
          </div>
        </section>

        <section
          aria-labelledby="stack"
          className="bg-chow-green px-4 py-20 sm:px-6 lg:px-10 lg:py-28"
        >
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-2 lg:gap-16">
            <div>
              <h2
                id="stack"
                className="display text-[2.75rem] text-white sm:text-6xl"
              >
                Open source
              </h2>
              <p className="mt-5 max-w-lg text-lg text-white/85">
                The MCP server, the sign-in pages and this website all live in
                one repository. Read the code, run it yourself, or open an issue
                if something&apos;s off.
              </p>
              <a
                href={LINKS.github}
                target="_blank"
                rel="noreferrer"
                className="mt-8 inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3 font-semibold text-chow-green transition-colors hover:bg-hero"
              >
                <GithubIcon className="size-5" />
                Adedoyin-Emmanuel/chowbot
                <ArrowRight className="size-4" aria-hidden />
              </a>
            </div>
            <div>
              <h3 className="label-caps text-sm text-white/60">Built with</h3>
              <ul className="mt-5 flex flex-wrap gap-3">
                {STACK.map((item) => (
                  <li
                    key={item}
                    className="rounded-lg border border-white/15 bg-white/10 px-5 py-2.5 font-semibold text-white"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="maker"
          className="px-4 py-20 sm:px-6 lg:px-10 lg:py-28"
        >
          <div className="mx-auto flex max-w-7xl flex-col gap-8 rounded-2xl border-4 border-black bg-sun p-8 sm:p-12 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2
                id="maker"
                className="display text-[2.75rem] text-black sm:text-6xl"
              >
                Made by Adedoyin Emmanuel
              </h2>
              <p className="mt-4 max-w-xl text-lg text-black/80">
                Questions, ideas or a bug to report? Find me on X, or see what
                else I&apos;m building.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <a
                href={LINKS.author.site}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center rounded-lg bg-black px-6 py-3 font-semibold text-white transition-colors hover:bg-chow-green"
              >
                adedoyin.dev
              </a>
              <a
                href={LINKS.author.x}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3 font-semibold text-black transition-colors hover:bg-hero"
              >
                <XIcon className="size-4" />
                @Emmysoft_Tm
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
