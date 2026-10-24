import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";

import { SITE } from "@/lib/site";

import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
});

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000";

const ogImageAlt =
  "ChowBot: you don chow? Just ask. Someone asks to order their usual from Item 7 and ChowBot replies with their chicken and beef shawarma and a link to pay 11,090 naira with OPay.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: SITE.title,
  description: SITE.description,
  applicationName: SITE.name,
  keywords: [
    "ChowBot",
    "Chowdeck",
    "Claude",
    "ChatGPT",
    "MCP",
    "food delivery",
    "Lagos",
    "Nigeria",
    "AI assistant",
  ],
  openGraph: {
    type: "website",
    siteName: SITE.name,
    title: SITE.title,
    description: SITE.description,
    locale: "en_NG",
    images: [
      {
        url: "/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: ogImageAlt,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE.title,
    description: SITE.description,
    images: [{ url: "/opengraph-image.png", alt: ogImageAlt }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0c513f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-ink focus:px-5 focus:py-3 focus:text-white"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
