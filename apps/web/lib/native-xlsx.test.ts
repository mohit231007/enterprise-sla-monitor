import { describe, expect, it } from "vitest";
import { generateXlsx } from "./native-xlsx.js";
describe("native xlsx export",()=>{
 it("creates native zipped OOXML with four worksheets and correctly escaped cells",async()=>{
  const data=generateXlsx([
   {name:"Summary",rows:[["Report ID","BR360-TEST"],["Revenue",99824061]]},
   {name:"Branches",rows:[["Branch","Metric"],["Bandra & West",107.67]]},
   {name:"Interventions",rows:[["Priority"],["Critical"]]},
   {name:"Audit metadata",rows:[["Hash","a".repeat(64)]]}
  ]);
  expect(Array.from(data.slice(0,4))).toEqual([80,75,3,4]);
  // JSZip is not required: check the ZIP central-directory list via native byte decoding.
  const str=new TextDecoder().decode(data);
  expect(str).toContain("xl/workbook.xml");
  expect(str).toContain("xl/worksheets/sheet4.xml");
  expect(str).toContain("Bandra &amp; West");
  expect(str).toContain("99824061");
 });
});
