[CmdletBinding()]
param(
    [string]$Name = "$env:COMPUTERNAME agent",
    [uri]$Broker = 'https://back-channel.app',
    [switch]$StartAtLogon,
    [switch]$CheckPrerequisitesOnly
)
$ErrorActionPreference = 'Stop'
function Assert-WorkerPathWithoutLinks([string]$Path) {
    $taskCheckedAncestor = [IO.Path]::GetFullPath($Path)
    while ($taskCheckedAncestor) {
        if (Test-Path -LiteralPath $taskCheckedAncestor) {
            if ((Get-Item -LiteralPath $taskCheckedAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Install/state/bundle paths must not contain links: $taskCheckedAncestor"
            }
        }
        $taskCheckedAncestor = Split-Path -Parent $taskCheckedAncestor
    }
}
if ($env:OS -ne 'Windows_NT') { throw 'This bootstrap is for Windows. Use the worker CLI on other platforms.' }
if ($Broker.Scheme -ne 'https' -or $Broker.UserInfo -or $Broker.Query -or $Broker.Fragment) { throw 'An HTTPS broker URL without credentials is required.' }
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskVersion = & $taskNode --version
if ($LASTEXITCODE -ne 0 -or $taskVersion -notmatch '^v(?<major>\d+)\.') { throw 'Could not read the installed Node.js version.' }
if ([int]$Matches.major -lt 22) { throw 'Install Node.js 22 or newer, then rerun this bootstrap.' }
$taskSource = Join-Path $PSScriptRoot 'worker'
Assert-WorkerPathWithoutLinks $taskSource
if (!(Test-Path -LiteralPath (Join-Path $taskSource 'bin/cli.mjs'))) { throw 'Extract the complete worker bundle before running this script.' }
$taskManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'worker-manifest.json') -Raw | ConvertFrom-Json
foreach ($taskEntry in $taskManifest.files) {
    if ($taskEntry.path -notmatch '^[a-zA-Z0-9_./-]+$' -or $taskEntry.path.Contains('..')) { throw 'Invalid bundle manifest path.' }
    $taskFile = Get-Item -LiteralPath (Join-Path $taskSource $taskEntry.path)
    Assert-WorkerPathWithoutLinks $taskFile.FullName
    if ($taskFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Bundle links are not allowed.' }
    if ((Get-FileHash -LiteralPath $taskFile.FullName -Algorithm SHA256).Hash -ne $taskEntry.sha256) { throw "Bundle integrity check failed: $($taskEntry.path)" }
}
$taskRoot = Join-Path $env:LOCALAPPDATA 'BackChannel'
$taskState = Join-Path $taskRoot 'worker'
$taskApplications = Join-Path $taskRoot 'worker-app'
$taskInstall = Join-Path $taskApplications ([guid]::NewGuid().ToString('N'))
$taskLauncher = Join-Path $taskRoot 'run-worker.ps1'
# Check the existing state and application descendants as well as their ancestors
# before copying files or exchanging a credential.
foreach ($taskCheckedPath in @($taskRoot, $taskState, (Join-Path $taskState 'config.json'), $taskApplications, $taskInstall, $taskLauncher)) {
    Assert-WorkerPathWithoutLinks $taskCheckedPath
}
if ($CheckPrerequisitesOnly) {
    Write-Host "Prerequisites passed: Node.js $taskVersion; bundle integrity and local paths verified."
    return
}
New-Item -ItemType Directory -Path $taskRoot -Force | Out-Null
$taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$taskAcl = New-Object Security.AccessControl.DirectorySecurity
$taskAcl.SetOwner($taskSid)
$taskAcl.SetAccessRuleProtection($true, $false)
foreach ($taskAllowedSid in @($taskSid, [Security.Principal.SecurityIdentifier]'S-1-5-18')) {
    $taskAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($taskAllowedSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
if ($PSVersionTable.PSEdition -eq 'Core') {
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($taskRoot), $taskAcl)
} else {
    [IO.Directory]::SetAccessControl($taskRoot, $taskAcl)
}
New-Item -ItemType Directory -Path $taskInstall -Force | Out-Null
foreach ($taskEntry in $taskManifest.files) {
    $taskDestination = Join-Path $taskInstall $taskEntry.path
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskDestination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskSource $taskEntry.path) -Destination $taskDestination
}
$taskCli = Join-Path $taskInstall 'bin/cli.mjs'
if (!(Test-Path -LiteralPath (Join-Path $taskState 'config.json'))) {
    Write-Host 'Create a connect code for this agent in the Back Channel dashboard. Enter it here, not in an agent chat.'
    $taskCode = Read-Host 'Connect code (BCX-...)' -AsSecureString
    $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskCode)
    try {
        $taskPlainCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)
        $taskExchange = Invoke-RestMethod -Uri ([uri]::new($Broker, '/api/auth/exchange')) -Method Post -ContentType 'application/json' -Body (@{code=$taskPlainCode} | ConvertTo-Json -Compress)
        if (!$taskExchange.api_key) { throw 'The broker did not return an agent credential.' }
        $env:BC_AGENT_TOKEN = $taskExchange.api_key
        & $taskNode $taskCli --state $taskState init --broker $Broker.AbsoluteUri.TrimEnd('/') --name $Name
        if ($LASTEXITCODE -ne 0) { throw 'Worker initialization failed.' }
    } finally {
        $env:BC_AGENT_TOKEN = $null
        $taskPlainCode = $null
        $taskExchange = $null
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)
    }
}
& $taskNode $taskCli --state $taskState enroll
if ($LASTEXITCODE -ne 0) { throw 'Enrollment failed. The worker has not been started.' }
# Single-quoted local literals: never interpolate peer content into a shell command.
$taskNodeLiteral = "'" + $taskNode.Replace("'", "''") + "'"
$taskCliLiteral = "'" + $taskCli.Replace("'", "''") + "'"
$taskStateLiteral = "'" + $taskState.Replace("'", "''") + "'"
@"
`$ErrorActionPreference = 'Stop'
`$worker = Start-Process -FilePath $taskNodeLiteral -ArgumentList @('"' + $taskCliLiteral + '"', '--state', '"' + $taskStateLiteral + '"', 'run') -WindowStyle Hidden -Wait -PassThru
exit `$worker.ExitCode
"@ | Set-Content -LiteralPath $taskLauncher -Encoding UTF8
if ($StartAtLogon) {
    $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -File "' + $taskLauncher + '"')
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $taskSid.Value
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskSid.Value -LogonType Interactive -RunLevel Limited
    $taskSettings = New-ScheduledTaskSettingsSet -Disable -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName 'BackChannel-Worker' -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
}
Write-Host "Installed at $taskInstall"
Write-Host "Local state: $taskState"
Write-Host 'Enrollment does not authorize execution. Pin the other agent and add a local project profile before sending a job.'
Write-Host "Worker CLI: & `"$taskNode`" `"$taskCli`" --state `"$taskState`""
Write-Host 'Complete setup with the CLI trust --file peer.json and profile --name NAME --file profile.json commands.'
if ($StartAtLogon) {
    Write-Host 'Registered BackChannel-Worker disabled; it has not started and will not start at logon yet.'
    Write-Host "After trust/profile setup: Enable-ScheduledTask -TaskName 'BackChannel-Worker'"
    Write-Host "Then start it: Start-ScheduledTask -TaskName 'BackChannel-Worker'"
} else {
    Write-Host "After trust/profile setup, start the worker with: powershell -NoProfile -File `"$taskLauncher`""
}
