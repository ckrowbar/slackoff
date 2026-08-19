import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sizes = [16, 32, 48, 128] as const;
const expectedIcons = Object.fromEntries(sizes.map((size) => [String(size), `icons/sloth-${size}.png`]));

test("the extension package exposes every required sloth icon size", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
  ) as { icons?: unknown; action?: { default_icon?: unknown } };

  assert.deepEqual(manifest.icons, expectedIcons);
  assert.deepEqual(manifest.action?.default_icon, expectedIcons);

  for (const size of sizes) {
    const png = await readFile(new URL(`../extension/icons/sloth-${size}.png`, import.meta.url));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${size}px PNG signature`);
    assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR", `${size}px IHDR chunk`);
    assert.equal(png.readUInt32BE(16), size, `${size}px width`);
    assert.equal(png.readUInt32BE(20), size, `${size}px height`);
  }
});
