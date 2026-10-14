"use client";
import { useEffect,useState } from "react";
import { createReport, getIngestionHistory, getQueryCatalog, runCatalogQuery } from "@/lib/api";
import { generateXlsx, type Cell, type Sheet } from "@/lib/native-xlsx";
type Report = Awaited<ReturnType<typeof createReport>>;
type HistoryRow={id:number;source:string;status:string;startedAt:string;completedAt:string|null;recordsReceived:number;recordsAccepted:number;recordsRejected:number;notes:string|null};
type Query={id:string;name:string;description:string;sql:string};
function download(content:string,type:string,name:string){
 const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const csv=(rows:Record<string,unknown>[])=>{
 const cols=Object.keys(rows[0]??{});
 const esc=(x:unknown)=>'"'+String(x??"").replaceAll('"','""')+'"';
 return [cols.map(esc).join(","),...rows.map(r=>cols.map(c=>esc(r[c])).join(","))].join("\r\n");
};
export function ReportingWorkspace({from,to,reportRefresh}:{from:string;to:string;reportRefresh:number}){
 const [queries,setQueries]=useState<Query[]>([]),[selected,setSelected]=useState("branch-performance");
 const [rows,setRows]=useState<Record<string,unknown>[]>([]);
 const [report,setReport]=useState<Report|null>(null);
 const [history,setHistory]=useState<HistoryRow[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 const [tab,setTab]=useState<"sql"|"history"|"reports">("reports");
 useEffect(()=>{void getQueryCatalog().then(r=>setQueries(r.queries)).catch(()=>{});},[]);
 useEffect(()=>{void getIngestionHistory().then(r=>setHistory(r.runs)).catch(()=>{});},[reportRefresh]);
 useEffect(()=>{if(reportRefresh>0){void createReport(from,to).then(r=>{setReport(r);setTab("reports");}).catch(e=>setError(String(e)));}},[reportRefresh]);
 async function runQuery(){setBusy(true);setError("");try{setRows((await runCatalogQuery(selected,from,to)).rows);setTab("sql");}catch(e){setError(String(e));}finally{setBusy(false);}}
 async function generate(){setBusy(true);setError("");try{const r=await createReport(from,to);setReport(r);setTab("reports");const h=await getIngestionHistory();setHistory(h.runs);}catch(e){setError(String(e));}finally{setBusy(false);}}
 function exportRows(){if(!report)return;return [
  {section:"Portfolio",metric:"Revenue",value:report.summary.totalRevenue},
  {section:"Portfolio",metric:"Average TAT (hours)",value:report.summary.avgTatHours},
  {section:"Portfolio",metric:"Open complaints",value:report.summary.openComplaints},
  {section:"Portfolio",metric:"Active SLA breaches",value:report.summary.activeSlaBreaches},
  ...report.branches.map(b=>({section:"Branch",metric:b.name+" target achievement (%)",value:b.revenueAchievement}))
 ];}
 async function exportExcel(){
   if(!report)return;
   const sheets:Sheet[]=[
     {name:"Summary",rows:[
       ["Branch360 — Branch Operations Report"],
       ["Report ID",report.id],["Period from",report.period.from],["Period to",report.period.to],
       ["Generated UTC",report.createdAt],["SHA-256",report.contentSha256],
       ["Metric","Value"],["Revenue INR",report.summary.totalRevenue],
       ["Average TAT hours",report.summary.avgTatHours],["Open complaints",report.summary.openComplaints],
       ["Active SLA breaches",report.summary.activeSlaBreaches],
       ["Total pending cases",report.summary.totalPendingCases],
       ["SLA breach rate (%)",report.summary.slaBreachRate]
     ]},
     {name:"Branches",rows:[
       ["Branch","Region","Manager","Revenue INR","Target INR","Achievement (%)","Average TAT (hours)","Open cases","Open complaints","SLA breaches","Active SLA breaches","Breach rate (%)","Health"],
       ...report.branches.map(b=>[b.name,b.region,b.managerName,b.revenue,b.revenueTarget,b.revenueAchievement,b.avgTatHours,b.pendingCases,b.openComplaints,b.slaBreaches,b.activeSlaBreaches,b.breachPercentage,b.health] as Cell[])
     ]},
     {name:"Interventions",rows:[
       ["Branch","Severity","Critical metric","Suggested action","SLA breach rate (%)","Open complaints"],
       ...report.interventions.map(i=>[i.branchName,i.status,i.criticalMetric,i.suggestedAction,i.breachPercentage,i.openComplaints] as Cell[])
     ]},
     {name:"Audit metadata",rows:[
       ["Field","Value"],["Report ID",report.id],["Created UTC",report.createdAt],
       ["Period from",report.period.from],["Period to",report.period.to],
       ["Content SHA-256",report.contentSha256],
       ["Ingestion runs present (not row-level lineage)",report.ingestionRunIds.join(", ")],
       ["Source","Synthetic demonstration data"]
     ]}
   ];
   const workbook=generateXlsx(sheets);
   const blob=new Blob([new Uint8Array(workbook)],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
   const url=URL.createObjectURL(blob),link=document.createElement("a");
   link.href=url;link.download=report.id+".xlsx";link.click();
   setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 function printReport(){if(!report)return;window.print();}

 return <><section className="panel mb-6 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-slate-900">SQL &amp; reporting workspace</h2><p className="text-sm text-slate-500">Read-only SQL queries · immutable reports · ingestion audit</p></div><div className="flex gap-2">{(["reports","sql","history"] as const).map(t=><button key={t} onClick={()=>setTab(t)} className={`rounded-lg px-3 py-2 text-sm ${tab===t?"bg-blue-600 text-white":"bg-slate-100 text-slate-700"}`}>{t==="sql"?"SQL Explorer":t==="history"?"Ingestion history":"Reports"}</button>)}</div></div>
 {error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
 {tab==="reports"&&<div className="mt-4 space-y-3"><button disabled={busy} onClick={()=>void generate()} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">SAVE REPORT SNAPSHOT</button>{report&&<><p className="text-sm">Report <strong>{report.id}</strong> · {new Date(report.createdAt).toLocaleString()} · {report.period.from} to {report.period.to}</p><p className="break-all text-xs text-slate-500">SHA-256: {report.contentSha256} · Ingestion runs present at creation (not row-level lineage): {report.ingestionRunIds.join(", ")||"None"}</p><div className="flex flex-wrap gap-2"><button onClick={()=>download(csv(exportRows()??[]),"text/csv",report.id+".csv")} className="rounded-lg border px-3 py-2 text-sm">Download CSV</button><button onClick={()=>void exportExcel()} className="rounded-lg border px-3 py-2 text-sm">Download XLSX</button><button onClick={printReport} className="rounded-lg border px-3 py-2 text-sm">Print / Save PDF</button></div></>}</div>}
 {tab==="sql"&&<div className="mt-4 space-y-3"><div className="flex gap-2"><select value={selected} onChange={e=>{setSelected(e.target.value);setRows([]);}} className="rounded-lg border px-3 py-2 text-sm">{queries.map(q=><option key={q.id} value={q.id}>{q.name}</option>)}</select><button onClick={()=>void runQuery()} disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">RUN QUERY</button>{rows.length>0&&<button onClick={()=>download(csv(rows),"text/csv","branch360-query.csv")} className="rounded-lg border px-3 py-2 text-sm">Export results</button>}</div><p className="text-xs text-slate-500">{queries.find(q=>q.id===selected)?.description}</p><pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-5 text-emerald-300">{queries.find(q=>q.id===selected)?.sql??"Loading queries..."}</pre>{rows.length>0&&<div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{Object.keys(rows[0]).map(k=><th className="border-b p-2" key={k}>{k}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{Object.values(r).map((v,j)=><td key={j} className="border-b p-2">{String(v??"—")}</td>)}</tr>)}</tbody></table></div>}</div>}
 {tab==="history"&&<div className="mt-4 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{["Run","Source","Status","Received","Accepted","Rejected","Started"].map(x=><th key={x} className="border-b p-2">{x}</th>)}</tr></thead><tbody>{history.map(r=><tr key={r.id}>{[r.id,r.source,r.status,r.recordsReceived,r.recordsAccepted,r.recordsRejected,new Date(r.startedAt).toLocaleString()].map((v,i)=><td key={i} className="border-b p-2">{v}</td>)}</tr>)}</tbody></table></div>}
 </section>
 {report&&<article id="branch360-print-report" className="branch360-print-report" aria-label="Printable Branch360 report">
  <div className="print-report-head">
    <p className="print-kicker">BRANCH360 / ENTERPRISE BRANCH ANALYTICS</p>
    <h1>Branch Performance &amp; Operations Report</h1>
    <p>{report.period.from} — {report.period.to}</p>
    <div className="print-report-meta"><span>Report ID: {report.id}</span><span>Generated: {new Date(report.createdAt).toLocaleString()}</span></div>
  </div>
  <h2>Executive summary</h2>
  <div className="print-metrics">
    <div><small>Total revenue</small><strong>₹{report.summary.totalRevenue.toLocaleString("en-IN")}</strong></div>
    <div><small>Average turnaround time</small><strong>{report.summary.avgTatHours.toFixed(1)} hours</strong></div>
    <div><small>Open complaints</small><strong>{report.summary.openComplaints}</strong></div>
    <div><small>Active SLA breaches</small><strong>{report.summary.activeSlaBreaches}</strong></div>
    <div><small>Pending cases</small><strong>{report.summary.totalPendingCases}</strong></div>
    <div><small>Portfolio SLA breach rate</small><strong>{report.summary.slaBreachRate.toFixed(1)}%</strong></div>
  </div>
  <h2>Branch portfolio performance</h2>
  <table className="print-table"><thead><tr><th>Branch</th><th>Revenue (₹)</th><th>Achievement</th><th>Avg TAT</th><th>Open cases</th><th>Breach rate</th><th>Health</th></tr></thead>
  <tbody>{report.branches.map(b=><tr key={b.id}><td>{b.name}<small>{b.region} · {b.managerName}</small></td><td>{b.revenue.toLocaleString("en-IN")}</td><td>{b.revenueAchievement.toFixed(1)}%</td><td>{b.avgTatHours.toFixed(1)}h</td><td>{b.pendingCases}</td><td>{b.breachPercentage.toFixed(1)}%</td><td>{b.health}</td></tr>)}</tbody></table>
  <h2>Recommended interventions</h2>
  {report.interventions.length?<table className="print-table"><thead><tr><th>Branch</th><th>Priority</th><th>Reason</th><th>Suggested action</th></tr></thead>
  <tbody>{report.interventions.map(i=><tr key={i.branchId}><td>{i.branchName}</td><td>{i.status}</td><td>{i.criticalMetric}</td><td>{i.suggestedAction}</td></tr>)}</tbody></table>:<p>No interventions for the selected period.</p>}
  <h2>Audit &amp; reproducibility</h2>
  <p className="print-digest">SHA-256: {report.contentSha256}</p>
  <p>Ingestion runs present at report creation: {report.ingestionRunIds.join(", ")||"None"}. These are not row-level lineage records.</p>
  <p className="print-disclaimer">Synthetic demonstration dataset. Not an official bank report.</p>
 </article>}
 </>;
}
