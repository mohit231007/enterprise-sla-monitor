import { DashboardData, DataStatus } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Dashboard API returned ${response.status}`);
  return response.json() as Promise<T>;
}

export async function getDashboard(params: URLSearchParams): Promise<DashboardData> {
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const [summary, branchData, interventionData, trendData] = await Promise.all([
    request<DashboardData["summary"]>(`/api/dashboard/summary${suffix}`),
    request<{ branches: DashboardData["branches"] }>(`/api/dashboard/branches${suffix}`),
    request<{ interventions: DashboardData["interventions"] }>(`/api/dashboard/interventions${suffix}`),
    request<{ trends: DashboardData["trends"] }>(`/api/dashboard/trends${suffix}`)
  ]);
  return { summary, branches: branchData.branches, interventions: interventionData.interventions, trends: trendData.trends };
}

export function getDataStatus() { return request<DataStatus>("/api/dashboard/data-status"); }

export async function appendDemoEvent() {
  const response = await fetch(`${API_URL}/api/dashboard/demo/tick`, { method: "POST" });
  if (!response.ok) throw new Error(`Could not ingest demo event (${response.status})`);
  return response.json() as Promise<{ message: string }>;
}
