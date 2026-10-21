import { expect, test } from "@playwright/test";
import { cameraRest, netState, openWorld, pause, rests, scene, simPoses } from "./helpers";

/**
 * Phase 5: the multi-site logistics world. The default scenario is the logistics network; every
 * check compares what the browser shows with the authoritative simulation (read-only hooks).
 */

const LINEHAUL_LABEL: Record<string, string> = {
  parked: "Parked",
  driving: "Driving",
  docking: "Reversing onto a stand",
  loading: "Loading",
  unloading: "Unloading",
  waiting: "Waiting",
  undocking: "Pulling out",
  at_dc: "At the distribution centre",
  off_network: "Last-mile run (off map)",
  servicing: "In service",
};

const SITES = ["northgate-dc", "harbour-terminal", "riverside-xd", "fleet-depot", "east-gateway"];

test.describe("multi-site logistics world", () => {
  test("opens on the world view with every site, the roads and the line-haul fleet; trucks are inspectable", async ({
    page,
  }) => {
    await openWorld(page);
    await expect(page.getByTestId("site-navigator")).toHaveAttribute("data-scope", "world");
    const net = (await scene(page))!.network!;
    expect(net.sites.map((s) => s.id)).toEqual(SITES);
    expect(net.roads).toBeGreaterThan(40);
    expect(net.buildings).toBeGreaterThanOrEqual(3);
    // Every site's label is on screen in the world view.
    for (const id of SITES) await expect(page.getByTestId(`site-label-${id}`)).toBeVisible();
    // Containers and pallets drawn equal the simulation's counts.
    const s = await netState(page);
    expect(net.containers["harbour-terminal"]).toBe(
      s.network.sites["harbour-terminal"]!.containers,
    );
    const xdStock = Object.values(s.network.sites["riverside-xd"]!.stock).reduce(
      (a, b) => a + b,
      0,
    );
    await expect
      .poll(async () => (await scene(page))!.network!.floorPallets["riverside-xd"])
      .toBe(xdStock);
    await expect(page.getByTestId("kpi-linehaul")).toBeVisible();
    await expect(page.getByTestId("network-panel")).toBeVisible();

    // A line-haul truck is selected from the network panel and shows its live state.
    await pause(page);
    await page.getByTestId("fleet-row-lh-01").click();
    await expect(page.getByTestId("inspector")).toContainText("lh-01");
    const v = (await netState(page)).network.vehicles["lh-01"]!;
    await expect(page.getByTestId("inspector-status")).toHaveText(LINEHAUL_LABEL[v.status]!);
  });

  test("line-haul trucks drive between sites on the roads, drawn exactly where the simulation has them", async ({
    page,
  }) => {
    await openWorld(page);
    await page.locator("body").press("5"); // 8×
    await expect
      .poll(
        async () =>
          Object.values((await netState(page)).network.vehicles).filter(
            (v) => v.status === "driving",
          ).length,
        { timeout: 60_000, intervals: [200] },
      )
      .toBeGreaterThan(1);
    await pause(page);
    const poses = (await simPoses(page)).linehaul;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    await expect
      .poll(async () => (await scene(page))?.fleet)
      .toEqual(poses.map((p) => ({ id: p.id, x: round(p.x), z: round(p.z) })));
    // A driving truck is on a road: within half a carriageway of a road's centre line.
    const onRoad = await page.evaluate(() => {
      const hook = (
        window as unknown as {
          __WAREHOUSE_ONE_SIM__: {
            config(): {
              network: {
                nodes: { id: string; position: { x: number; z: number } }[];
                roads: { from: string; to: string }[];
              };
            };
            state(): { network: { vehicles: Record<string, { id: string; status: string }> } };
            poses(): { linehaul: { id: string; x: number; z: number }[] };
          };
        }
      ).__WAREHOUSE_ONE_SIM__;
      const net = hook.config().network;
      const at = new Map(net.nodes.map((n) => [n.id, n.position]));
      const driving = Object.values(hook.state().network.vehicles)
        .filter((v) => v.status === "driving")
        .map((v) => v.id);
      return hook
        .poses()
        .linehaul.filter((p) => driving.includes(p.id))
        .map((p) =>
          Math.min(
            ...net.roads.map((r) => {
              const a = at.get(r.from)!;
              const b = at.get(r.to)!;
              const l2 = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
              const t = Math.max(
                0,
                Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / l2),
              );
              return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.z - (a.z + t * (b.z - a.z)));
            }),
          ),
        );
    });
    expect(onRoad.length).toBeGreaterThan(1);
    for (const d of onRoad) expect(d).toBeLessThan(3);
    // Resuming moves them (the simulation, not an animation, drives the trucks).
    const before = await simPoses(page);
    await page.getByTestId("sim-toggle").click();
    await expect
      .poll(
        async () => {
          const now = (await simPoses(page)).linehaul;
          return now.some((p) => {
            const b = before.linehaul.find((x) => x.id === p.id);
            return !!b && Math.hypot(p.x - b.x, p.z - b.z) > 5;
          });
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  test("site labels and the navigator fly between the world and each facility", async ({
    page,
  }) => {
    await openWorld(page);
    const world = (await scene(page))!.camera!;
    let r = await rests(page);
    await page.getByTestId("site-label-riverside-xd").click();
    await cameraRest(page, r);
    await expect(page.getByTestId("site-navigator")).toHaveAttribute("data-scope", "riverside-xd");
    await expect(page.getByTestId("inspector")).toContainText("Riverside cross-dock");
    const xd = (await scene(page))!.network!.sites.find((s) => s.id === "riverside-xd")!;
    const atXd = (await scene(page))!.camera!;
    expect(atXd.target[0]).toBeGreaterThan(xd.bounds.min.x);
    expect(atXd.target[0]).toBeLessThan(xd.bounds.max.x);
    const dist = (c: typeof world) => Math.hypot(...c.position.map((v, i) => v - c.target[i]!));
    expect(dist(atXd)).toBeLessThan(dist(world));
    // The focused site's own label is hidden in its facility view; the others stay.
    await expect(page.getByTestId("site-label-riverside-xd")).toBeHidden();

    r = await rests(page);
    await page.getByTestId("nav-site-harbour-terminal").click();
    await cameraRest(page, r);
    await expect(page.getByTestId("site-navigator")).toHaveAttribute(
      "data-scope",
      "harbour-terminal",
    );
    const containers = (await netState(page)).network.sites["harbour-terminal"]!.containers;
    await expect(page.getByTestId("inspector-site-containers")).toContainText(`${containers} /`);

    r = await rests(page);
    await page.getByTestId("nav-site-northgate-dc").click();
    await cameraRest(page, r);
    // The DC's facility view brings back its own operations panel.
    await expect(page.getByTestId("operations-panel")).toBeVisible();
    expect((await scene(page))!.counts!.bays).toBe(84);

    r = await rests(page);
    await page.getByTestId("nav-world").click();
    await cameraRest(page, r);
    await expect(page.getByTestId("site-navigator")).toHaveAttribute("data-scope", "world");
    expect(dist((await scene(page))!.camera!)).toBeGreaterThan(dist(atXd) * 1.5);
  });

  test("an operator transfer request is planned, then picked up by a truck", async ({ page }) => {
    await openWorld(page);
    await page.getByTestId("nav-site-riverside-xd").click();
    await expect(page.getByTestId("transfer-form")).toBeVisible();
    await page.getByTestId("transfer-to").selectOption("harbour-terminal");
    await page.getByTestId("transfer-sku").selectOption("sku-cold-chain");
    await page.getByTestId("transfer-quantity").fill("3");
    await page.getByTestId("transfer-submit").click();
    const row = page.locator('[data-testid="command-row"]').first();
    await expect(row).toHaveAttribute("data-status", "accepted", { timeout: 15_000 });
    const operator = async () =>
      Object.values((await netState(page)).network.transfers).find((t) => t.lane_id === null);
    await expect.poll(async () => (await operator())?.to_site).toBe("harbour-terminal");
    await page.locator("body").press("5");
    await expect
      .poll(async () => (await operator())?.vehicle_id ?? null, { timeout: 60_000 })
      .not.toBeNull();
    // An impossible request is rejected with the engine's reason, not thrown.
    await page.getByTestId("transfer-quantity").fill("26");
    await page.getByTestId("transfer-submit").click();
    await expect(page.locator('[data-testid="command-row"]').first()).toHaveAttribute(
      "data-code",
      "INSUFFICIENT_STOCK",
      { timeout: 15_000 },
    );
  });
});

test.describe("multi-site world on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("shows the network without horizontal scrolling and navigates to a site", async ({
    page,
  }) => {
    await openWorld(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    await expect(page.getByTestId("site-navigator")).toBeVisible();
    const r = await rests(page);
    await page.getByTestId("nav-site-riverside-xd").click();
    await cameraRest(page, r);
    await expect(page.getByTestId("site-navigator")).toHaveAttribute("data-scope", "riverside-xd");
  });
});
