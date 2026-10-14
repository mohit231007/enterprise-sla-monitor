// Minimal native OOXML .xlsx writer, using ZIP stored entries and UTF-8 shared inline strings.
// No third-party code or network dependency. Excel, LibreOffice, and Numbers can open the result.
export type Cell = string | number | boolean | null | undefined;
export type Sheet = {name:string;rows:Cell[][]};
const encoder=new TextEncoder();
const bytes=(s:string)=>encoder.encode(s);
const esc=(s:string)=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
function colName(index:number){let x=index+1,result="";while(x){x--;result=String.fromCharCode(65+x%26)+result;x=Math.floor(x/26);}return result;}
function sheetXml(rows:Cell[][]){
 const lines=rows.map((row,ri)=>'<row r="'+(ri+1)+'">'+row.map((v,ci)=>{
  if(v===null||v===undefined)return "";
  const ref=colName(ci)+(ri+1);
  if(typeof v==="number"&&Number.isFinite(v))return '<c r="'+ref+'"><v>'+v+'</v></c>';
  if(typeof v==="boolean")return '<c r="'+ref+'" t="b"><v>'+(v?1:0)+'</v></c>';
  return '<c r="'+ref+'" t="inlineStr"><is><t xml:space="preserve">'+esc(String(v))+'</t></is></c>';
 }).join("")+'</row>').join("");
 return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
 '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+lines+'</sheetData></worksheet>';
}
function crc32(data:Uint8Array){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function pack(files:{name:string;data:Uint8Array}[]){
 const parts:Uint8Array[]=[],central:Uint8Array[]=[];let offset=0;
 const u16=(d:DataView,o:number,x:number)=>d.setUint16(o,x,true);
 const u32=(d:DataView,o:number,x:number)=>d.setUint32(o,x,true);
 for(const file of files){
  const name=bytes(file.name),data=file.data,crc=crc32(data);
  const local=new Uint8Array(30+name.length),lv=new DataView(local.buffer);
  u32(lv,0,0x04034b50);u16(lv,4,20);u16(lv,6,0x0800);
  u32(lv,14,crc);u32(lv,18,data.length);u32(lv,22,data.length);u16(lv,26,name.length);
  local.set(name,30);parts.push(local,data);
  const entry=new Uint8Array(46+name.length),ev=new DataView(entry.buffer);
  u32(ev,0,0x02014b50);u16(ev,4,20);u16(ev,6,20);u16(ev,8,0x0800);
  u32(ev,16,crc);u32(ev,20,data.length);u32(ev,24,data.length);u16(ev,28,name.length);u32(ev,42,offset);
  entry.set(name,46);central.push(entry);offset+=local.length+data.length;
 }
 const cdSize=central.reduce((n,x)=>n+x.length,0);
 const end=new Uint8Array(22),view=new DataView(end.buffer);
 u32(view,0,0x06054b50);u16(view,8,files.length);u16(view,10,files.length);
 u32(view,12,cdSize);u32(view,16,offset);
 const complete=[...parts,...central,end],size=complete.reduce((n,x)=>n+x.length,0),out=new Uint8Array(size);
 let at=0;for(const block of complete){out.set(block,at);at+=block.length;}return out;
}
export function generateXlsx(sheets:Sheet[]):Uint8Array{
 if(!sheets.length)throw Error("At least one worksheet is required");
 const list=sheets.map((sheet,i)=>({name:(sheet.name.replace(/[\\/*?:\[\]]/g," ").slice(0,31)||"Sheet "+(i+1)),rows:sheet.rows}));
 const workbook='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
 '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+
 list.map((s,i)=>'<sheet name="'+esc(s.name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join("")+'</sheets></workbook>';
 const rels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
 list.map((_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join("")+'</Relationships>';
 const types='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
 '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+
 '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+
 list.map((_,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("")+'</Types>';
 const rootRels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
 return pack([
 {name:"[Content_Types].xml",data:bytes(types)},
 {name:"_rels/.rels",data:bytes(rootRels)},
 {name:"xl/workbook.xml",data:bytes(workbook)},
 {name:"xl/_rels/workbook.xml.rels",data:bytes(rels)},
 ...list.map((s,i)=>({name:"xl/worksheets/sheet"+(i+1)+".xml",data:bytes(sheetXml(s.rows))}))
 ]);
}
