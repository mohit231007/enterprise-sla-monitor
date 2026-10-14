"use client";
import { useState } from "react";
import { FileUp, ShieldCheck, AlertCircle, FileSpreadsheet } from "lucide-react";
import { uploadCsv } from "@/lib/api";

type Dataset = "performance" | "tickets";
const templates: Record<Dataset,string[]> = {
 performance:["branch_name","date","revenue","revenue_target","accounts_opened","loans_processed"],
 tickets:["external_ticket_id","branch_name","type","status","created_at","resolved_at","sla_breached"]
};
function parseCsv(input:string):string[][] {
  const output:string[][]=[];let row:string[]=[], cell="", quoted=false;
  const text=input.replace(/^\uFEFF/,"");
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}
    else if(c==='"'){if(cell)throw Error("Unexpected quote in unquoted cell");quoted=true;}
    else if(c===","){row.push(cell);cell="";}
    else if(c==="\n"||c==="\r"){if(c==="\r"&&text[i+1]==="\n")i++;row.push(cell);if(row.some(x=>x.trim()))output.push(row);row=[];cell="";}
    else cell+=c;
  }
  if(quoted)throw Error("Unclosed quoted value");
  if(cell||row.length){row.push(cell);output.push(row);}
  return output;
}
export function CsvUploadPanel({onUploaded}:{onUploaded:(range:{dateFrom:string,dateTo:string})=>void}){
 const [dataset,setDataset]=useState<Dataset>("performance");
 const [token,setToken]=useState("");
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");
 const [error,setError]=useState(false);
 const [file,setFile]=useState<File|null>(null);
 const downloadTemplate=()=>{
   const example=dataset==="performance"?"Connaught Place,2026-10-14,950000,900000,35,14":"TKT-001,Connaught Place,Complaint,Open,2026-10-14T09:00:00Z,,false";
   const blob=new Blob([templates[dataset].join(",")+"\n"+example+"\n"],{type:"text/csv"});
   const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=dataset+"-template.csv";a.click();URL.revokeObjectURL(url);
 };
 const submit=async()=>{
  if(!file||!token){setError(true);setMessage("Choose a CSV file and enter your banker upload key.");return;}
  setBusy(true);setMessage("");
  try{
   if(file.size>512_000)throw Error("Maximum CSV size is 500 KB.");
   const matrix=parseCsv(await file.text());
   if(matrix.length<2)throw Error("CSV needs a header and at least one record.");
   const columns=matrix[0].map(c=>c.trim());
   if(new Set(columns).size!==columns.length||columns.length!==templates[dataset].length||templates[dataset].some(c=>!columns.includes(c)))
    throw Error("Columns must match: "+templates[dataset].join(", "));
   if(matrix.length>1001)throw Error("Maximum 1,000 records per upload.");
   const rows=matrix.slice(1).map((values,index)=>{
     if(values.length!==columns.length)throw Error("Row "+(index+2)+" has the wrong number of columns.");
     return Object.fromEntries(columns.map((c,i)=>[c,values[i].trim()]));
   });
   const result=await uploadCsv({dataset,filename:file.name,columns,rows},token);
   setError(false);setMessage(result.accepted+" records committed and audited (run #"+result.runId+"). Select GENERATE REPORT to refresh.");
   setFile(null);onUploaded({dateFrom:result.dateFrom,dateTo:result.dateTo});
  }catch(e){setError(true);setMessage(e instanceof Error?e.message:"Upload failed");}
  finally{setBusy(false);}
 };
 return <section className="panel mb-6 p-5">
   <div className="mb-4 flex items-center gap-2"><FileUp size={20} className="text-blue-600"/><div><h2 className="font-semibold text-slate-900">Banker data upload</h2><p className="text-sm text-slate-500">Validate → persist to PostgreSQL → audit → generate report</p></div></div>
   <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
     <label className="text-xs font-semibold text-slate-600">Dataset<select aria-label="Dataset" value={dataset} onChange={e=>{setDataset(e.target.value as Dataset);setFile(null);setMessage("");}} className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm"><option value="performance">Daily performance</option><option value="tickets">Operational tickets</option></select></label>
     <label className="text-xs font-semibold text-slate-600">Banker upload key<input type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} placeholder="Server-issued upload key" className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"/></label>
     <label className="text-xs font-semibold text-slate-600">CSV file<input aria-label="Select CSV file" type="file" accept=".csv,text/csv" onChange={e=>setFile(e.target.files?.[0]??null)} className="mt-1 block w-full text-xs"/></label>
     <div className="flex flex-wrap items-end gap-2"><button onClick={downloadTemplate} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700"><FileSpreadsheet size={13} className="mr-1 inline"/>Template</button><button disabled={busy||!file||!token} onClick={()=>void submit()} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy?"Validating…":"VALIDATE & UPLOAD"}</button></div>
   </div>
   <p className="mt-3 text-xs text-slate-500"><ShieldCheck size={13} className="mr-1 inline"/>All rows must pass server validation; uploads are atomic, with an audit run. 1,000 rows / 500 KB maximum.</p>
   {message&&<p role="status" className={`mt-3 flex items-start gap-2 rounded-lg p-3 text-sm ${error?"bg-red-50 text-red-700":"bg-emerald-50 text-emerald-800"}`}>{error?<AlertCircle size={17}/>:<ShieldCheck size={17}/>}<span>{message}</span></p>}
 </section>;
}
