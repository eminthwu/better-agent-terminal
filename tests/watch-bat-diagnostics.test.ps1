# Run with pwsh -NoProfile -File tests/watch-bat-diagnostics.test.ps1
$ErrorActionPreference = 'Stop'
$watcher = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\watch-bat-diagnostics.ps1'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('bat-diagnostics-test-' + [Guid]::NewGuid().ToString('N'))))
[void][IO.Directory]::CreateDirectory($testRoot)
$worker = $null
function Assert-True($Condition, $Message) { if (!$Condition) { throw $Message } }
try {
    . $watcher -DataDir $testRoot -LoadOnly
    $state = @{ HighMemory=0; Hung=0; Captures=0; NextCapture=[DateTime]::MinValue }
    $now = [DateTime]::UtcNow
    Assert-True ($null -eq (Get-CaptureReason $state 100MB $false $now)) 'Healthy sample should not capture.'
    Assert-True ($null -eq (Get-CaptureReason $state 3GB $false $now)) 'One memory spike should not capture.'
    Assert-True ((Get-CaptureReason $state 3GB $false $now) -eq 'high-memory') 'Sustained high memory must capture.'
    [void](Get-CaptureReason $state 100MB $false $now)
    Assert-True ($state.HighMemory -eq 0) 'Recovery resets the consecutive count.'
    Assert-True ($null -eq (Get-CaptureReason $state 100MB $true $now)) 'One slow window sample should not capture.'
    Assert-True ((Get-CaptureReason $state 100MB $true $now) -eq 'window-unresponsive') 'Repeated unresponsive samples must capture.'
    $state.NextCapture = $now.AddMinutes(5)
    Assert-True ($null -eq (Get-CaptureReason $state 3GB $true $now)) 'Cooldown must prevent dump storms.'
    $state.NextCapture = [DateTime]::MinValue
    $state.Captures = 3
    Assert-True ($null -eq (Get-CaptureReason $state 3GB $true $now)) 'Per-process capture cap must be enforced.'

    [void][IO.Directory]::CreateDirectory($script:DiagnosticDir)
    foreach ($index in 1..4) {
        $name = 'bat-20260917T00000000{0}Z-123' -f $index
        foreach ($suffix in @('.json', '.dmp', '.debug.log', '.sidecar.log')) {
            [IO.File]::WriteAllText((Join-Path $script:DiagnosticDir ($name + $suffix)), 'fixture')
        }
    }
    [IO.File]::WriteAllText((Join-Path $script:DiagnosticDir 'keep.json'), 'unrelated')
    Limit-Snapshots
    Assert-True (@(Get-ChildItem -LiteralPath $script:DiagnosticDir -Filter '*.dmp').Count -eq 3) 'Only three snapshots should remain.'
    Assert-True (!(Test-Path -LiteralPath (Join-Path $script:DiagnosticDir 'bat-20260917T000000001Z-123.debug.log'))) 'All oldest snapshot companions should be removed.'
    Assert-True (Test-Path -LiteralPath (Join-Path $script:DiagnosticDir 'keep.json')) 'Retention must not touch unrelated files.'
    $largeLog = Join-Path $testRoot 'large.log'
    [IO.File]::WriteAllText($largeLog, ('x' * 100000) + 'END')
    $tail = Join-Path $testRoot 'tail.log'
    Copy-LogTail $largeLog $tail
    Assert-True ((Get-Item -LiteralPath $tail).Length -le 65536) 'Log tail must be bounded.'
    Assert-True ([IO.File]::ReadAllText($tail).EndsWith('END')) 'Log tail must include the newest bytes.'

    # Capture a disposable external process, not BAT or the test runner itself.
    $ready = Join-Path $testRoot 'ready'
    $workerCommand = "[IO.File]::WriteAllText('{0}', 'ready'); Start-Sleep -Seconds 90" -f $ready.Replace("'", "''")
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($workerCommand))
    $workerId = [BatDiagnostics.Native]::StartDetached((Get-Process -Id $PID).Path, ("-NoProfile -NonInteractive -EncodedCommand {0}" -f $encoded))
    $worker = Get-Process -Id $workerId
    Assert-True (![BatDiagnostics.Native]::InJob($worker.Id)) 'Background monitor must escape the parent kill-on-close job.'
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (!(Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $readyDeadline) { Start-Sleep -Milliseconds 50 }
    Assert-True (Test-Path -LiteralPath $ready) 'Test process should finish startup before capture.'
    $isolated = Join-Path $testRoot 'capture'
    & $watcher -DataDir $isolated -TargetProcessId $worker.Id -CaptureNow
    $captureDir = Join-Path $isolated 'logs\diagnostics'
    $dumps = @(Get-ChildItem -LiteralPath $captureDir -Filter '*.dmp')
    Assert-True ($dumps.Count -eq 1) 'CaptureNow should create one minidump.'
    $bytes = [IO.File]::ReadAllBytes($dumps[0].FullName)
    Assert-True ($bytes.Length -ge 4) ('Empty dump: ' + (Get-Content -LiteralPath (Join-Path $captureDir 'watcher.jsonl') -Raw))
    Assert-True ([Text.Encoding]::ASCII.GetString($bytes, 0, 4) -eq 'MDMP') 'Snapshot must have a valid minidump header.'
    Assert-True (($bytes.Length -gt 4096) -and ($bytes.Length -lt 64MB)) 'Stack dump should be useful and small.'
    $events = @(Get-Content -LiteralPath (Join-Path $captureDir 'watcher.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-True (@($events | Where-Object type -eq 'snapshot-complete').Count -eq 1) 'Successful capture must be logged.'
    Assert-True (@($events | Where-Object type -eq 'snapshot-error').Count -eq 0) 'Snapshot should complete without errors.'
    $snapshot = Get-ChildItem -LiteralPath $captureDir -Filter 'bat-*.json' | Get-Content -Raw | ConvertFrom-Json
    Assert-True (@($snapshot.threads).Count -gt 0) 'Snapshot should include thread states.'
    Assert-True (!$worker.HasExited) 'Capture must leave the monitored process running.'
    Write-Output ('PASS: detached process, policy, retention, bounded log tails, external minidump ({0} bytes), and target liveness.' -f $bytes.Length)
} finally {
    if ($worker) { if (!$worker.HasExited) { $worker.Kill(); $worker.WaitForExit() }; $worker.Dispose() }
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($testRoot) -ne $tempRoot -or [IO.Path]::GetFileName($testRoot) -notlike 'bat-diagnostics-test-*') { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
