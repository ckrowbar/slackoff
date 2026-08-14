import { createFixtureController } from "./dev/fixtures.js";
import { mountApp } from "./ui/app.js";

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

const teardown = mountApp(root, createFixtureController());
window.addEventListener("pagehide", teardown, { once: true });
