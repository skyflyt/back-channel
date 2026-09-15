import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runtimeArgs} from '../src/runtime.mjs';
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'bc-codex-probe-'));
spawnSync('git',['init','--quiet'],{cwd});
const executable=process.argv[2];
const result=spawnSync(executable,runtimeArgs({adapter:'codex'}),{cwd,encoding:'utf8',input:'Return DISPATCH_ROUNDTRIP_OK. Do not use any tools. Return JSON matching the output schema: status completed, text DISPATCH_ROUNDTRIP_OK.',timeout:90000,windowsHide:true,maxBuffer:1048576});
fs.writeFileSync(path.join(cwd,'stdout.txt'),result.stdout??'',{mode:0o600});
fs.writeFileSync(path.join(cwd,'stderr.txt'),result.stderr??'',{mode:0o600});
console.log(JSON.stringify({cwd,status:result.status,error:result.error?.message,stdoutBytes:result.stdout?.length,stderrBytes:result.stderr?.length}));
for(const line of (result.stdout??'').split('\n').filter(Boolean)){
 try{const event=JSON.parse(line);console.log(JSON.stringify({type:event.type,itemType:event.item?.type,text:event.item?.type==='agent_message'?event.item.text:undefined,error:event.error?.message}));}
 catch{console.log('non-JSON stdout line');}
}
