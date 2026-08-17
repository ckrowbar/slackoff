import { createFixtureController } from "./dev/fixtures.js";
import { mountApp } from "./ui/app.js";
import type { Theme } from "./types.js";

const host = document.querySelector<HTMLElement>("#slackoff-preview");
if (!host) throw new Error("Preview host not found.");

const shadow = host.attachShadow({ mode: "open" });
const styles = document.createElement("link");
styles.rel = "stylesheet";
styles.href = "./dist/styles.css";
const root = document.createElement("div");
root.style.width = "100%";
root.style.height = "100%";
shadow.append(styles, root);

let theme: Theme = "codex";
let sidebarWidth = 360;
let sidebarCollapsed = false;
const teardown = mountApp(root, createFixtureController(), {
  theme,
  async setTheme(nextTheme) {
    theme = nextTheme;
  },
  sidebarWidth,
  sidebarCollapsed,
  async setSidebar(nextWidth, nextCollapsed) {
    sidebarWidth = nextWidth;
    sidebarCollapsed = nextCollapsed;
  },
});
window.addEventListener("pagehide", teardown, { once: true });
