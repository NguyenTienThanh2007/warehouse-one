import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { standbyFixture } from "../src/fixture";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/fixtures/twin-standby");
mkdirSync(out, { recursive: true });
const f = await standbyFixture();
const files = {
  "snapshot.json": f.snapshot,
  "evaluation-recommended.json": f.recommended,
  "evaluation-unchanged.json": f.unchanged,
};
for (const [name, value] of Object.entries(files)) {
  writeFileSync(resolve(out, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote data/fixtures/twin-standby/${name}`);
}
console.log(`twin-standby: recommendation ${f.recommended.recommendation?.summary ?? "none"}`);
