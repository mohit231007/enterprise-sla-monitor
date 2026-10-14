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

it("deduplicates sheet titles and keeps hostile spreadsheet-like text inert", () => {
 const data=generateXlsx([
   {name:"A/B",rows:[["value","=HYPERLINK(\"https://example.invalid\",\"click\")"]]},
   {name:"A?B",rows:[["bad\u0001control","safe"]]},
   {name:"a b",rows:[["ignored","@SUM(1+1)"]]}
 ]);
 const xml=new TextDecoder().decode(data);
 expect(xml).toContain('name="A B"');
 expect(xml).toContain('name="A B (2)"');
 expect(xml).toContain('name="a b (3)"');
 expect(xml).toContain('t="inlineStr"');
 expect(xml).not.toContain('<f>');
 // Inspect XML elements, not arbitrary ZIP binary headers, which can contain 0x01.
 const worksheetXml=(xml.match(/<worksheet\b[\s\S]*?<\/worksheet>/g)??[]).join("");
 expect(worksheetXml).not.toContain("\u0001");
});
