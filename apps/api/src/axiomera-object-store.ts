import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

// Provider-agnostic contract: a production implementation must use immutable managed storage,
// per-tenant IAM and a separately certified key-management/retention policy.
export interface ImmutableObjectStore {
  putImmutable(key:string,bytes:Buffer):Promise<void>;
  read(key:string):Promise<Buffer>;
}
const keyPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-f0-9]{64}\.bin$/i;
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
export function makeObjectKey(tenant:string,job:string,bytes:Buffer){
  const d=digest(bytes);
  const key=tenant+"."+job+"."+d+".bin";
  if(!keyPattern.test(key))throw new Error("invalid object identity");
  return key.toLowerCase();
}
function validate(key:string){
 if(!keyPattern.test(key)||key!==key.toLowerCase())throw new Error("invalid immutable object key");
 return key.split(".")[2];
}
export class LocalImmutableObjectStore implements ImmutableObjectStore {
  constructor(private readonly root:string){}
  private async ensureRoot(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    const stat=await lstat(this.root);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("unsafe object root");
    return realpath(this.root);
  }
  async putImmutable(key:string,bytes:Buffer):Promise<void>{
    const expected=validate(key);
    if(bytes.length>1_048_576||digest(bytes)!==expected)throw new Error("invalid content-addressed bytes");
    const dir=await this.ensureRoot(),filename=join(dir,key);
    let handle;
    try {
      handle=await open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    }catch(e){
      if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
      const prior=await this.read(key);
      if(!prior.equals(bytes))throw new Error("immutable object conflict");
    }finally{await handle?.close();}
  }
  async read(key:string):Promise<Buffer>{
    const expected=validate(key);
    const root=await this.ensureRoot();
    const handle=await open(join(root,key),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const st=await handle.stat();
      if(!st.isFile()||st.size>1_048_576)throw new Error("invalid stored object");
      const data=await handle.readFile();
      if(digest(data)!==expected)throw new Error("stored object digest mismatch");
      return data;
    }finally{await handle.close();}
  }
}
