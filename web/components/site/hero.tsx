import { LINKS, MCP_SERVER_URL } from "@/lib/site";

import { CopyField } from "./copy-field";
import { GithubIcon } from "./brand-icons";
import { Cloud, CloudEdge } from "./shapes";
import { SkylineArt } from "./illustrations";

export function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="relative overflow-hidden bg-hero pt-32 sm:pt-36 lg:pt-44"
    >
      <Cloud className="absolute top-6 -left-16 w-56 sm:w-72 lg:top-10 lg:-left-10" />
      <Cloud className="absolute top-28 -right-20 hidden w-64 sm:block lg:top-16 lg:right-[8%]" />
      <Cloud className="absolute top-[38%] left-[2%] hidden w-40 xl:block" />
      <Cloud className="absolute top-[30%] right-[2%] hidden w-44 xl:block" />

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
            className="link-underline font-semibold text-chow-green"
          >
            Show me how
          </a>
        </p>
        <br />
        <br />
      </div>

      <SkylineArt className="relative mt-12 block h-64 w-full sm:h-80 lg:mt-14 lg:h-120" />

      <CloudEdge className="absolute inset-x-0 bottom-0 z-20" />
    </section>
  );
}
