import { expect, it } from "vitest";
import { prisma, getBranchMetrics, parseUtcDay, toInclusiveEnd } from "./dashboard.js";

it("preserves PostgreSQL raw-query aliases and maps targets and manager names", async () => {
  const latest = await prisma.dailyPerformance.findFirst({orderBy:{date:"desc"}});
  expect(latest).not.toBeNull();
  const from = new Date(latest!.date.getTime() - 29*86400000);
  const metrics = await getBranchMetrics({from,to:latest!.date});
  const branch = metrics.find(r=>r.id===latest!.branchId);
  expect(branch).toBeDefined();
  expect(branch!.managerName).toBeTruthy();
  expect(branch!.revenueTarget).toBeGreaterThan(0);
  expect(branch!.revenueAchievement).toBeGreaterThan(0);
});

it("uses UTC calendar-day boundaries independent of the Node process timezone", () => {
  const day = parseUtcDay("2026-10-15");
  expect(day.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  expect(toInclusiveEnd(day).toISOString()).toBe("2026-10-15T23:59:59.999Z");
  expect(parseUtcDay("2028-02-29").toISOString()).toBe("2028-02-29T00:00:00.000Z");
  expect(() => parseUtcDay("2026-02-29")).toThrow("valid YYYY-MM-DD");
  expect(() => parseUtcDay("2026-13-01")).toThrow("valid YYYY-MM-DD");
  expect(() => parseUtcDay("2026-10-15T13:00")).toThrow("valid YYYY-MM-DD");
});
