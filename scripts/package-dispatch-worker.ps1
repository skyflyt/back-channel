[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent $PSScriptRoot
$taskSource = Join-Path $taskRepo 'packages/worker'
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $taskOutput) { throw 'Use a new output directory so an existing package is never overwritten.' }
New-Item -ItemType Directory -Path (Join-Path $taskOutput 'worker') -Force | Out-Null
$taskEntries = @()
Get-ChildItem -LiteralPath $taskSource -Recurse -File | Where-Object {
    $_.FullName -notmatch '[\\/](node_modules|test|tests)[\\/]' -and $_.Extension -in @('.mjs', '.json', '.md')
} | ForEach-Object {
    if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cannot package links.' }
    $taskRelative = $_.FullName.Substring($taskSource.Length + 1).Replace('\', '/')
    if ($taskRelative -match '(?i)(secret|credential|config\.json|journal)') { throw "Unexpected state file in worker source: $taskRelative" }
    $taskTarget = Join-Path (Join-Path $taskOutput 'worker') $taskRelative
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $taskTarget
    $taskEntries += @{path=$taskRelative;sha256=(Get-FileHash -LiteralPath $taskTarget -Algorithm SHA256).Hash}
}
@{version=1;files=@($taskEntries | Sort-Object path)} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskOutput 'worker-manifest.json') -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-dispatch-worker.ps1') -Destination $taskOutput
Compress-Archive -Path (Join-Path $taskOutput '*') -DestinationPath ($taskOutput + '.zip')
Get-FileHash -LiteralPath ($taskOutput + '.zip') -Algorithm SHA256

