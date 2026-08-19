/**
 * The content script inlines the stylesheet and icon into its shadow-root bundle. The build script
 * resolves these virtual specifiers to their source assets and loads both as text.
 */
declare module "slackoff:styles" {
  const css: string;
  export default css;
}

declare module "slackoff:icon" {
  const svg: string;
  export default svg;
}
