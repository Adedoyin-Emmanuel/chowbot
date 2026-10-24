/*
 * Renders each share-card variant in og/ (illustrated, chat, creative) to a
 * PNG beside it with headless Chrome. Run from web/:
 *
 *   bun og/render.ts               render every variant into og/
 *   bun og/render.ts --use chat    also make it the site's OG and Twitter image
 *
 * Set CHROME to point at another Chromium build.
 */
import { $ } from "bun";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const chrome =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const variants = ["illustrated", "chat", "creative"];
const use = process.argv[process.argv.indexOf("--use") + 1];

if (process.argv.includes("--use") && !variants.includes(use!)) {
  throw new Error(`--use takes one of: ${variants.join(", ")}`);
}

for (const variant of variants) {
  const html = resolve(import.meta.dir, `${variant}.html`);
  const png = resolve(import.meta.dir, `${variant}.png`);
  await $`${chrome} --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=1 --window-size=1200,630 --virtual-time-budget=2000 --screenshot=${png} file://${html}`.quiet();
  console.log(`Wrote ${png}`);

  if (variant === use) {
    for (const name of ["opengraph-image.png", "twitter-image.png"]) {
      await copyFile(png, resolve(import.meta.dir, "../app", name));
    }
    console.log(`Using ${variant} as app/opengraph-image.png and app/twitter-image.png`);
  }
}
