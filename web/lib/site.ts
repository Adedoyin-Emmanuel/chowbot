/*
 * The MCP endpoint people paste into their assistant's connector settings.
 * TODO: the production URL isn't decided yet. Set NEXT_PUBLIC_MCP_SERVER_URL
 * at build time and drop the placeholder once ChowBot has a real domain.
 */
export const MCP_SERVER_URL =
  process.env.NEXT_PUBLIC_MCP_SERVER_URL?.trim() ||
  "https://chowbot.example.com/mcp";

export const SITE = {
  name: "ChowBot",
  title: "ChowBot: order Chowdeck food by chatting with your AI assistant",
  description:
    "ChowBot connects your Chowdeck account to Claude, ChatGPT or any AI assistant that supports MCP. Find food, fill your cart, pay, track your rider and get your delivery PIN, just by asking.",
} as const;

export const LINKS = {
  github: "https://github.com/Adedoyin-Emmanuel/chowbot",
  author: { name: "Adedoyin Emmanuel", site: "https://adedoyin.dev", x: "https://x.com/Emmysoft_Tm" },
} as const;
