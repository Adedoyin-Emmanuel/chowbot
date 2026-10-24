import { watch } from "node:fs";
import tailwind from "bun-plugin-tailwind";
import { rename, rm } from "node:fs/promises";

/*
 * Builds the sign-in app into dist/: index.html at the root (the MCP server
 * fills in the sign-in state per request) and hashed files under assets/,
 * which the server serves at /authorize/assets/ with long-lived caching.
 *
 *   bun build.ts                     one production build
 *   bun build.ts --watch             rebuild on every change under src/
 *   bun build.ts --watch --preview   also serve the flow (see preview.ts)
 */
const OUTDIR = `${import.meta.dir}/dist`;
const ASSETS_DIR = `${OUTDIR}/assets`;
const SRC = `${import.meta.dir}/src`;

const build = async () => {
  await rm(OUTDIR, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [`${SRC}/index.html`],
    // Everything is emitted flat into assets/ because Bun only applies a
    // naming folder to files the HTML references, not to files imported
    // from code; index.html is moved up afterwards.
    outdir: ASSETS_DIR,
    target: "browser",
    minify: true,
    publicPath: "/authorize/assets/",
    naming: {
      entry: "[name].[ext]",
      chunk: "[name]-[hash].[ext]",
      asset: "[name]-[hash].[ext]",
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [tailwind],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return false;
  }
  await rename(`${ASSETS_DIR}/index.html`, `${OUTDIR}/index.html`);
  for (const output of result.outputs) {
    const path = output.path.endsWith("/index.html")
      ? "index.html"
      : output.path.slice(OUTDIR.length + 1);
    console.log(`  ${path}  ${(output.size / 1024).toFixed(1)} KB`);
  }
  return true;
};

if (process.argv.includes("--watch")) {
  await build();
  let timer: Timer | undefined;
  watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => void build().then(() => console.log("rebuilt")),
      100,
    );
  });
  console.log("Watching src/ for changes…");
  if (process.argv.includes("--preview")) await import("./preview.ts");
} else if (!(await build())) {
  process.exit(1);
}
