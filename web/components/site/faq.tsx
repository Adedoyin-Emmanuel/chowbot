"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import { Burst } from "./shapes";

const FAQS: { question: string; answer: React.ReactNode }[] = [
  {
    question: "What is ChowBot?",
    answer:
      "ChowBot is a connector (an MCP server) that lets AI assistants like Claude, Grok, ChatGPT, Gemini, and others use your Chowdeck account. Once it's connected, you can search for food, fill your cart, check out, pay and track your order just by chatting.",
  },
  {
    question: "Is ChowBot made by Chowdeck?",
    answer:
      "No. ChowBot is an independent project and isn't affiliated with, endorsed by or sponsored by Chowdeck. It signs in to your own Chowdeck account and places orders there, so your orders, payments and deliveries are still Chowdeck's.",
  },
  {
    question: "Which assistants does it work with?",
    answer:
      "Any AI assistant that supports remote MCP connectors, such as Claude, Grok, Gemini and ChatGPT. Add the connector URL in your assistant's connector settings and sign in once. In Claude, a connector added on the web or desktop also works in the iPhone and Android apps.",
  },
  {
    question: "Can it order food without me knowing?",
    answer:
      "No. ChowBot only places an order when you ask for it, after you've seen the total from Chowdeck's quote. It checks the total again right before sending, and sends nothing if it has changed. It never chooses a tip or rates a restaurant for you.",
  },
  {
    question: "How do I pay?",
    answer:
      "However you pay on Chowdeck: card, bank transfer, USSD, OPay, Pocket or Zap through Chowdeck's payment link, your Chowdeck wallet balance, or a pay-for-me link you can send to someone else. Prices, fees and discounts all come from Chowdeck.",
  },
  {
    question: "What if I change my mind?",
    answer:
      "Until you pay, nothing is charged. Ask to change the items, notes, address or payment method and ChowBot updates the cart and places the order again. A paid order is final, the same as on Chowdeck, so contact Chowdeck if something goes wrong with one.",
  },
  {
    question: "Can I send food to someone else?",
    answer:
      "Yes. Send an order as a gift to someone saved on your Chowdeck account, or to someone new with their name, number and a message. ChowBot can save new recipients for next time if you want.",
  },
  {
    question: "Where does it work?",
    answer:
      "Wherever Chowdeck delivers. ChowBot searches around the delivery address you choose, so you see the same restaurants, shops and pharmacies you'd see in the app.",
  },
  {
    question: "What does ChowBot keep about me?",
    answer:
      "Your Chowdeck session, kept on ChowBot's server so it can act for you when you ask. It is never handed to the assistant. ChowBot doesn't ask for or see your card details. What you type in the chat is handled by your assistant under its own privacy terms.",
  },
  {
    question: "How do I disconnect it?",
    answer:
      "Open your assistant's connector settings (in Claude: Settings, then Connectors) and disconnect or remove ChowBot. You can add it back any time.",
  },
];

export function Faq() {
  const [active, setActive] = useState(0);
  const current = FAQS[active]!;

  return (
    <section
      aria-labelledby="faq"
      className="bg-[linear-gradient(to_bottom,#fff_0,#fff_45%,#000_45%)] px-4 pt-10 pb-16 sm:px-6 lg:px-10 lg:pb-24"
    >
      <div className="mx-auto grid max-w-7xl gap-10 rounded-2xl border-4 border-black bg-white p-6 sm:p-9 lg:grid-cols-2 lg:gap-10">
        <div>
          <h2
            id="faq"
            className="display text-5xl text-chow-green sm:text-[4rem]"
          >
            FAQs.
          </h2>
          <ul className="mt-8 space-y-4">
            {FAQS.map((faq, index) => {
              const open = index === active;
              return (
                <li key={faq.question}>
                  <button
                    type="button"
                    onClick={() => setActive(index)}
                    aria-expanded={open}
                    aria-controls={`faq-answer-${index} faq-answer`}
                    className={cn(
                      "flex w-full items-center justify-between gap-4 rounded-lg border border-faq-line p-5 text-left text-base font-bold transition-colors",
                      open
                        ? "bg-black text-white"
                        : "bg-chow-green/2 text-chow-green hover:bg-chow-green/5",
                    )}
                  >
                    {faq.question}
                    {open && <Burst className="size-6 shrink-0 text-sun" />}
                  </button>
                  {open && (
                    <p
                      id={`faq-answer-${index}`}
                      className="px-1 pt-4 pb-2 text-lg text-ink lg:hidden"
                    >
                      {faq.answer}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="hidden lg:block">
          <p aria-hidden className="display text-[4rem] text-chow-green">
            Ans.
          </p>
          <div
            id="faq-answer"
            aria-live="polite"
            className="sticky top-28 mt-8 rounded-2xl bg-sun p-10"
          >
            <Burst className="size-7 text-black" />
            <p className="mt-6 text-2xl text-black">{current.answer}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
