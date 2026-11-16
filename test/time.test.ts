import { describe, expect, it } from "vitest";
import { HOUR, addWorkingTime, monthKey, nextWorkingStart } from "../src/index.js";
import { OFFICES, blr, oslo } from "./helpers.js";

const O = OFFICES.OSLO;

describe("working time", () => {
  it("adds within a working day", () => {
    expect(addWorkingTime(oslo(16, 10), 2 * HOUR, O)).toBe(oslo(16, 12));
  });
  it("pauses overnight", () => {
    expect(addWorkingTime(oslo(16, 16), 2 * HOUR, O)).toBe(oslo(17, 10));
  });
  it("pauses over the weekend", () => {
    expect(addWorkingTime(oslo(20, 16), 2 * HOUR, O)).toBe(oslo(23, 10)); // Fri 16:00 -> Mon 10:00
    expect(addWorkingTime(oslo(21, 12), 2 * HOUR, O)).toBe(oslo(23, 11)); // Sat -> Mon 11:00
  });
  it("respects DST (Oslo switches to summer time on Sun 2027-03-28)", () => {
    const fri = oslo(26, 16, 0, 3, 2027);
    expect(addWorkingTime(fri, 2 * HOUR, O)).toBe(oslo(29, 10, 0, 3, 2027));
    expect(new Date(oslo(29, 10, 0, 3, 2027)).toISOString()).toBe("2027-03-29T08:00:00.000Z");
  });
  it("next working start from Friday evening is Monday 09:00", () => {
    expect(nextWorkingStart(oslo(20, 20), O)).toBe(oslo(23, 9));
  });
});

describe("months are office-local", () => {
  it("01:30 IST on Dec 1 is December in Bengaluru but November in UTC", () => {
    const t = blr(1, 1, 30, 12);
    expect(new Date(t).toISOString().slice(0, 7)).toBe("2026-11");
    expect(monthKey(t, "Asia/Kolkata")).toBe("2026-12");
  });
});
