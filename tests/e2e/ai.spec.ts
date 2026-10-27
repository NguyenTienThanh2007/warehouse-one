import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * AI mode (Phase 6) in the browser. The optimiser and the simulation are real: evaluations run
 * the engine in the page on a frozen snapshot of the live run, and an approved proposal is applied
 * through the live runner. The twin API is a small stateful fake below (its real lifecycle is
 * tested against PostgreSQL in apps/api/tests/integration/test_twin.py), so failures can be
 * staged on purpose: unreachable API, stale proposal, conflicting decision, AI on or off.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Fake {
  proposals: Map<string, Json>;
  posts: string[];
  /** Answer every request with a refused connection while true. */
  offline: boolean;
  /** Fail the next N proposal creations with a refused connection. */
  failCreates: number;
  decision: "ok" | "stale" | "conflict";
  ai: boolean;
}

const OUR_HEALTH = { status: "ok", service: "warehouse-api", version: "0.1.0" };
/** What these tests read from the read-only simulation hook (see helpers.ts). */
interface TwinHook {
  state(): { network?: { vehicles: Record<string, { id: string; standby_site?: string }> } };
  commands(): { command_id: string; status: string }[];
}
type HookWindow = { __WAREHOUSE_ONE_SIM__: TwinHook };

function commandsFor(evaluation: Json): Json[] {
  const rec = evaluation.recommendation;
  if (!rec) return [];
  const chosen = evaluation.candidates.find((c: Json) => c.candidate_id === rec.candidate_id);
  const before = new Map(
    evaluation.baseline.plan.assignments.map((a: Json) => [a.vehicle_id, a.site_id]),
  );
  const changes = chosen.plan.assignments.filter(
    (a: Json) => (before.get(a.vehicle_id) ?? null) !== a.site_id,
  );
  const cmds: Json[] = [];
  const add = (vehicle: string, site: string | null) =>
    cmds.push({
      command_id: `twin-e2e-${cmds.length + 1}`,
      type: "linehaul.set_standby",
      payload: { vehicle_id: vehicle, site_id: site },
    });
  for (const c of changes) if (before.get(c.vehicle_id)) add(c.vehicle_id, null);
  for (const c of changes) if (c.site_id) add(c.vehicle_id, c.site_id);
  return cmds;
}

const DETAIL_ONLY = [
  "evaluation",
  "validation",
  "commands",
  "history",
  "explanations",
  "decision_note",
  "executed_tick",
  "max_age_ticks",
];

/** The list endpoint's summary: the detail without its detail-only fields. */
const summary = (p: Json): Json =>
  Object.fromEntries(Object.entries(p).filter(([k]) => !DETAIL_ONLY.includes(k)));

async function fakeTwin(page: Page, over: Partial<Fake> = {}): Promise<Fake> {
  const fake: Fake = {
    proposals: new Map(),
    posts: [],
    offline: false,
    failCreates: 0,
    decision: "ok",
    ai: false,
    ...over,
  };
  const now = () => new Date().toISOString();
  const event = (p: Json, action: string, to: string, actor: string, details: Json = {}) => {
    p.history.push({
      action,
      from_status: p.status === to ? null : p.status,
      to_status: to,
      actor,
      note: null,
      details,
      recorded_at: now(),
    });
    p.status = to;
    p.version += 1;
    p.updated_at = now();
  };
  await page.route("**/health", (route) => route.fulfill({ json: OUR_HEALTH }));
  await page.route("**/api/v1/twin/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace("/api/v1/twin", "");
    if (req.method() === "POST") fake.posts.push(path);
    if (fake.offline) return route.abort("connectionrefused");
    if (path === "/capabilities")
      return route.fulfill({
        json: {
          strategies: [
            {
              id: "fleet-standby",
              version: "1.0.0",
              objective: "pickup_wait_s",
              description: "fake",
              hard_constraints: [],
            },
          ],
          ai: fake.ai
            ? { provider: "anthropic", model: "claude-opus-5-5", configured: true, detail: "ok" }
            : {
                provider: "none",
                model: null,
                configured: false,
                detail: "No AI provider is configured (WAREHOUSE_AI_PROVIDER=none).",
              },
          execution: { supported: true },
          lifecycle: {},
          limits: {},
        },
      });
    if (path === "/proposals" && req.method() === "GET")
      return route.fulfill({
        json: { items: [...fake.proposals.values()].reverse().map(summary), next_cursor: null },
      });
    if (path === "/proposals" && req.method() === "POST") {
      if (fake.failCreates > 0) {
        fake.failCreates -= 1;
        return route.abort("connectionrefused");
      }
      const body = req.postDataJSON() as Json;
      const e = body.evaluation;
      const id = `00000000-0000-4000-8000-${String(fake.proposals.size + 1).padStart(12, "0")}`;
      const rec = e.recommendation;
      const chosen = rec && e.candidates.find((c: Json) => c.candidate_id === rec.candidate_id);
      const wait = chosen?.deltas.find((d: Json) => d.key === "pickup_wait_s");
      const p: Json = {
        proposal_id: id,
        evaluation_id: e.evaluation_id,
        kind: e.kind,
        status: "generated",
        version: 0,
        strategy: e.strategy,
        simulation_id: e.source.simulation_id,
        source_tick: e.source.tick,
        source_business_time: e.source.simulated_at,
        headline: rec?.summary ?? e.no_recommendation_reason,
        objective: {
          metric: "pickup_wait_s",
          baseline: e.baseline.metrics.pickup_wait_s,
          candidate: wait?.candidate ?? null,
          pct: wait?.pct ?? null,
        },
        recommended_candidate_id: rec?.candidate_id ?? null,
        created_by: body.created_by,
        created_at: now(),
        updated_at: now(),
        decided_by: null,
        decided_at: null,
        evaluation: e,
        validation: [
          {
            id: "plan_rules",
            label: "The plan meets the network's standby rules",
            passed: true,
            detail: "ok",
          },
        ],
        commands: commandsFor(e),
        history: [],
        explanations: [],
        decision_note: null,
        executed_tick: null,
        max_age_ticks: 18000,
      };
      event(p, "created", "generated", body.created_by);
      event(p, "validation", rec ? "validated" : "not_actionable", "system:twin");
      fake.proposals.set(id, p);
      return route.fulfill({ status: 201, json: p });
    }
    const m = path.match(/^\/proposals\/([^/]+)(\/.*)?$/);
    const p = m ? fake.proposals.get(m[1] as string) : undefined;
    if (!p)
      return route.fulfill({
        status: 404,
        json: { error: { code: "PROPOSAL_NOT_FOUND", message: "no such proposal", details: {} } },
      });
    const action = m?.[2] ?? "";
    const body = req.method() === "POST" ? (req.postDataJSON() as Json) : {};
    if (action === "") return route.fulfill({ json: p });
    if (action === "/decision") {
      if (body.decision === "approve" && fake.decision === "stale") {
        event(p, "expired", "expired", body.actor, { reason: "fleet_changed" });
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "STALE_PROPOSAL",
              message: "The fleet's standby settings changed after the evaluation.",
              details: { reason: "fleet_changed" },
            },
          },
        });
      }
      if (fake.decision === "conflict") {
        event(p, "reject", "rejected", "someone else");
        return route.fulfill({
          status: 409,
          json: { error: { code: "VERSION_CONFLICT", message: "changed", details: {} } },
        });
      }
      event(p, body.decision, body.decision === "approve" ? "approved" : "rejected", body.actor);
      p.decided_by = body.actor;
      return route.fulfill({ json: p });
    }
    if (action === "/execution") {
      event(p, "execute", "executing", body.actor);
      return route.fulfill({ json: { proposal: p, commands: p.commands } });
    }
    if (action === "/execution/result") {
      event(p, body.outcome, body.outcome, body.actor, { results: body.results });
      p.executed_tick = body.applied_tick ?? null;
      return route.fulfill({ json: p });
    }
    if (action === "/explanations") {
      if (!fake.ai)
        return route.fulfill({
          status: 503,
          json: { error: { code: "AI_NOT_CONFIGURED", message: "not configured", details: {} } },
        });
      const e = p.evaluation;
      p.explanations.push({
        explanation_id: "11111111-1111-4111-8111-111111111111",
        provenance: "ai_generated",
        status: "ok",
        provider: "anthropic",
        model: "claude-opus-5-5",
        prompt_version: "twin-explain-1",
        content: {
          headline: "Waiting trucks start loading sooner",
          explanation: "Simulated, not measured: trucks waiting at busy origins pick up sooner.",
          trade_offs: ["More driving to standby stalls"],
          risks: ["A prediction over 15 simulated minutes"],
          operator_checks: ["Check free staging stalls"],
          cited_metrics: [
            {
              metric: "pickup_wait_s",
              baseline: e.baseline.metrics.pickup_wait_s,
              candidate: p.objective.candidate,
            },
          ],
          stance: "supports_approval",
        },
        error_code: null,
        error_message: null,
        latency_ms: 1200,
        created_at: now(),
      });
      return route.fulfill({ status: 201, json: p.explanations.at(-1) });
    }
    return route.fallback();
  });
  return fake;
}

async function openAi(page: Page, query = "?mode=ai") {
  await page.goto(`/${query}`);
  await expect(page.getByTestId("ai-view")).toBeVisible();
}

/** Optimise over 15 simulated minutes (the quickest horizon) and wait for the result. */
async function optimise(page: Page) {
  await page.getByTestId("twin-horizon").selectOption("9000");
  await page.getByTestId("twin-run").click();
  await expect(page.getByTestId("twin-result")).toBeVisible({ timeout: 120_000 });
}

test.describe("AI mode: fleet decision support", () => {
  test.describe.configure({ timeout: 240_000 });

  test("the mode bar opens a functional workspace on live, measured context", async ({ page }) => {
    await fakeTwin(page);
    await page.goto("/");
    await page.getByTestId("mode-ai").click();
    await expect(page).toHaveURL(/\?mode=ai$/);
    await expect(page.getByTestId("ai-view")).toBeVisible();
    await expect(page.getByTestId("mode-ai")).not.toHaveAttribute("data-status", "planned");
    const context = page.getByTestId("twin-context");
    await expect(context).toContainText("Live · measured from the running simulation");
    await expect(page.getByTestId("twin-demand-row")).toHaveCount(3);
    await expect(page.getByTestId("twin-ai-status")).toHaveText("AI not configured");
    await expect(page.getByTestId("twin-empty")).toBeVisible();
    await expect(page.getByTestId("twin-proposals-empty")).toBeVisible();
  });

  test("a single-site scenario explains why there is nothing to plan", async ({ page }) => {
    await fakeTwin(page);
    await openAi(page, "?scenario=showcase&mode=ai");
    await expect(page.getByTestId("twin-no-network")).toContainText("no line-haul fleet");
    await page.getByTestId("twin-open-network").click();
    await expect(page.getByTestId("twin-context")).toBeVisible();
  });

  test("optimise, compare, approve and apply through the engine, with an audit trail", async ({
    page,
  }) => {
    const fake = await fakeTwin(page);
    await openAi(page);
    await optimise(page);

    // Deterministic optimiser output, labelled as a simulated prediction.
    await expect(page.getByTestId("twin-recommendation")).toBeVisible();
    await expect(page.getByTestId("twin-recommendation")).toContainText(
      "Simulated prediction · deterministic optimiser",
    );
    await expect(
      page.locator('[data-testid="twin-candidate-row"][data-verdict="baseline"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="twin-candidate-row"][data-verdict="recommended"]'),
    ).toHaveCount(1);
    const wait = page.locator('[data-testid="twin-metric-row"][data-key="pickup_wait_s"]');
    await expect(wait.getByTestId("twin-metric-delta")).toContainText("−");
    await expect(page.getByTestId("twin-constraint")).toHaveCount(7);
    await expect(
      page.locator('[data-testid="twin-constraint"][data-satisfied="false"]'),
    ).toHaveCount(0);

    // Stored as a proposal; nothing is applied before an explicit approval.
    await expect(page.getByTestId("twin-status")).toHaveText("Awaiting review");
    expect(fake.posts).toEqual(["/proposals"]);
    await expect(page.getByTestId("twin-execute")).toHaveCount(0);
    const before = await page.evaluate(() =>
      Object.values(
        (window as unknown as HookWindow).__WAREHOUSE_ONE_SIM__.state().network?.vehicles ?? {},
      ).map((v) => v.standby_site ?? null),
    );
    expect(before.every((s) => s === null)).toBe(true);

    await expect(page.getByTestId("twin-approve")).toBeDisabled(); // a name is required
    await page.getByTestId("twin-operator").fill("Alex (shift lead)");
    await page.getByTestId("twin-approve").click();
    await expect(page.getByTestId("twin-confirm")).toContainText("Approve this standby plan?");
    await page.getByTestId("twin-confirm-yes").click();
    await expect(page.getByTestId("twin-status")).toHaveText("Approved");

    await page.getByTestId("twin-execute").click();
    await expect(page.getByTestId("twin-confirm")).toContainText("Apply the approved plan");
    await page.getByTestId("twin-confirm-yes").click();
    await expect(page.getByTestId("twin-status")).toHaveText("Applied", { timeout: 20_000 });
    await expect(page.getByTestId("twin-outcome")).toContainText("the engine accepted all");

    // The live run now carries exactly the approved plan, set by the server-issued commands.
    const p = [...fake.proposals.values()][0] as Json;
    const want = Object.fromEntries(
      p.evaluation.candidates
        .find((c: Json) => c.candidate_id === p.recommended_candidate_id)
        .plan.assignments.map((a: Json) => [a.vehicle_id, a.site_id]),
    );
    const live = await page.evaluate(() =>
      Object.fromEntries(
        Object.values(
          (window as unknown as HookWindow).__WAREHOUSE_ONE_SIM__.state().network?.vehicles ?? {},
        ).map((v) => [v.id, v.standby_site ?? null]),
      ),
    );
    expect(live).toEqual(want);
    const accepted = await page.evaluate(() =>
      (window as unknown as HookWindow).__WAREHOUSE_ONE_SIM__
        .commands()
        .filter((c) => c.command_id.startsWith("twin-e2e-"))
        .map((c) => c.status),
    );
    expect(accepted?.length).toBe(p.commands.length);
    expect(new Set(accepted)).toEqual(new Set(["accepted"]));
    await expect(page.getByTestId("twin-history-entry")).toHaveCount(5);
    expect(fake.posts).toEqual([
      "/proposals",
      `/proposals/${p.proposal_id}/decision`,
      `/proposals/${p.proposal_id}/execution`,
      `/proposals/${p.proposal_id}/execution/result`,
    ]);
    // A second click is impossible: an applied proposal offers no actions.
    await expect(page.getByTestId("twin-execute")).toHaveCount(0);
  });

  test("without the API the optimiser still runs; Retry repeats the failed save only", async ({
    page,
  }) => {
    const fake = await fakeTwin(page, { failCreates: 1 });
    await openAi(page);
    await optimise(page);
    const failure = page.getByTestId("twin-failure");
    await expect(failure).toHaveAttribute("data-op", "save");
    await expect(failure).toContainText("could not be saved");
    await expect(page.getByTestId("twin-unsaved")).toBeVisible();
    // The comparison is there, computed locally.
    await expect(page.getByTestId("twin-comparison")).toBeVisible();
    expect(fake.posts).toEqual(["/proposals"]);
    await page.getByTestId("twin-retry").click();
    await expect(page.getByTestId("twin-status")).toHaveText("Awaiting review");
    await expect(page.getByTestId("twin-failure")).toHaveCount(0);
    expect(fake.posts).toEqual(["/proposals", "/proposals"]); // the save, not the evaluation
  });

  test("an unreachable API is reported, and approvals are not offered", async ({ page }) => {
    await fakeTwin(page, { offline: true });
    await openAi(page);
    await expect(page.getByTestId("twin-api-offline")).toBeVisible();
    const failure = page.getByTestId("twin-failure");
    await expect(failure).toHaveAttribute("data-op", "capabilities");
    await expect(failure).toContainText("API unreachable");
    await expect(page.getByTestId("twin-run")).toBeEnabled();
  });

  test("a stale proposal is refused and expires instead of being approved", async ({ page }) => {
    await fakeTwin(page, { decision: "stale" });
    await openAi(page);
    await optimise(page);
    await page.getByTestId("twin-operator").fill("Alex");
    await page.getByTestId("twin-approve").click();
    await page.getByTestId("twin-confirm-yes").click();
    await expect(page.getByTestId("twin-stale")).toContainText("standby settings changed");
    await expect(page.getByTestId("twin-status")).toHaveText("Expired (stale)");
    await expect(page.getByTestId("twin-execute")).toHaveCount(0);
    await expect(page.getByTestId("twin-approve")).toHaveCount(0);
  });

  test("a conflicting decision reloads the proposal instead of overwriting it", async ({
    page,
  }) => {
    await fakeTwin(page, { decision: "conflict" });
    await openAi(page);
    await optimise(page);
    await page.getByTestId("twin-operator").fill("Alex");
    await page.getByTestId("twin-approve").click();
    await page.getByTestId("twin-confirm-yes").click();
    await expect(page.getByTestId("twin-conflict")).toContainText("changed meanwhile");
    await expect(page.getByTestId("twin-status")).toHaveText("Rejected");
  });

  test("an infeasible what-if plan is reported as infeasible, not adjusted", async ({ page }) => {
    await fakeTwin(page);
    await openAi(page);
    await page.getByTestId("twin-whatif").locator("summary").click();
    // 4 trucks on the terminal's 4 stalls: one must stay free, so at most 3 are allowed.
    await page.getByTestId("twin-whatif-harbour-terminal").fill("4");
    await page.getByTestId("twin-whatif-run").click();
    await expect(page.getByTestId("twin-result")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("twin-no-recommendation")).toBeVisible();
    const row = page.locator('[data-testid="twin-candidate-row"][data-verdict="infeasible"]');
    await expect(row).toContainText("not simulated");
    await expect(page.getByTestId("twin-infeasible")).toBeVisible();
    await expect(
      page.locator('[data-testid="twin-constraint"][data-satisfied="false"]'),
    ).toContainText("one staging stall left free");
    await expect(page.getByTestId("twin-status")).toHaveText("Nothing to approve");
  });

  test("AI explanations are labelled, and their absence is explicit", async ({ page }) => {
    const fake = await fakeTwin(page);
    await openAi(page);
    await optimise(page);
    await expect(page.getByTestId("twin-ai-unavailable")).toContainText("AI unavailable");
    await expect(page.getByTestId("twin-ai-explain")).toHaveCount(0);

    fake.ai = true;
    await page.reload();
    await expect(page.getByTestId("twin-ai-status")).toHaveText("AI: claude-opus-5-5");
    await page.getByTestId("twin-proposal-row").first().click();
    await page.getByTestId("twin-ai-explain").click();
    const text = page.getByTestId("twin-ai-explanation");
    await expect(text).toContainText("Waiting trucks start loading sooner");
    await expect(page.getByTestId("twin-ai")).toContainText("AI-generated · not a measurement");
    await expect(page.getByTestId("twin-ai-explanation")).toContainText("claude-opus-5-5");
  });
});
