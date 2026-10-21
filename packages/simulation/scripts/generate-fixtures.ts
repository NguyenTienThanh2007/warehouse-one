import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderGoldenFiles, runGolden } from "../src/scenarios/golden";
import { runNetworkDemo } from "../src/scenarios/network-demo";
import { runOperationsDemo } from "../src/scenarios/operations-demo";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/fixtures");

function write(name: string, files: Record<string, string>) {
  const outDir = resolve(fixtures, name);
  mkdirSync(outDir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(resolve(outDir, file), content);
    console.log(`wrote data/fixtures/${name}/${file}`);
  }
}

const run = runGolden();
write("foundation-demo", renderGoldenFiles(run));
console.log(
  `foundation-demo: events=${run.summary.event_count} hash=${run.summary.final_state_hash}`,
);

const ops = runOperationsDemo();
if (ops.invariantViolations.length) throw new Error(ops.invariantViolations.join("\n"));
write("operations-demo", renderGoldenFiles(ops));
console.log(
  `operations-demo: events=${ops.summary.event_count} hash=${ops.summary.final_state_hash}`,
);

const network = runNetworkDemo();
if (network.invariantViolations.length) throw new Error(network.invariantViolations.join("\n"));
write("network-demo", renderGoldenFiles(network));
console.log(
  `network-demo: events=${network.events.length} hash=${String(network.summary.final_state_hash)}`,
);
