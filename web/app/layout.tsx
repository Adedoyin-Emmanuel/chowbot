import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import { SITE } from "@/lib/site";

import "./globals.css";

// Plus Jakarta Sans, the typeface chowdeck.com uses. Variable font (OFL, see
// app/fonts/OFL.txt), self-hosted so the site loads nothing from third parties.
const jakarta = localFont({
  src: "./fonts/plus-jakarta-sans-latin.woff2",
  variable: "--font-jakarta",
  weight: "200 800",
  display: "swap",
});

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000";

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
  },
  twitter: {
    card: "summary_large_image",
    title: SITE.title,
    description: SITE.description,
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
