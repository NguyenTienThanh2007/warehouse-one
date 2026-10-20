import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderJsonSchema, SCHEMA_FILES } from "../src/json-schema";

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/schemas");
mkdirSync(outDir, { recursive: true });
for (const name of Object.keys(SCHEMA_FILES) as (keyof typeof SCHEMA_FILES)[]) {
  writeFileSync(resolve(outDir, name), renderJsonSchema(name));
  console.log(`wrote data/schemas/${name}`);
}
