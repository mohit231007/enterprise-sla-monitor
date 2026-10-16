import { describe, expect, it } from "vitest";
import { makeObjectKey } from "./axiomera-object-store.js";
import { S3PolicyObjectStore, type S3Get, type S3Put, type S3Received, type S3Transport } from "./axiomera-s3-policy-store.js";
const A="11111111-1111-4111-8111-111111111111";
const J="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const p=()=>({
  bucket:"synthetic-axiomera-evidence",expectedAccountId:"123456789012",
  kmsKeyArn:"arn:aws:kms:ap-south-1:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  keyPrefix:"private/axiomera",
  retentionUntil:new Date(Date.now()+31*86_400_000)
});
class Fake implements S3Transport{
 readonly objects=new Map<string,{bytes:Buffer;kms:string}>();
 puts:S3Put[]=[];gets:S3Get[]=[];
 rejectWrite=false;wrongEncryption=false;
 async putObject(x:S3Put){
   this.puts.push(x);
   if(this.rejectWrite)throw Object.assign(new Error("AccessDenied"),{name:"AccessDenied",$metadata:{httpStatusCode:403}});
   if(x.IfNoneMatch!=="*"||x.ObjectLockMode!=="COMPLIANCE"||x.ServerSideEncryption!=="aws:kms")
     throw Error("policy bypass");
   const k=x.Bucket+"/"+x.Key;
   if(this.objects.has(k))throw Object.assign(new Error("Exists"),{name:"PreconditionFailed",$metadata:{httpStatusCode:412}});
   this.objects.set(k,{bytes:Buffer.from(x.Body),kms:x.SSEKMSKeyId});
 }
 async getObject(x:S3Get):Promise<S3Received>{
   this.gets.push(x);
   const row=this.objects.get(x.Bucket+"/"+x.Key);
   if(!row)throw Error("NoSuchKey");
   return {Body:Uint8Array.from(row.bytes),ServerSideEncryption:this.wrongEncryption?"AES256":"aws:kms",SSEKMSKeyId:row.kms};
 }
}
describe("S3 immutable-policy adapter (FAKE transport, no cloud claims)",()=>{
 it("uses conditional write, pinned owner/KMS, SHA256 and paired compliance retention",async()=>{
  const f=new Fake(),store=new S3PolicyObjectStore(f,p());
  const bytes=Buffer.from("synthetic report CSV");
  const key=makeObjectKey(A,J,bytes);
  await store.putImmutable(key,bytes);
  const req=f.puts[0];
  expect(req.IfNoneMatch).toBe("*");expect(req.ServerSideEncryption).toBe("aws:kms");
  expect(req.ExpectedBucketOwner).toBe("123456789012");
  expect(req.ChecksumSHA256).toBe((await import("node:crypto")).createHash("sha256").update(bytes).digest("base64"));
  expect(req.ObjectLockMode).toBe("COMPLIANCE");
  expect(req.ObjectLockRetainUntilDate.getTime()).toBeGreaterThan(Date.now()+86400000);
  expect(await store.read(key)).toEqual(bytes);
 });
 it("accepts exact repeated content but never overwrites an existing key",async()=>{
  const f=new Fake(),s=new S3PolicyObjectStore(f,p());
  const bytes=Buffer.from("once");
  const key=makeObjectKey(A,J,bytes);
  await s.putImmutable(key,bytes);
  await s.putImmutable(key,Buffer.from(bytes));
  expect(f.objects.size).toBe(1);
  f.objects.get(f.puts[0].Bucket+"/"+f.puts[0].Key)!.bytes=Buffer.from("evil");
  await expect(s.putImmutable(key,bytes)).rejects.toThrow();
 });
 it("does not swallow denied IAM/KMS errors as idempotent retries",async()=>{
  const f=new Fake();f.rejectWrite=true;
  const s=new S3PolicyObjectStore(f,p());const b=Buffer.from("deny");
  await expect(s.putImmutable(makeObjectKey(A,J,b),b)).rejects.toThrow("AccessDenied");
 });
 it("rejects bad keys and modified bytes before storage, wrong encryption after retrieval",async()=>{
  const f=new Fake(),s=new S3PolicyObjectStore(f,p()),bytes=Buffer.from("payload");
  const key=makeObjectKey(A,J,bytes);
  await expect(s.putImmutable("../../private",bytes)).rejects.toThrow();
  await expect(s.putImmutable(key,Buffer.from("changed"))).rejects.toThrow();
  await s.putImmutable(key,bytes);
  f.wrongEncryption=true;
  await expect(s.read(key)).rejects.toThrow("encryption");
 });
 it("fails closed if owner, KMS, retention or prefix is not explicitly accepted",()=>{
  const f=new Fake();
  expect(()=>new S3PolicyObjectStore(f,{...p(),expectedAccountId:""})).toThrow();
  expect(()=>new S3PolicyObjectStore(f,{...p(),kmsKeyArn:"alias/aws/s3"})).toThrow();
  expect(()=>new S3PolicyObjectStore(f,{...p(),keyPrefix:"../other"})).toThrow();
  expect(()=>new S3PolicyObjectStore(f,{...p(),retentionUntil:new Date(0)})).toThrow();
 });
});
