import Image from "next/image";

import logo from "@/public/chowbot-logo.svg";

const COLUMNS = [
  {
    title: "ChowBot",
    links: [
      { href: "#features", label: "What it can do" },
      { href: "#how-it-works", label: "How it works" },
      { href: "#safety", label: "Safety" },
      { href: "#connect", label: "Connect" },
      { href: "#faq", label: "FAQs" },
    ],
  },
  {
    title: "Try saying",
    links: [
      { label: "What's on my Chowdeck cart?" },
      { label: "Find jollof rice near me" },
      { label: "Where's my rider?" },
      { label: "What's my delivery PIN?" },
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

// Laid out like chowdeck.com's black footer: ruled columns and a big wordmark.
export function Footer() {
  return (
    <footer className="bg-black text-white">
      <div aria-hidden className="scallop-band h-[22px]" />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10">
        <div className="grid lg:grid-cols-[1fr_2.6fr]">
          <div className="flex items-end py-12 lg:pr-10">
            <p className="flex items-center gap-3 text-4xl font-bold tracking-[-0.04em] sm:text-5xl">
              <Image
                src={logo}
                alt=""
                width={56}
                height={56}
                className="size-12 sm:size-14"
              />
              ChowBot
            </p>
          </div>
          <div className="grid sm:grid-cols-3">
            {COLUMNS.map((column) => (
              <div
                key={column.title}
                className="border-white/15 py-10 sm:border-l sm:px-6 lg:py-14"
              >
                <h2 className="label-caps text-sm text-white/45">
                  {column.title}
                </h2>
                <ul className="mt-6 space-y-4">
                  {column.links.map((link) => (
                    <li key={link.label} className="text-white/90">
                      {"href" in link ? (
                        <a
                          href={link.href}
                          className="transition-colors hover:text-kiwi"
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
        </div>

        <div className="border-t border-white/15 py-8 text-center text-sm text-white/55">
          <p>
            ChowBot is an independent project. It is not affiliated with,
            endorsed by or sponsored by Chowdeck.
          </p>
          <p className="mt-1">
            Chowdeck is a trademark of its owner. Claude and ChatGPT are
            products of their owners. Orders, payments and deliveries are provided by Chowdeck
            under its own terms.
          </p>
          <p className="mt-4">© {new Date().getFullYear()} ChowBot</p>
        </div>
      </div>
    </footer>
  );
}
