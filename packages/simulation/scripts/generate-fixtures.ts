import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderGoldenFiles, runGolden } from "../src/scenarios/golden";

const outDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../data/fixtures/foundation-demo",
);
mkdirSync(outDir, { recursive: true });
const run = runGolden();
for (const [name, content] of Object.entries(renderGoldenFiles(run))) {
  writeFileSync(resolve(outDir, name), content);
  console.log(`wrote data/fixtures/foundation-demo/${name}`);
}
console.log(`events=${run.summary.event_count} hash=${run.summary.final_state_hash}`);
