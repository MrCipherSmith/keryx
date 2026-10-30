import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BackgroundProcessHandle, JobRegistry } from '../harness/tool/builtin/background-job-registry';
import { safeShadowArguments, assertNativeShadowPath, type GitResult, type ShadowGitRequest } from '../rewind/shadow';

export interface NativeOwnedGitOptions {
  cwd: string;
  sessionDir: string;
  jobs: JobRegistry;
  assertOwnership(): void;
  /** Current run/inspection authority, not a cached start grant. */
  authorize(request: ShadowGitRequest): Promise<void>;
  /** Locally constructed fixed argv/stdin process under the native profile sandbox. */
  spawn(request: ShadowGitRequest): BackgroundProcessHandle | Promise<BackgroundProcessHandle>;
}
/** Private Git output is captured before the registry subscriber. Public tasks expose only a static label. */
export function createNativeOwnedGit(options: NativeOwnedGitOptions) {
  /** This module starts the private checkpoint tasks, so it alone addresses them by id. */
  const own={includePrivate:true};
  const cwd=realpathSync(options.cwd),sessionDir=realpathSync(options.sessionDir),gitDir=join(sessionDir,'rewind','shadow.git');
  const validate=(request:ShadowGitRequest)=>{
    options.assertOwnership();request.signal.throwIfAborted();
    if(resolve(request.repo.gitDir)!==gitDir||realpathSync(request.repo.workTree)!==cwd||!safeShadowArguments(request.args)
      ||request.readOnly!==(request.args[0]==='ls-tree'||request.args[0]==='cat-file'))throw new Error('native-shadow-request-denied');
    let current=sessionDir;
    for(const part of relative(sessionDir,gitDir).split('/')){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('native-shadow-request-denied');}
    if(request.args[0]==='cat-file'&&request.args[1]==='--batch'){
      if(request.stdin===undefined||Buffer.byteLength(request.stdin)>256*1024||!/^(?:[a-f0-9]{40}\n){1,5000}$/.test(request.stdin))throw new Error('native-shadow-input-denied');
    }else if(request.args[0]==='update-index'||request.args[0]==='checkout-index'){
      if(request.stdin===undefined||Buffer.byteLength(request.stdin)>1024*1024||!request.stdin.endsWith('\0'))throw new Error('native-shadow-input-denied');
      const paths=request.stdin.slice(0,-1).split('\0');if(paths.length>5000||new Set(paths).size!==paths.length)throw new Error('native-shadow-input-denied');
      for(const path of paths)assertNativeShadowPath(cwd,path);
    }else if(request.stdin!==undefined)throw new Error('native-shadow-input-denied');
  };
  return {async run(request:ShadowGitRequest):Promise<GitResult>{
    validate(request);await options.authorize(request);validate(request);
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(30000)]);let jobId:string|undefined;let handle:BackgroundProcessHandle|undefined;
    let stdout='',stderr='',bytes=0,overflow=false;
    const abort=()=>{if(jobId!==undefined)void options.jobs.kill(jobId,undefined,own).catch(()=>undefined);else handle?.kill('SIGTERM');};
    signal.addEventListener('abort',abort,{once:true});
    try{
      const begun=await options.jobs.start(request.readOnly?'Native checkpoint inspection':'Native checkpoint preparation',{
        phase:'foreground',visibility:'private',description:'Private native checkpoint operation',localSpawn:async()=>{
          signal.throwIfAborted();options.assertOwnership();handle=await options.spawn({...request,signal});
          handle.onOutput((chunk,stream)=>{if(overflow)return;bytes+=Buffer.byteLength(chunk);if(bytes>6*1024*1024){overflow=true;abort();return;}if(stream==='stdout')stdout+=chunk;else stderr+=chunk;});
          return {pid:handle.pid,onOutput(){/* Raw private blobs never enter public job buffers/events. */},onExit:callback=>handle!.onExit(callback),kill:stopSignal=>handle!.kill(stopSignal)};
        },
      });
      if(!begun.ok)throw new Error('native-shadow-start-failed');jobId=begun.jobId;if(signal.aborted)abort();
      const stopped=await options.jobs.waitForExit(jobId,31000);
      if(stopped!=='exited'){await options.jobs.kill(jobId,undefined,own);if(await options.jobs.waitForExit(jobId,3000)!=='exited')throw new Error('native-shadow-stop-unconfirmed');throw new Error('native-shadow-timeout');}
      if(overflow)throw new Error('native-shadow-output-quota');signal.throwIfAborted();options.assertOwnership();
      const task=options.jobs.get(jobId,own);if(task?.exitCode===undefined||task.status==='running'||task.status==='killed')throw new Error('native-shadow-stop-unconfirmed');
      return {code:task.exitCode,stdout,stderr};
    }finally{signal.removeEventListener('abort',abort);}
  }};
}
