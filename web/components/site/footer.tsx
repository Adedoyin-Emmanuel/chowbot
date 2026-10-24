import Image from "next/image";
import type { ReactNode } from "react";

import { LINKS } from "@/lib/site";
import { HeartArt } from "./illustrations";
import logo from "@/public/chowbot-logo.svg";
import { Burst, HalfCircle, Sparkle } from "./shapes";

type FooterLink = { label: string; href?: string; external?: boolean };

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: "ChowBot",
    links: [
      { href: "/#features", label: "What it can do" },
      { href: "/#how-it-works", label: "How it works" },
      { href: "/#connect", label: "Connect" },
      { href: "/about", label: "About" },
    ],
  },
  {
    title: "Help",
    links: [
      { href: "/#faq", label: "FAQs" },
      {
        href: `${LINKS.github}/issues`,
        label: "Report an issue",
        external: true,
      },
      { href: LINKS.github, label: "Source code", external: true },
    ],
  },
  {
    title: "Works with",
    links: [
      { label: "Claude" },
      { label: "ChatGPT" },
      { label: "Any app that supports MCP" },
    ],
  },
];

// Each gets one of chowdeck.com's pastel marks, as on its social row.
const SOCIALS: { label: string; href: string; mark: ReactNode }[] = [
  {
    label: "GitHub",
    href: LINKS.github,
    mark: <Sparkle className="size-5 text-sky" />,
  },
  {
    label: "X",
    href: LINKS.author.x,
    mark: <Burst className="size-5 text-deck-pink" />,
  },
  {
    label: "adedoyin.dev",
    href: LINKS.author.site,
    mark: <HalfCircle className="h-2.5 w-5 rotate-180 text-lavender" />,
  },
];

export function Footer() {
  return (
    <footer className="bg-black text-white">
      <div aria-hidden className="scallop-band h-5.5" />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10">
        <div className="grid lg:grid-cols-[1fr_2.6fr]">
          <div className="order-last flex items-end py-10 lg:order-0 lg:row-span-2 lg:pr-10 lg:pb-9">
            <p className="flex items-center gap-3 text-4xl font-bold tracking-[-0.04em] sm:text-5xl">
              <Image
                src={logo}
                alt=""
                width={56}
                height={56}
                className="size-11 sm:size-13"
              />
              ChowBot
            </p>
          </div>

          <div className="grid border-white/15 sm:grid-cols-3 lg:border-l">
            {COLUMNS.map((column, index) => (
              <div
                key={column.title}
                className={`border-white/15 py-10 sm:px-6 lg:py-14 ${index > 0 ? "sm:border-l" : ""}`}
              >
                <h2 className="label-caps text-sm text-white/45">
                  {column.title}
                </h2>
                <ul className="mt-6 space-y-4">
                  {column.links.map((link) => (
                    <li key={link.label} className="text-white/90">
                      {link.href ? (
                        <a
                          href={link.href}
                          {...(link.external && {
                            target: "_blank",
                            rel: "noreferrer",
                          })}
                          className="link-underline transition-colors hover:text-kiwi"
                        >
                          {link.label}
                        </a>
                      ) : (
                        link.label
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <ul className="grid grid-cols-3 border-t border-white/15 lg:border-l">
            {SOCIALS.map((social, index) => (
              <li
                key={social.label}
                className={`border-white/15 ${index > 0 ? "border-l" : ""}`}
              >
                <a
                  href={social.href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-20 items-center justify-center gap-2 text-sm font-bold tracking-[-0.02em] transition-colors hover:bg-white/5 sm:h-24 sm:gap-2.5 sm:text-lg lg:text-xl"
                >
                  {social.mark}
                  <span className="link-underline">{social.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-1.5 border-t border-white/15 py-8 text-center text-sm text-white/50">
          <p>
            Made with <HeartArt className="inline size-4 -translate-y-px" />
            <span className="sr-only">love</span> by{" "}
            <a
              href={LINKS.author.site}
              target="_blank"
              rel="noreferrer"
              className="link-underline font-semibold text-white/80 hover:text-kiwi"
            >
              {LINKS.author.name}
            </a>
          </p>
          <p>
            © {new Date().getFullYear()} ChowBot. An independent project, not
            affiliated with Chowdeck.
          </p>
        </div>
      </div>
    </footer>
  );
}
