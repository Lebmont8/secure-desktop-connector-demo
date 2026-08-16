import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const outputDir = path.join(projectDir, "dist");
const tsconfig = path.join(projectDir, "tsconfig.json");

await fs.mkdir(outputDir, { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(projectDir, "src/main.ts")],
    outfile: path.join(outputDir, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    tsconfig,
    sourcemap: false,
    legalComments: "none",
  }),
  build({
    entryPoints: [path.join(projectDir, "src/preload.ts")],
    outfile: path.join(outputDir, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    tsconfig,
    sourcemap: false,
    legalComments: "none",
  }),
  build({
    entryPoints: [path.join(projectDir, "src/renderer.ts")],
    outfile: path.join(outputDir, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome142",
    tsconfig,
    sourcemap: false,
    legalComments: "none",
  }),
  build({
    entryPoints: [path.join(projectDir, "src/demo-server.ts")],
    outfile: path.join(outputDir, "demo-server.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    tsconfig,
    sourcemap: false,
    legalComments: "none",
  }),
]);
