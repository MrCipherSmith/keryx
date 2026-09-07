import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readContainedFile } from "/Users/Goodea/goodea/keryx/src/lib/contained-read";
const base = await mkdtemp(path.join(tmpdir(), "keryx-owner-race-"));
const root = path.join(base,"owner");
try {
 await mkdir(root); await writeFile(path.join(root,"data.txt"),"authorized-original");
 try {
  const bytes=await readContainedFile(root,path.join(root,"data.txt"),{hooks:{beforeOpen:async()=>{
   await rename(root,path.join(base,"original")); await mkdir(root); await writeFile(path.join(root,"data.txt"),"replacement-data");
  }}});
  console.log(JSON.stringify({refused:false, returnedReplacement:bytes.toString()==="replacement-data"}));
 } catch(error) { console.log(JSON.stringify({refused:true,code:(error as {code?:string}).code})); }
} finally { await rm(base,{recursive:true,force:true}); }
