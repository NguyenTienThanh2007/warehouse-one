import { z } from "zod";
import { SimulationCommand } from "./commands";
import { DomainEvent } from "./events";

/**
 * Language-neutral JSON Schemas generated from the Zod contracts.
 * The generated files in `data/schemas/` are consumed by the Python API and data pipeline.
 * Zod refinements (e.g. "from != to") are not representable and are enforced only in TypeScript
 * and by the simulation's own validation.
 */
export const SCHEMA_FILES = {
  "domain-event.schema.json": DomainEvent,
  "simulation-command.schema.json": SimulationCommand,
} as const;

export function renderJsonSchema(name: keyof typeof SCHEMA_FILES): string {
  const schema = z.toJSONSchema(SCHEMA_FILES[name], {
    target: "draft-2020-12",
    unrepresentable: "any",
  });
  const withId = {
    $id: `https://github.com/NguyenTienThanh2007/warehouse-one/data/schemas/${name}`,
    ...schema,
  };
  return `${JSON.stringify(withId, null, 2)}\n`;
}
