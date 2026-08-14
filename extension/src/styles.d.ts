/**
 * The content script inlines the bundled stylesheet into its shadow root, so it needs the CSS as
 * text. scripts/bundle-extension.mjs resolves this virtual specifier to extension/src/ui/styles.css
 * and loads it with esbuild's `text` loader.
 *
 * The specifier is virtual rather than a relative "./ui/styles.css" because TypeScript resolves a
 * relative non-code import only through a sidecar declaration next to the asset, and the stylesheet
 * lives in a directory this module must not add files to.
 */
declare module "slackoff:styles" {
  const css: string;
  export default css;
}
