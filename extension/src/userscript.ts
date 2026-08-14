import { ConsoleShell } from "./mount.js";
import { createUserscriptPlatform } from "./platform/userscript.js";

/**
 * Tampermonkey entry, for hosts that will not load an unpacked extension. There is no options page
 * in this mode, so the manager's menu is the whole settings surface.
 */

const platform = createUserscriptPlatform();
const shell = new ConsoleShell(platform);

platform.registerCommand("Toggle takeover", () => void shell.toggleTakeover());
platform.registerCommand("Re-detect Slackoff DM", () => void shell.redetect());
platform.registerCommand("Toggle notifications", () => void shell.toggleNotifications());

void shell.start();
window.addEventListener("pagehide", () => shell.stop());
