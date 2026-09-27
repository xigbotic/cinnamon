// Embeds the Cinnamon icon into the packaged exe via rcedit. This is our bypass
// for electron-builder's built-in edit step, which is coupled to a signing
// toolkit that won't extract on Windows without elevation/Developer Mode.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rcedit } = require("rcedit");

const exe = resolve("release/win-unpacked/Cinnamon.exe");
const icon = resolve("build/icon.ico");

if (!existsSync(exe)) {
  console.error(`[set-icon] exe not found: ${exe}`);
  process.exit(1);
}
if (!existsSync(icon)) {
  console.error(`[set-icon] icon not found: ${icon}`);
  process.exit(1);
}

await rcedit(exe, {
  icon,
  "version-string": {
    ProductName: "Cinnamon",
    FileDescription: "Cinnamon",
    CompanyName: "Xignotic",
    LegalCopyright: "",
    OriginalFilename: "Cinnamon.exe",
  },
});

console.log("[set-icon] embedded icon into Cinnamon.exe");
