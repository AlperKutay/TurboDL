// Renders every icon the app and the extension need from two SVGs.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#7c3aed"/>
  </linearGradient></defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#g)"/>
  <path d="M256 104v212" stroke="#fff" stroke-width="56" stroke-linecap="round"/>
  <path d="M156 228l100 100 100-100" fill="none" stroke="#fff" stroke-width="56" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M140 404h232" stroke="#fff" stroke-width="48" stroke-linecap="round"/>
</svg>`;

// macOS menu bar "template" glyph: black on transparent, the OS recolours it.
const trayGlyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <path d="M256 72v236" stroke="#000" stroke-width="64" stroke-linecap="round"/>
  <path d="M140 204l116 116 116-116" fill="none" stroke="#000" stroke-width="64" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M112 432h288" stroke="#000" stroke-width="56" stroke-linecap="round"/>
</svg>`;

function render(svg, size, file) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  const out = path.join(root, file);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`${file} (${size}px)`);
}

render(appIcon, 1024, "apps/desktop/build/icon.png");
render(appIcon, 256, "apps/desktop/resources/icons/icon.png");
render(appIcon, 32, "apps/desktop/resources/icons/tray.png");
render(trayGlyph, 16, "apps/desktop/resources/icons/trayTemplate.png");
render(trayGlyph, 32, "apps/desktop/resources/icons/trayTemplate@2x.png");
for (const size of [16, 32, 48, 128]) render(appIcon, size, `apps/extension/icons/icon${size}.png`);
