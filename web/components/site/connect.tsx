import {
  Plug,
  KeyRound,
  Settings,
  MessageCircle,
  type LucideIcon,
} from "lucide-react";


import { Dot } from "./shapes";
import { CopyField } from "./copy-field";
import { MCP_SERVER_URL } from "@/lib/site";

const STEPS: { icon: LucideIcon; text: React.ReactNode }[] = [
  {
    icon: Settings,
    text: (
      <>
        Open your assistant&apos;s connector settings. In Claude, that&apos;s{" "}
        <strong>Settings</strong>, then <strong>Connectors</strong>.
      </>
    ),
  },
  {
    icon: Plug,
    text: (
      <>
        Choose <strong>Add custom connector</strong>, name it{" "}
        <strong>ChowBot</strong> and paste the URL.
      </>
    ),
  },
  {
    icon: KeyRound,
    text: (
      <>
        Select <strong>Connect</strong> and sign in with your Chowdeck number
        and the code Chowdeck texts you.
      </>
    ),
  },
  {
    icon: MessageCircle,
    text: (
      <>
        Start a chat and ask for food. If your assistant doesn&apos;t use
        ChowBot, switch it on in the chat&apos;s tools menu.
      </>
    ),
  },
];

export function Connect() {
  return (
    <section
      aria-labelledby="connect"
      className="px-4 py-20 sm:px-6 lg:px-10 lg:py-28"
    >
      <div className="mx-auto max-w-7xl overflow-hidden rounded-2xl border-4 border-black">
        <div
          aria-hidden
          className="scallop-band h-5.5 border-b-4 border-black"
        />
        <div className="grid lg:grid-cols-[1.15fr_1fr]">
          <div className="bg-hero p-7 sm:p-10 lg:p-14">
            <h2
              id="connect"
              className="display text-[2.75rem] text-black sm:text-6xl"
            >
              Connect ChowBot to your assistant
            </h2>
            <p className="mt-5 max-w-md text-lg text-ink/85">
              ChowBot works with any AI assistant that supports remote MCP
              connectors, like Claude and ChatGPT. Add it once and it&apos;s
              there in every chat, on the web, desktop and phone apps.
            </p>
            <CopyField
              id="connect-mcp-url"
              value={MCP_SERVER_URL}
              label="ChowBot connector URL"
              className="mt-8 max-w-xl"
            />
            <p className="mt-4 max-w-md text-sm text-ink/65">
              The same URL works in every assistant. Your assistant opens
              ChowBot&apos;s sign-in page the first time you connect.
            </p>
          </div>

          <div className="border-t-4 border-black bg-white lg:border-t-0 lg:border-l-4">
            <p className="flex items-center gap-3 border-b-4 border-black bg-deck-sky px-6 py-5 text-2xl font-bold text-black sm:text-3xl">
              <Dot className="border-tangerine" />
              Four steps
            </p>
            <ol className="space-y-3 p-4 sm:p-5">
              {STEPS.map((step, index) => (
                <li
                  key={index}
                  className="flex items-center gap-4 rounded-lg border border-faq-line px-5 py-4"
                >
                  <p className="flex-1 text-ink">
                    <span className="sr-only">Step {index + 1}: </span>
                    {step.text}
                  </p>
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-mint text-kiwi">
                    <step.icon className="size-5" aria-hidden />
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
