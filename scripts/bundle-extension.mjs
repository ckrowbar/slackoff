#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

/**
 * Bundles the Slackoff Console extension into extension/dist.
 *
 * The stylesheet is handled twice on purpose. It is copied to dist/styles.css for the manifest's
 * content_scripts entry, and it is also pulled into the content bundle as text through the virtual
 * "slackoff:styles" specifier (see extension/src/styles.d.ts), because the console lives in a
 * shadow root and page-level CSS does not cross that boundary. The virtual specifier plus esbuild's
 * `text` loader was chosen over a relative "./ui/styles.css" import so that no declaration sidecar
 * has to sit next to the stylesheet, and over emitting a generated dist/styles.css.js module so
 * that nothing under src imports build output.
 */

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
const extensionDirectory = join(root, "extension");
const sourceDirectory = join(extensionDirectory, "src");
const outputDirectory = join(extensionDirectory, "dist");
const stylesheet = join(sourceDirectory, "ui", "styles.css");

const STYLES_SPECIFIER = "slackoff:styles";

const USERSCRIPT_OUT = "slackoff-console.user.js";

/** Tampermonkey reads this block from the head of the emitted file, so it must survive verbatim. */
const USERSCRIPT_BANNER = `// ==UserScript==
// @name         Slackoff Console
// @namespace    io.github.ckrowbar.slackoff
// @version      0.1.5
// @description  Coding-agent console for OMP sessions, rendered over your Slackoff DM
// @author       ckrowbar
// @match        https://app.slack.com/client/*
// @match        https://*.slack.com/client/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      slack.com
// @connect      *.slack.com
// @noframes
// ==/UserScript==`;

/** Each entry gets its own build because the output formats and post-processing differ. */
const targets = [
  { entry: join(sourceDirectory, "content.ts"), out: "content.js", format: "iife" },
  { entry: join(sourceDirectory, "background.ts"), out: "background.js", format: "esm" },
  { entry: join(sourceDirectory, "options.ts"), out: "options.js", format: "iife" },
  { entry: join(sourceDirectory, "standalone.ts"), out: "standalone.js", format: "iife" },
  {
    entry: join(sourceDirectory, "userscript.ts"),
    out: USERSCRIPT_OUT,
    format: "iife",
    // Always minified and never mapped: Tampermonkey shows the raw file to the user.
    overrides: { minify: true, sourcemap: false, banner: { js: USERSCRIPT_BANNER } },
  },
];

/**
 * The repo writes relative imports with a `.js` extension, as NodeNext requires. esbuild resolves
 * those literally, so map them back onto the TypeScript source when it exists. Also resolves the
 * virtual stylesheet specifier.
 */
const resolvePlugin = {
  name: "slackoff-resolve",
  setup(build) {
    build.onResolve({ filter: new RegExp(`^${STYLES_SPECIFIER}$`) }, () => ({ path: stylesheet }));

    build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
      if (!args.path.endsWith(".js")) return null;
      const candidate = resolve(args.resolveDir, `${args.path.slice(0, -3)}.ts`);
      return existsSync(candidate) ? { path: candidate } : null;
    });
  },
};

/**
 * Release builds are minified with sidecar source maps because the content bundle is parsed on
 * every Slack page load; watch builds stay unminified with inline maps for debuggability.
 */
function optionsFor(target, watchMode) {
  return {
    entryPoints: [target.entry],
    outfile: join(outputDirectory, target.out),
    bundle: true,
    format: target.format,
    platform: "browser",
    target: "chrome120",
    minify: !watchMode,
    sourcemap: watchMode ? "inline" : "linked",
    logLevel: "info",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "text" },
    plugins: [resolvePlugin],
    ...target.overrides,
  };
}

/** A userscript whose metadata block did not survive bundling installs as an inert plain script. */
function verifyUserscript() {
  const path = join(outputDirectory, USERSCRIPT_OUT);
  const emitted = readFileSync(path, "utf8");
  if (!emitted.startsWith(USERSCRIPT_BANNER)) {
    throw new Error(`${relative(root, path)} does not begin with the userscript metadata block`);
  }
  console.log(`  ${relative(root, path)} metadata block verified, ${emitted.length}b`);
}

function copyStylesheet() {
  copyFileSync(stylesheet, join(outputDirectory, "styles.css"));
}

function requireSources(selected) {
  const missing = [...selected.map((target) => target.entry), stylesheet].filter(
    (path) => !existsSync(path),
  );
  if (missing.length > 0) {
    const list = missing.map((path) => relative(root, path)).join(", ");
    throw new Error(`Cannot bundle the extension, these sources are missing: ${list}`);
  }
}

async function main() {
  const watchMode = process.argv.includes("--watch");
  const selected = process.argv.includes("--userscript")
    ? targets.filter((target) => target.out === USERSCRIPT_OUT)
    : targets;

  requireSources(selected);
  mkdirSync(outputDirectory, { recursive: true });
  copyStylesheet();

  if (!watchMode) {
    await Promise.all(selected.map((target) => esbuild.build(optionsFor(target, false))));
    if (selected.some((target) => target.out === USERSCRIPT_OUT)) verifyUserscript();
    return;
  }

  const contexts = await Promise.all(selected.map((target) => esbuild.context(optionsFor(target, true))));
  await Promise.all(contexts.map((context) => context.watch()));
  // esbuild rebuilds the inlined copy; the manifest's copy is plain file output.
  watch(stylesheet, () => copyStylesheet());
  console.log("watching extension sources");
}

await main();
