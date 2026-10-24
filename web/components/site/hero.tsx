import cart from "@/public/screenshots/cart.png";
import payment from "@/public/screenshots/order-payment.png";
import tracking from "@/public/screenshots/order-tracking.png";

import { MCP_SERVER_URL } from "@/lib/site";

import { CopyField } from "./copy-field";
import { Phone } from "./phone";
import { RiderArt, SkylineArt } from "./illustrations";
import { Cloud, CloudEdge } from "./shapes";

/*
 * Laid out like chowdeck.com's hero: cream sky with clouds, one huge
 * centred line, and a single white pill to act on (their address bar, our
 * connector URL), and a flat city skyline behind the real screenshots.
 */
export function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="relative overflow-hidden bg-hero pt-32 sm:pt-36 lg:pt-44"
    >
      <Cloud className="absolute top-6 -left-16 w-56 sm:w-72 lg:top-10 lg:-left-10" />
      <Cloud className="absolute top-28 -right-20 hidden w-64 sm:block lg:top-16 lg:right-[8%]" />
      <Cloud className="absolute top-[46%] left-[6%] hidden w-44 lg:block" />
      <Cloud className="absolute top-[40%] right-[3%] hidden w-52 lg:block" />

      <div className="relative mx-auto max-w-5xl px-4 text-center sm:px-6">
        <h1
          id="hero-title"
          className="display text-[3.25rem] text-black sm:text-7xl lg:text-[7rem]"
        >
          You don chow?
          <br />
          Just ask.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-ink/80 sm:text-xl">
          ChowBot connects your Chowdeck account to Claude, ChatGPT or any AI
          assistant that supports MCP. Order, pay and track your food in plain
          conversation.
        </p>

        <CopyField
          id="hero-mcp-url"
          variant="bar"
          value={MCP_SERVER_URL}
          label="ChowBot MCP connector URL"
          className="mx-auto mt-9 max-w-2xl"
        />
        <p className="mt-4 text-sm text-ink/60">
          Paste it into your assistant&apos;s connector settings.{" "}
          <a
            href="#connect"
            className="font-semibold text-chow-green underline underline-offset-4"
          >
            Show me how
          </a>
        </p>
      </div>

      <SkylineArt className="absolute inset-x-0 bottom-0 h-56 w-full sm:h-72 lg:h-[26rem]" />
      <RiderArt className="absolute bottom-6 left-[3%] z-10 hidden w-44 sm:block lg:bottom-8 lg:left-[16%] lg:w-56" />

      <div className="relative z-10 mx-auto mt-14 h-[23rem] max-w-3xl sm:h-[30rem] lg:mt-16 lg:h-[34rem]">
        <Phone
          src={cart}
          alt="Claude listing the items in a Chowdeck cart: chicken shawarma and beef shawarma from Item 7, total 8,600 naira."
          className="absolute top-14 left-[4%] w-[34%] -rotate-6 sm:left-[8%] sm:w-[30%]"
          sizes="(min-width: 1024px) 230px, 34vw"
        />
        <Phone
          src={tracking}
          alt="Claude showing an order on its way, with the rider's timeline and the delivery PIN 5051."
          className="absolute top-14 right-[4%] w-[34%] rotate-6 sm:right-[8%] sm:w-[30%]"
          sizes="(min-width: 1024px) 230px, 34vw"
        />
        <Phone
          src={payment}
          alt="Claude confirming an order from Item 7 with a link to pay 10,090 naira with OPay, then confirming the payment went through."
          priority
          className="absolute top-0 left-1/2 w-[40%] -translate-x-1/2 sm:w-[34%]"
          sizes="(min-width: 1024px) 260px, 40vw"
        />
      </div>

      <CloudEdge className="absolute inset-x-0 bottom-0 z-20" />
    </section>
  );
}
