import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv.includes('--grandchild')) {
    setInterval(() => {}, 1000);
} else {
let input = '';
for await (const chunk of process.stdin)
    input += chunk;
if (input.includes('TREE_FIXTURE') || input.includes('INHERITED_PIPE_FIXTURE')) {
    const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), '--grandchild'], {stdio: input.includes('INHERITED_PIPE_FIXTURE') ? 'inherit' : 'ignore'});
    fs.writeFileSync(path.join(process.cwd(), 'tree-pid'), String(descendant.pid));
    if (input.includes('INHERITED_PIPE_FIXTURE')) {
        console.log('fixture-result with inherited pipe');
        process.exit(0);
    } else setInterval(() => {}, 1000);
} else if (input.includes('HANG_FIXTURE'))
    setInterval(() => { }, 1000);
else
    console.log(JSON.stringify({ result: 'fixture-result', received: input.length }));
}
