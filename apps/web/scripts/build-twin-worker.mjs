/**
 * Bundle the twin evaluation worker (Phase 6.1, DEC-042) into public/workers/twin-evaluation.js.
 * Turbopack (Next 16.3) does not bundle `new Worker(new URL(...))` targets (it copies the source
 * file as an asset), so the worker is built here, before `next dev` and `next build`, as one
 * self-contained ES module: the engine, the twin and the protocol, nothing else.
 */
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "public/workers/twin-evaluation.js");
mkdirSync(dirname(outfile), { recursive: true });
const started = performance.now();
await build({
  entryPoints: [resolve(root, "src/lib/twin/evaluation.worker.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});
const kb = (statSync(outfile).size / 1024).toFixed(0);
console.log(
  `- Twin worker: public/workers/twin-evaluation.js (${kb} KiB, ${Math.round(performance.now() - started)} ms)`,
);
