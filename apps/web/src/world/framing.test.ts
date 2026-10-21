import { createScenario, dockedTruckPose } from "@warehouse-one/simulation";
import { Box3, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { facilityFrame, fitBox, maxNdcExtent, overviewPose } from "./framing";

const facility = createScenario("showcase").config.facility!;
const box = facilityFrame(facility, 6.2);

describe("camera framing", () => {
  it.each([
    ["desktop 16:10", 1440 / 900],
    ["ultrawide", 21 / 9],
    ["tablet portrait", 768 / 1024],
    ["phone portrait", 390 / 844],
  ])("overview keeps the whole facility on screen (%s)", (_name, aspect) => {
    const pose = overviewPose(box, aspect);
    const extent = maxNdcExtent(box, pose, aspect);
    expect(extent).toBeLessThanOrEqual(0.93);
    // ...and is not needlessly far away: the facility fills most of the view.
    expect(extent).toBeGreaterThan(0.75);
  });

  it("frames the facility larger on a phone in portrait than a fixed landscape angle would", () => {
    const aspect = 390 / 844;
    const portraitPose = overviewPose(box, aspect);
    const naive = fitBox(box, 0.62, 0.9, aspect, 0.92);
    const dist = (p: { position: readonly number[]; target: readonly number[] }) =>
      Math.hypot(...p.position.map((v, i) => v - (p.target[i] ?? 0)));
    expect(dist(portraitPose)).toBeLessThan(dist(naive));
  });

  it("includes the area trucks occupy when docked", () => {
    const config = createScenario("showcase").config;
    for (const d of facility.docks) {
      const truck = dockedTruckPose(config, d.id);
      expect(box.containsPoint(new Vector3(truck.x, 1, truck.z))).toBe(true);
      // Both ends of the trailer, not just its centre.
      expect(box.containsPoint(new Vector3(truck.x, 1, truck.z + 8))).toBe(true);
    }
  });

  it("fits arbitrary boxes from any direction", () => {
    const small = new Box3(new Vector3(-1, 0, -1), new Vector3(1, 2, 1));
    const pose = fitBox(small, 1.2, 0.7, 1.5, 0.5);
    expect(maxNdcExtent(small, pose, 1.5)).toBeCloseTo(0.5, 2);
  });
});
