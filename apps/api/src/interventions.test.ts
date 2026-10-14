import { describe, expect, it } from "vitest";
import { branchHealth, deriveIntervention } from "./interventions.js";

const base = { id: 1, name: "Bandra West", breachPercentage: 8, openComplaints: 9, avgTatHours: 20, revenueAchievement: 104 };

describe("Branch360 intervention policy", () => {
  it("does not flag branches at or below the agreed thresholds", () => {
    expect(deriveIntervention({ ...base, breachPercentage: 10, openComplaints: 15 })).toBeNull();
  });

  it("creates a critical recommendation when both thresholds are breached", () => {
    expect(deriveIntervention({ ...base, breachPercentage: 11, openComplaints: 16 })).toMatchObject({ status: "Critical", criticalMetric: "SLA breach rate and open complaints" });
  });

  it("keeps commercial and operational health separate", () => {
    expect(branchHealth({ ...base, revenueAchievement: 88 })).toBe("Watch");
    expect(branchHealth({ ...base, openComplaints: 17 })).toBe("At risk");
  });
});
