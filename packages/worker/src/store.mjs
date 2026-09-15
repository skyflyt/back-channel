import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
export function safeDirectory(directory) {
    const absolute = path.resolve(directory);
    for (let p = absolute;; p = path.dirname(p)) {
        if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink())
            throw Error('Worker state cannot traverse links or junctions');
        if (path.dirname(p) === p)
            break;
    }
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    const real = fs.realpathSync(absolute);
    for (let p = real;; p = path.dirname(p)) {
        if (fs.existsSync(path.join(p, '.git')) || fs.existsSync(path.join(p, 'Loby', 'core', 'HARNESS.md')))
            throw Error('Worker secrets/state must be outside repositories and vaults');
        if (path.dirname(p) === p)
            break;
    }
    if (process.platform === 'win32') {
        const script = "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($env:BC_PROTECT_DIRECTORY,$acl)";
        const acl = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, BC_PROTECT_DIRECTORY: real } });
        if (acl.status !== 0)
            throw Error('Cannot protect worker state ACL: ' + (acl.stderr || acl.error?.message || 'unknown error'));
    }
    else
        fs.chmodSync(real, 0o700);
    return real;
}
export class Store {
    constructor(directory) { this.directory = safeDirectory(directory); }
    file(name) { if (!/^[a-zA-Z0-9-]+$/.test(name))
        throw Error('Invalid state file name'); const file = path.join(this.directory, name + '.json'); this.checkFile(file); return file; }
    checkFile(file) { try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || stat.nlink > 1 || !stat.isFile())
            throw Error('State files must be ordinary private files');
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    } }
    read(name, fallback = {}) { try {
        return JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return fallback;
        throw e;
    } }
    write(name, value) { const destination = this.file(name), temp = destination + '.tmp'; this.checkFile(temp); const fd = fs.openSync(temp, 'w', 0o600); try {
        fs.writeFileSync(fd, JSON.stringify(value, null, 2));
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    } for (let attempt = 0;; attempt++) {
        try {
            fs.renameSync(temp, destination);
            break;
        }
        catch (e) {
            if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 4)
                throw e;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    } }
    lock() { const file = path.join(this.directory, 'worker.lock'); try {
        this.lockFd = fs.openSync(file, 'wx', 0o600);
        fs.writeFileSync(this.lockFd, String(process.pid));
        fs.fsyncSync(this.lockFd);
    }
    catch (e) {
        if (e.code === 'EEXIST')
            throw Error('State is locked; confirm previous worker and children are stopped, then run recover');
        throw e;
    } return () => { fs.closeSync(this.lockFd); fs.unlinkSync(file); }; }
}
