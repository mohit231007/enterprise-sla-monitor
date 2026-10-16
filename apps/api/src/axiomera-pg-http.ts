import express from "express";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { approve, Conflict, Denied, freeze, ingest, readReleased, type Principal } from "./axiomera-pg-service.js";

/** Non-production, isolated HTTP adapter. Never mount into the legacy public server by default.
 * A bank IAM team must replace this pinned-key pilot with approved OIDC rotation/revocation.
 */
export type Trust = { issuer:string; audience:string; jwks:{keys:Array<Record<string,unknown>>} };
function parseSegment(encoded:string):Record<string,unknown>{
 if(!encoded||! /^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("bad base64url");
 const decoded=Buffer.from(encoded,"base64url");
 if(decoded.toString("base64url")!==encoded)throw new Error("noncanonical token encoding");
 const value=JSON.parse(decoded.toString("utf8"));
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("invalid claims");
 return value;
}
function authenticate(bearer:string|undefined,tenant:string,trust:Trust):Principal{
 if(!bearer?.startsWith("Bearer "))throw new Error("missing bearer");
 const parts=bearer.slice(7).split(".");
 if(parts.length!==3)throw new Error("invalid jwt framing");
 const header=parseSegment(parts[0]),claims=parseSegment(parts[1]);
 if(header.alg!=="RS256"||typeof header.kid!=="string")throw new Error("unsupported jwt algorithm");
 const jwk=trust.jwks.keys.find(x=>x.kid===header.kid&&x.kty==="RSA"&&x.use==="sig"&&
   (x.alg===undefined||x.alg==="RS256"));
 if(!jwk)throw new Error("untrusted jwt key");
 const pub=createPublicKey({key:jwk as any,format:"jwk"});
 const sig=Buffer.from(parts[2],"base64url");
 if(sig.toString("base64url")!==parts[2]||
    !verifySignature("RSA-SHA256",Buffer.from(parts[0]+"."+parts[1]),pub,sig))
    throw new Error("bad signature");
 const now=Math.floor(Date.now()/1000);
 if(claims.iss!==trust.issuer||
    !(claims.aud===trust.audience||(Array.isArray(claims.aud)&&claims.aud.includes(trust.audience)))||
    typeof claims.sub!=="string"||claims.sub.length===0||claims.sub.length>120||
    typeof claims.exp!=="number"||claims.exp<=now||
    typeof claims.nbf!=="number"||claims.nbf>now||
    typeof claims.iat!=="number"||claims.iat>now||
    claims.tenant_id!==tenant)throw new Error("invalid identity claims");
 return {subject:claims.sub,tenantId:tenant};
}
export function createPgPilotHttp(db:PrismaClient,trust:Trust){
 if(!trust.issuer||!trust.audience||!trust.jwks.keys.length)throw new Error("pinned trust material required");
 const app=express();
 app.disable("x-powered-by");
 app.use(express.json({limit:"128kb",strict:true}));
 app.get("/health/live",(_req,res)=>res.json({status:"alive",kind:"isolated-pg-reference"}));
 function handle(fn:(req:express.Request,p:Principal)=>Promise<unknown>,status=200){
  return async(req:express.Request,res:express.Response)=>{
    let principal:Principal;
    try{if(typeof req.params.tenant!=="string")throw new Error("invalid tenant");principal=authenticate(req.header("authorization"),req.params.tenant,trust);}
    catch{res.status(401).json({error:"invalid token or tenant claim"});return;}
    try{const result=await fn(req,principal);res.setHeader("Cache-Control","no-store");res.status(status).json(result);}
    catch(e){
      if(e instanceof Denied){res.status(404).json({error:"not found"});return;}
      if(e instanceof Conflict){res.status(409).json({error:"conflict"});return;}
      // Never return raw DB or signature error text to clients.
      res.status(500).json({error:"internal server error"});
    }
  };
 }
 app.post("/v1/tenants/:tenant/ingestions",handle(async(req,p)=>{
   if(!req.header("idempotency-key")||!req.body||!Array.isArray(req.body.rows)){
     throw new Denied("missing key or rows");
   }
   return ingest(db,p,req.body.dataset,req.body.rows,req.header("idempotency-key")!);
 },201));
 app.post("/v1/tenants/:tenant/reports",handle(async(req,p)=>{
   if(!req.body||typeof req.body.dataset!=="string")throw new Denied();
   return freeze(db,p,req.body.dataset);
 },201));
 app.post("/v1/tenants/:tenant/reports/:id/approve",handle(async(req,p)=>{if(typeof req.params.id!=="string")throw new Denied();return approve(db,p,req.params.id);}));
 app.get("/v1/tenants/:tenant/reports/:id",handle(async(req,p)=>{if(typeof req.params.id!=="string")throw new Denied();return readReleased(db,p,req.params.id);}));
 return app;
}