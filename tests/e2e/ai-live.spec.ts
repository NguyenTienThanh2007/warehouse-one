import { expect, test } from "@playwright/test";

/**
 * AI mode against the real API (data-platform CI job): the browser's optimiser output is
 * re-validated by the real server, approved with a real freshness check, applied through the live
 * runner and recorded in the real audit trail. Skipped unless TWIN_API_URL is set; the web build
 * must use the same NEXT_PUBLIC_API_URL.
 */
const API = process.env.TWIN_API_URL;

test.describe("AI mode against the real API", () => {
  test.skip(!API, "set TWIN_API_URL to run against a live API with migration 0004");
  test.describe.configure({ timeout: 240_000 });

  test("a proposal is validated by the server, approved, applied once and audited", async ({
    page,
    request,
  }) => {
    await page.goto("/?mode=ai");
    await expect(page.getByTestId("twin-api-ready")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("twin-horizon").selectOption("9000");
    await page.getByTestId("twin-run").click();
    await expect(page.getByTestId("twin-result")).toBeVisible({ timeout: 120_000 });
    // The server's own checks, not the browser's verdict, decide the status.
    await expect(page.getByTestId("twin-status")).toHaveText("Awaiting review", {
      timeout: 20_000,
    });
    await expect(
      page.locator('[data-testid="twin-validation-check"][data-passed="false"]'),
    ).toHaveCount(0);

    await page.getByTestId("twin-operator").fill("CI operator");
    await page.getByTestId("twin-approve").click();
    await page.getByTestId("twin-confirm-yes").click();
    await expect(page.getByTestId("twin-status")).toHaveText("Approved");
    await page.getByTestId("twin-execute").click();
    await page.getByTestId("twin-confirm-yes").click();
    await expect(page.getByTestId("twin-status")).toHaveText("Applied", { timeout: 30_000 });

    const list = await (await request.get(`${API}/api/v1/twin/proposals?limit=1`)).json();
    const p = await (
      await request.get(`${API}/api/v1/twin/proposals/${list.items[0].proposal_id}`)
    ).json();
    expect(p.status).toBe("applied");
    expect(p.history.map((h: { action: string }) => h.action)).toEqual([
      "created",
      "validation",
      "approve",
      "execute",
      "applied",
    ]);
    expect(p.history[2].actor).toBe("CI operator");
    // Executing twice is refused by the server.
    const again = await request.post(`${API}/api/v1/twin/proposals/${p.proposal_id}/execution`, {
      data: {
        actor: "CI operator",
        context: {
          simulation_id: p.simulation_id,
          config_hash: p.evaluation.source.config_hash,
          tick: p.source_tick,
          fleet_fingerprint: p.evaluation.source.fleet_fingerprint,
        },
      },
    });
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe("ALREADY_EXECUTED");
  });
});
