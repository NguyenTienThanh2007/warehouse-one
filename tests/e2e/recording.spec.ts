import { expect, test } from "@playwright/test";
import type { DomainEvent } from "@warehouse-one/contracts";
import type { LoggedCommand, SimulationConfig } from "@warehouse-one/simulation";
import { checkReplay } from "../../packages/recorder/src/verify";
import { openWorld, pause } from "./helpers";

/**
 * Recording a browser run to the API (DEC-024), end to end: the web app registers a fresh run,
 * streams its command log and events, and the stored run replays to exactly the same events in the
 * TypeScript engine. Needs a running API and a web build whose NEXT_PUBLIC_API_URL points at it:
 *
 *   RECORDING_API_URL=http://localhost:8010 pnpm test:e2e recording
 *
 * Skipped otherwise (the default CI browser job runs without an API).
 */
const API = process.env.RECORDING_API_URL;

test.describe("recording a run to the API", () => {
  test.skip(!API, "RECORDING_API_URL is not set");

  test("the browser run is stored completely and replays to identical events", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await openWorld(page, "?scenario=showcase");
    await expect(page.getByTestId("api-status")).toHaveAttribute("data-status", "online", {
      timeout: 20_000,
    });
    const before = await page.evaluate(
      () =>
        (
          window as unknown as { __WAREHOUSE_ONE_SIM__: { config(): { simulation_id: string } } }
        ).__WAREHOUSE_ONE_SIM__.config().simulation_id,
    );
    await page.getByTestId("recording-toggle").click();
    const config = await page.evaluate(() =>
      (
        window as unknown as { __WAREHOUSE_ONE_SIM__: { config(): SimulationConfig } }
      ).__WAREHOUSE_ONE_SIM__.config(),
    );
    // A recorded session is a new run with its own identity.
    expect(config.simulation_id).not.toBe(before);
    await page.locator("body").press("5"); // 8×
    // Let the run produce work, including an operator command, then stop the clock.
    await expect
      .poll(
        async () =>
          Number(
            await page
              .getByTestId("sim-tick")
              .textContent()
              .then((t) => t?.replace(/,/g, "")),
          ),
        {
          timeout: 60_000,
        },
      )
      .toBeGreaterThan(400);
    await page.getByTestId("ops-tab-new").click();
    await page.getByTestId("inbound-submit").click();
    await expect(page.getByTestId("command-row").first()).toHaveAttribute(
      "data-status",
      "accepted",
      {
        timeout: 20_000,
      },
    );
    await pause(page);
    // Everything observed is sent: no pending events, recorder idle.
    await expect(page.getByTestId("recording")).toHaveAttribute("data-state", "idle", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("recording-stored")).not.toContainText("pending");

    const base = `${API}/api/v1/simulations/${config.simulation_id}`;
    const run = await (await request.get(base)).json();
    const tick = await page.evaluate(
      () =>
        (
          window as unknown as { __WAREHOUSE_ONE_SIM__: { state(): { tick: number } } }
        ).__WAREHOUSE_ONE_SIM__.state().tick,
    );
    expect(run.through_tick).toBe(tick);
    expect(run.source).toBe("web");
    const { commands } = (await (await request.get(`${base}/commands`)).json()) as {
      commands: LoggedCommand[];
    };
    expect(commands.some((c) => c.command.type === "truck.schedule_inbound")).toBe(true);
    const events: DomainEvent[] = [];
    for (let after = 0; ;) {
      const page_ = await (
        await request.get(`${base}/events?after_sequence=${after}&limit=5000`)
      ).json();
      events.push(...page_.events);
      if (page_.next_after_sequence === null) break;
      after = page_.next_after_sequence;
    }
    expect(events.length).toBe(run.last_sequence);
    const check = checkReplay(run.config, commands, events, run.through_tick);
    expect(check.mismatches).toEqual([]);
    expect(check.ok).toBe(true);
  });
});
