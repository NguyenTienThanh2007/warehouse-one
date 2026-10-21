import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DomainEvent } from "@warehouse-one/contracts";
import type { LoggedCommand, SimulationConfig } from "@warehouse-one/simulation";
import { describe, expect, it } from "vitest";
import { checkReplay } from "./verify";

const dir = resolve(import.meta.dirname, "../../../data/fixtures/operations-demo");
const config = JSON.parse(readFileSync(`${dir}/config.json`, "utf8")) as SimulationConfig;
const lines = (f: string) =>
  readFileSync(`${dir}/${f}`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const commands = lines("commands.jsonl") as LoggedCommand[];
const events = lines("events.jsonl") as DomainEvent[];
const through = 6000;

describe("checkReplay", () => {
  it("accepts a faithful run", () => {
    const r = checkReplay(config, commands, events, through);
    expect(r).toMatchObject({ ok: true, storedEvents: events.length, mismatches: [] });
  });

  it("accepts a prefix that stops mid-run", () => {
    expect(checkReplay(config, commands, events.slice(0, 120), through).ok).toBe(true);
  });

  it("detects an altered payload", () => {
    const tampered = events.map((e) =>
      e.sequence === 40 ? { ...e, correlation_id: "forged" } : e,
    );
    const r = checkReplay(config, commands, tampered as DomainEvent[], through);
    expect(r.ok).toBe(false);
    expect(r.mismatches[0]).toEqual({ sequence: 40, reason: "differs from the replay" });
  });

  it("detects a command log that does not produce the stored events", () => {
    // Without the outbound order (ops-0004), its picks, loads and truck never happen.
    const withoutOrder = commands.filter((c) => c.command.command_id !== "ops-0004");
    const r = checkReplay(config, withoutOrder, events, through);
    expect(r.ok).toBe(false);
  });

  it("detects events lost before the last stored tick", () => {
    const withHole = [...events.slice(0, 10), ...events.slice(10)].filter((e) => e.sequence !== 11);
    expect(checkReplay(config, commands, withHole, through).ok).toBe(false);
  });
});
