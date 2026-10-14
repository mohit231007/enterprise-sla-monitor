"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertOctagon, CalendarDays, CircleDollarSign, Clock3, RefreshCw, ShieldAlert, UsersRound } from "lucide-react";
import { appendDemoEvent, getDashboard, getDataStatus } from "@/lib/api";
import { DashboardData, DataStatus } from "@/lib/types";
import { BranchHealthTable } from "./BranchHealthTable";
import { PerformanceChart, TrendChart } from "./Charts";
import { InterventionTable } from "./InterventionTable";
import { KpiCard } from "./KpiCard";
import { LiveDataPanel } from "./LiveDataPanel";
import { SqlExplorer } from "./SqlExplorer";
import { CsvUploadPanel } from "./CsvUploadPanel";

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const defaultEnd = new Date();
const defaultStart = new Date(defaultEnd.getTime() - 29 * 86_400_000);
const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", notation: "compact", maximumFractionDigits: 2 });

export function Dashboard() {
  const [from, setFrom] = useState(isoDate(defaultStart));
  const [to, setTo] = useState(isoDate(defaultEnd));
  const [data, setData] = useState<DashboardData | null>(null);
  const [dataStatus, setDataStatus] = useState<DataStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadReady,setUploadReady] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dashboard, status] = await Promise.all([getDashboard(new URLSearchParams({ from, to })), getDataStatus()]);
      setData(dashboard);
      setDataStatus(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the dashboard.");
    } finally { setLoading(false); }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);
  const resetRange = () => { setFrom(isoDate(defaultStart)); setTo(isoDate(defaultEnd)); };
  const simulate = async () => {
    try { setLoading(true); await appendDemoEvent(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not ingest the simulated event."); setLoading(false); }
  };

  return <main className="min-h-screen bg-[#f6f8fc]"><div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8">
    <header className="mb-7 flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-xl bg-blue-600 text-lg font-bold text-white shadow-sm">B</div><div><div className="flex items-center gap-2"><h1 className="text-xl font-bold tracking-tight text-slate-950">Branch360</h1><span className="rounded bg-blue-50 px-2 py-0.5 text-[10px] font-bold tracking-wide text-blue-700">SQL ANALYTICS</span></div><p className="mt-1 text-sm text-slate-500">Branch Performance &amp; Operations Intelligence</p></div></div>
      <div className="panel flex flex-wrap items-center gap-2 p-2"><CalendarDays size={17} className="ml-1 text-slate-500" /><input aria-label="From date" value={from} onChange={(event) => setFrom(event.target.value)} type="date" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-500" /><span className="text-sm text-slate-400">to</span><input aria-label="To date" value={to} onChange={(event) => setTo(event.target.value)} type="date" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-500" /><button onClick={resetRange} className="rounded-lg px-2 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100">30 days</button><button onClick={() => void load()} className="rounded-lg bg-slate-900 p-2 text-white hover:bg-slate-700" aria-label="Refresh dashboard"><RefreshCw size={16} className={loading ? "animate-spin" : ""} /></button></div>
    </header>
    {error ? <ErrorState error={error} onRetry={() => void load()} /> : loading && !data ? <LoadingSkeleton /> : data ? <>
      <LiveDataPanel status={dataStatus} busy={loading} onSimulate={() => void simulate()} />
      <CsvUploadPanel onUploaded={({dateFrom,dateTo})=>{setFrom(dateFrom);setTo(dateTo);setUploadReady(true);}} />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"><p className="text-sm text-slate-600">{uploadReady?"New data committed. Generate the latest SQL report.":"Generate a fresh SQL-backed report for the selected date range."}</p><button onClick={()=>{setUploadReady(false);void load();}} disabled={loading} className="rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-bold tracking-wide text-white disabled:opacity-50">GENERATE REPORT</button></div>
      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><KpiCard label="Total revenue" value={inr.format(data.summary.totalRevenue)} detail={`${data.summary.slaBreachRate.toFixed(1)}% portfolio breach rate`} icon={CircleDollarSign} tone="blue" trend="up" /><KpiCard label="Avg. turnaround time" value={`${data.summary.avgTatHours.toFixed(1)} hrs`} detail="Across all closed tickets" icon={Clock3} tone="green" trend="down" /><KpiCard label="Active SLA breaches" value={String(data.summary.activeSlaBreaches)} detail={`${data.summary.totalPendingCases} pending cases in total`} icon={ShieldAlert} tone="red" /><KpiCard label="Open complaints" value={String(data.summary.openComplaints)} detail="Needs frontline resolution" icon={UsersRound} tone="amber" /></section>
      <section className="mb-6 grid gap-6 xl:grid-cols-2"><PerformanceChart branches={data.branches} /><TrendChart trends={data.trends} /></section>
      <section className="mb-6 rounded-2xl border border-blue-100 bg-gradient-to-r from-blue-50 to-white px-5 py-4"><p className="text-sm font-semibold text-blue-950">Management focus</p><p className="mt-1 text-sm text-slate-600">{data.interventions.length ? `${data.interventions.filter((item) => item.status === "Critical").length} critical and ${data.interventions.filter((item) => item.status === "Warning").length} warning branch interventions require a named owner and next review date.` : "The branch portfolio is operating within the current intervention thresholds."}</p></section>
      <SqlExplorer /><BranchHealthTable branches={data.branches} /><InterventionTable interventions={data.interventions} />
      <p className="mt-4 text-center text-xs text-slate-400">Showing {data.summary.dateRange.from} to {data.summary.dateRange.to} · Intervention thresholds: &gt;10% SLA breaches or &gt;15 open complaints</p>
    </> : null}
  </div></main>;
}

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <div className="panel flex flex-col items-center gap-3 px-6 py-14 text-center"><AlertOctagon className="text-red-600" size={30} /><p className="font-semibold text-slate-900">Dashboard data is unavailable</p><p className="text-sm text-slate-500">{error}</p><button onClick={onRetry} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Try again</button></div>;
}

function LoadingSkeleton() {
  return <div className="animate-pulse"><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-37 rounded-2xl bg-slate-200" />)}</div><div className="mt-6 grid gap-6 xl:grid-cols-2"><div className="h-90 rounded-2xl bg-slate-200" /><div className="h-90 rounded-2xl bg-slate-200" /></div><div className="mt-6 h-72 rounded-2xl bg-slate-200" /></div>;
}
