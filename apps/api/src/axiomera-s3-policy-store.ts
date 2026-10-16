import { createHash } from "node:crypto";
import type { ImmutableObjectStore } from "./axiomera-object-store.js";

// Transport shaped for AWS S3 PutObject/GetObject inputs. A production entrypoint
// must inject a *bank-approved, region-pinned* AWS SDK v3 client; no credentials
// or cloud resources are configured here.
export type S3Put = {
  Bucket:string; Key:string; Body:Buffer; ExpectedBucketOwner:string;
  IfNoneMatch:"*"; ChecksumSHA256:string;
  ServerSideEncryption:"aws:kms"; SSEKMSKeyId:string;
  ObjectLockMode:"COMPLIANCE"; ObjectLockRetainUntilDate:Date;
};
export type S3Get = {Bucket:string;Key:string;ExpectedBucketOwner:string};
export type S3Received = {Body:Uint8Array;ServerSideEncryption:string;SSEKMSKeyId:string};
export interface S3Transport {
  putObject(command:S3Put):Promise<void>;
  getObject(command:S3Get):Promise<S3Received>;
}
export type S3Policy = {
  bucket:string;
  expectedAccountId:string;
  kmsKeyArn:string;
  keyPrefix:string;
  retentionUntil:Date;
};
const immutable=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.[a-f0-9]{64}\.bin$/;
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
function validatePolicy(policy:S3Policy){
  if(!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(policy.bucket)||
     !/^\d{12}$/.test(policy.expectedAccountId)||
     !/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/.test(policy.kmsKeyArn)||
     policy.kmsKeyArn.split(":")[4]!==policy.expectedAccountId||
     !/^[a-z0-9][a-z0-9/_-]{1,90}$/.test(policy.keyPrefix)||
     policy.keyPrefix.includes("//")||policy.keyPrefix.endsWith("/")||
     !(policy.retentionUntil instanceof Date)||!Number.isFinite(policy.retentionUntil.valueOf())||
     policy.retentionUntil.valueOf()<=Date.now()+86_400_000)
    throw new Error("unapproved/invalid S3 storage policy");
}
function safeKey(key:string):string{
  if(!immutable.test(key))throw new Error("invalid immutable object identity");
  return key.split(".")[2];
}
function alreadyExists(e:unknown):boolean{
 const x=e as {name?:string;$metadata?:{httpStatusCode?:number}};
 return x?.name==="PreconditionFailed"&&x.$metadata?.httpStatusCode===412;
}
export class S3PolicyObjectStore implements ImmutableObjectStore{
  private readonly policy:S3Policy;
  constructor(private readonly transport:S3Transport,policy:S3Policy){
    validatePolicy(policy);
    this.policy={...policy,retentionUntil:new Date(policy.retentionUntil)};
  }
  private address(key:string){
    safeKey(key);
    return this.policy.keyPrefix+"/"+key;
  }
  async putImmutable(key:string,bytes:Buffer):Promise<void>{
    const expected=safeKey(key);
    const source=Buffer.from(bytes);
    if(source.length>1_048_576||digest(source)!==expected)throw new Error("object content digest mismatch");
    try{
      await this.transport.putObject({
        Bucket:this.policy.bucket,Key:this.address(key),Body:source,
        ExpectedBucketOwner:this.policy.expectedAccountId,IfNoneMatch:"*",
        ChecksumSHA256:createHash("sha256").update(source).digest("base64"),
        ServerSideEncryption:"aws:kms",SSEKMSKeyId:this.policy.kmsKeyArn,
        ObjectLockMode:"COMPLIANCE",
        ObjectLockRetainUntilDate:new Date(this.policy.retentionUntil)
      });
    }catch(error){
      if(!alreadyExists(error))throw error; // never hide IAM/KMS/retention errors.
      const old=await this.read(key);
      if(!old.equals(source))throw new Error("immutable S3 object conflict");
    }
  }
  async read(key:string):Promise<Buffer>{
    const expected=safeKey(key);
    const remote=await this.transport.getObject({
      Bucket:this.policy.bucket,Key:this.address(key),
      ExpectedBucketOwner:this.policy.expectedAccountId
    });
    if(remote.ServerSideEncryption!=="aws:kms"||remote.SSEKMSKeyId!==this.policy.kmsKeyArn)
      throw new Error("unexpected object encryption identity");
    const bytes=Buffer.from(remote.Body);
    if(bytes.length>1_048_576||digest(bytes)!==expected)throw new Error("stored S3 object verification failed");
    return bytes;
  }
}