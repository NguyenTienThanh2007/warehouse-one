import { describe, expect, it } from "vitest";
import { formatSimClock, layoutFromSearch } from "./store";

describe("layoutFromSearch", () => {
  it("parses and clamps benchmark layouts", () => {
    expect(layoutFromSearch("?aisles=10&bays=100")).toEqual({ aisles: 10, bays: 100 });
    expect(layoutFromSearch("?aisles=999&bays=999")).toEqual({ aisles: 20, bays: 100 });
  });
  it.each(["", "?aisles=0&bays=5", "?aisles=2.5&bays=5", "?aisles=x&bays=1", "?bays=5"])(
    "ignores invalid input %j",
    (q) => {
      expect(layoutFromSearch(q)).toBeNull();
    },
  );
});

describe("formatSimClock", () => {
  it("formats epoch + simulated time as UTC wall clock", () => {
    expect(formatSimClock("2026-01-05T06:00:00.000Z", 0)).toBe("06:00:00");
    expect(formatSimClock("2026-01-05T06:00:00.000Z", 3_723_000)).toBe("07:02:03");
  });
});
