"use client";
import { useEffect,useState } from "react";
import { createReport, getIngestionHistory, getQueryCatalog, runCatalogQuery } from "@/lib/api";
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
 async function runQuery(){setBusy(true);setError("");try{setRows((await runCatalogQuery(selected,from,to)).rows);setTab("sql");}catch(e){setError(String(e));}finally{setBusy(false);}}
 async function generate(){setBusy(true);setError("");try{const r=await createReport(from,to);setReport(r);setTab("reports");const h=await getIngestionHistory();setHistory(h.runs);}catch(e){setError(String(e));}finally{setBusy(false);}}
 function exportRows(){if(!report)return;return [
  {section:"Portfolio",metric:"Revenue",value:report.summary.totalRevenue},
  {section:"Portfolio",metric:"Average TAT (hours)",value:report.summary.avgTatHours},
  {section:"Portfolio",metric:"Open complaints",value:report.summary.openComplaints},
  {section:"Portfolio",metric:"Active SLA breaches",value:report.summary.activeSlaBreaches},
  ...report.branches.map(b=>({section:"Branch",metric:b.name+" target achievement (%)",value:b.revenueAchievement}))
 ];}
 function exportExcel(){const cells=exportRows()??[];
   // Excel-compatible SpreadsheetML, explicitly exported as .xml (not mislabeled .xlsx).
   const xml='<?xml version="1.0" encoding="UTF-8"?>'+
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Branch360" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Table>'+
    [["Section","Metric","Value"],...cells.map(r=>[r.section,r.metric,r.value])].map(row=>'<Row>'+row.map(v=>'<Cell><Data ss:Type="'+(typeof v==="number"?"Number":"String")+'">'+String(v).replaceAll("&","&amp;").replaceAll("<","&lt;")+'</Data></Cell>').join("")+'</Row>').join("")+
    '</Table></Worksheet></Workbook>';
   download(xml,"application/xml",report!.id+"-excel.xml");
 }
 return <section className="panel mb-6 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-slate-900">SQL &amp; reporting workspace</h2><p className="text-sm text-slate-500">Read-only SQL queries · immutable reports · ingestion audit</p></div><div className="flex gap-2">{(["reports","sql","history"] as const).map(t=><button key={t} onClick={()=>setTab(t)} className={`rounded-lg px-3 py-2 text-sm ${tab===t?"bg-blue-600 text-white":"bg-slate-100 text-slate-700"}`}>{t==="sql"?"SQL Explorer":t==="history"?"Ingestion history":"Reports"}</button>)}</div></div>
 {error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
 {tab==="reports"&&<div className="mt-4 space-y-3"><button disabled={busy} onClick={()=>void generate()} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">SAVE REPORT SNAPSHOT</button>{report&&<><p className="text-sm">Report <strong>{report.id}</strong> · {new Date(report.createdAt).toLocaleString()} · {report.period.from} to {report.period.to}</p><p className="break-all text-xs text-slate-500">SHA-256: {report.contentSha256} · Source ingestion runs: {report.ingestionRunIds.join(", ")||"None"}</p><div className="flex flex-wrap gap-2"><button onClick={()=>download(csv(exportRows()??[]),"text/csv",report.id+".csv")} className="rounded-lg border px-3 py-2 text-sm">Download CSV</button><button onClick={exportExcel} className="rounded-lg border px-3 py-2 text-sm">Excel-compatible XML</button><button onClick={()=>window.print()} className="rounded-lg border px-3 py-2 text-sm">Print / Save PDF</button></div></>}</div>}
 {tab==="sql"&&<div className="mt-4 space-y-3"><div className="flex gap-2"><select value={selected} onChange={e=>{setSelected(e.target.value);setRows([]);}} className="rounded-lg border px-3 py-2 text-sm">{queries.map(q=><option key={q.id} value={q.id}>{q.name}</option>)}</select><button onClick={()=>void runQuery()} disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">RUN QUERY</button>{rows.length>0&&<button onClick={()=>download(csv(rows),"text/csv","branch360-query.csv")} className="rounded-lg border px-3 py-2 text-sm">Export results</button>}</div><p className="text-xs text-slate-500">{queries.find(q=>q.id===selected)?.description}</p><pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-5 text-emerald-300">{queries.find(q=>q.id===selected)?.sql??"Loading queries..."}</pre>{rows.length>0&&<div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{Object.keys(rows[0]).map(k=><th className="border-b p-2" key={k}>{k}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{Object.values(r).map((v,j)=><td key={j} className="border-b p-2">{String(v??"—")}</td>)}</tr>)}</tbody></table></div>}</div>}
 {tab==="history"&&<div className="mt-4 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{["Run","Source","Status","Received","Accepted","Rejected","Started"].map(x=><th key={x} className="border-b p-2">{x}</th>)}</tr></thead><tbody>{history.map(r=><tr key={r.id}>{[r.id,r.source,r.status,r.recordsReceived,r.recordsAccepted,r.recordsRejected,new Date(r.startedAt).toLocaleString()].map((v,i)=><td key={i} className="border-b p-2">{v}</td>)}</tr>)}</tbody></table></div>}
 </section>;
}
