"use client";

import Image from "next/image";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";

import logo from "@/public/chowbot-logo.svg";
import { LINKS } from "@/lib/site";
import { cn } from "@/lib/utils";

import { GithubIcon } from "./brand-icons";

const NAV = [
  { href: "/#features", label: "What it can do" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#faq", label: "FAQ" },
  { href: "/about", label: "About" },
];

/*
 * Chowdeck's header: separate floating pills over the page, not a bar. A
 * green logo pill on the left, the links in one white pill in the middle,
 * the action on the right. On phones, round buttons and a dropdown menu.
 */
export function Header() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) =>
      event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-4 pt-4 sm:px-6 lg:px-10 lg:pt-6">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
        <Link
          href="/"
          aria-label="ChowBot home"
          className="flex h-12 items-center gap-2 rounded-full bg-chow-green px-1.5 text-base font-semibold text-white sm:pr-6 sm:pl-2"
        >
          <Image
            src={logo}
            alt=""
            width={36}
            height={36}
            className="size-9"
            priority
          />
          <span className="hidden sm:inline">ChowBot</span>
        </Link>

        <nav
          aria-label="Main"
          className="hidden rounded-full bg-white p-1 ring-1 ring-ink/5 lg:block"
        >
          <ul className="flex">
            {NAV.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="block rounded-full px-5 py-3 text-base font-semibold xl:px-6 text-ink transition-colors hover:text-cucumber"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-2">
          <a
            href="/#connect"
            className="flex h-12 items-center rounded-full bg-white px-6 text-base font-semibold text-chow-green ring-1 ring-ink/5 transition-colors hover:text-cucumber"
          >
            Connect
          </a>
          <a
            href={LINKS.github}
            target="_blank"
            rel="noreferrer"
            aria-label="ChowBot on GitHub"
            className="grid size-12 place-items-center rounded-full bg-white text-ink ring-1 ring-ink/5 transition-colors hover:text-cucumber"
          >
            <GithubIcon className="size-5" />
          </a>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="grid size-12 place-items-center rounded-full bg-chow-green text-white lg:hidden"
          >
            {open ? (
              <X className="size-5" aria-hidden />
            ) : (
              <Menu className="size-5" aria-hidden />
            )}
          </button>
        </div>
      </div>

      <nav
        id="mobile-menu"
        aria-label="Main"
        className={cn(
          "mx-auto mt-2 max-w-7xl overflow-hidden rounded-2xl bg-white ring-1 ring-ink/5 lg:hidden",
          open ? "block" : "hidden",
        )}
      >
        <ul className="p-2">
          {NAV.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                onClick={() => setOpen(false)}
                className="block rounded-xl px-4 py-3.5 text-lg font-semibold text-ink hover:bg-hero"
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
