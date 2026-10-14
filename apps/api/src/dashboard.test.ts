import { expect, it } from "vitest";
import { prisma, getBranchMetrics } from "./dashboard.js";

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
