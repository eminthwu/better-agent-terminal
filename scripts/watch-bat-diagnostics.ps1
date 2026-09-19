<#
.SYNOPSIS
Watch an installed BAT from a separate Windows process, including across restarts.
.EXAMPLE
pwsh -NoProfile -File scripts/watch-bat-diagnostics.ps1 -Background
.DESCRIPTION
Samples every 5 seconds for 72 hours. Two consecutive unresponsive-window or
high-memory samples trigger a small thread-stack dump and recent log tails.
Keeps three snapshots, rotates the sample log, and never terminates BAT.
No installation, scheduled task, administrator access, or network access needed.
Create logs/diagnostics/stop to stop the monitor early. It also stops at logout.
#>
[CmdletBinding()]
param(
    [switch]$Background,
    [string]$DataDir,
    [ValidateRange(1, 60)][int]$IntervalSeconds = 5,
    [ValidateRange(0.001, 168)][double]$DurationHours = 72,
    [ValidateRange(64, 1048576)][int]$MemoryThresholdMiB = 2048,
    [int]$TargetProcessId = 0,
    [switch]$CaptureNow,
    [switch]$LoadOnly
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Windows only.' }
if ($CaptureNow -and $TargetProcessId -le 0) { throw 'CaptureNow requires TargetProcessId.' }
if (!$DataDir) {
    if ($env:BAT_TAURI_DATA_DIR) { $DataDir = $env:BAT_TAURI_DATA_DIR }
    elseif (Test-Path -LiteralPath (Join-Path $env:APPDATA 'BetterAgentTerminal')) {
        $DataDir = Join-Path $env:APPDATA 'BetterAgentTerminal'
    } else { $DataDir = Join-Path $env:APPDATA 'com.tonyq.better-agent-terminal' }
}
$DataDir = [IO.Path]::GetFullPath($DataDir)
$script:DiagnosticDir = Join-Path $DataDir 'logs\diagnostics'

if (!('BatDiagnostics.Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
namespace BatDiagnostics {
    public class WindowSample {
        public long Handle;
        public uint ThreadId;
        public bool Enabled;
        public bool Responsive;
    }
    public static class Native {
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
            public uint Size;
            public string Reserved, Desktop, Title;
            public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
            public ushort ShowWindow, ReservedSize;
            public IntPtr ReservedData, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
            public IntPtr Process, Thread;
            public uint ProcessId, ThreadId;
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(
            string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
            bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        delegate bool EnumProc(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
        [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeoutW(
            IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("dbghelp.dll", SetLastError=true)] static extern bool MiniDumpWriteDump(
            IntPtr process, uint processId, IntPtr file, uint type, IntPtr exception, IntPtr streams, IntPtr callback);

        public static int StartDetached(string executable, string arguments) {
            var startup = new StartupInfo { Size=(uint)Marshal.SizeOf(typeof(StartupInfo)), Flags=1, ShowWindow=0 };
            ProcessInfo info;
            // Break away from Codex/BAT's kill-on-close job, hide the window,
            // and use a separate process group. Start-Process alone inherits
            // the job and can die with the frozen app that we need to observe.
            if (!CreateProcessW(executable, new StringBuilder("\"" + executable + "\" " + arguments),
                IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000 | 0x200,
                IntPtr.Zero, null, ref startup, out info))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            try { return (int)info.ProcessId; }
            finally { CloseHandle(info.Thread); CloseHandle(info.Process); }
        }

        public static bool InJob(int processId) {
            IntPtr handle = OpenProcess(0x1000, false, (uint)processId);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                bool inJob;
                if (!IsProcessInJob(handle, IntPtr.Zero, out inJob)) throw new Win32Exception(Marshal.GetLastWin32Error());
                return inJob;
            } finally { CloseHandle(handle); }
        }

        public static WindowSample[] Windows(int processId) {
            var windows = new List<WindowSample>();
            EnumWindows(delegate(IntPtr window, IntPtr unused) {
                uint owner;
                uint thread = GetWindowThreadProcessId(window, out owner);
                if (owner == processId && IsWindowVisible(window)) {
                    UIntPtr result;
                    windows.Add(new WindowSample { Handle=window.ToInt64(), ThreadId=thread,
                        Enabled=IsWindowEnabled(window),
                        // WM_NULL, bounded even if the target UI thread is blocked.
                        Responsive=SendMessageTimeoutW(window, 0, UIntPtr.Zero, IntPtr.Zero, 0x22, 500, out result) != IntPtr.Zero });
                }
                return true;
            }, IntPtr.Zero);
            return windows.ToArray();
        }

        // Run externally, never inside BAT's potentially blocked UI/loader thread.
        // MiniDumpNormal + MiniDumpWithThreadInfo: stacks/state, no full heap.
        // https://learn.microsoft.com/windows/win32/api/minidumpapiset/nf-minidumpapiset-minidumpwritedump
        public static void Dump(int processId, long startTicks, string path) {
            IntPtr handle = OpenProcess(0x0400 | 0x0010, false, (uint)processId);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                using (var process = Process.GetProcessById(processId)) {
                    if (process.StartTime.ToUniversalTime().Ticks != startTicks || process.HasExited)
                        throw new InvalidOperationException("Process exited or PID was reused.");
                }
                using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
                    if (!MiniDumpWriteDump(handle, (uint)processId, file.SafeFileHandle.DangerousGetHandle(),
                        0x1000, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            } finally { CloseHandle(handle); }
        }
    }
}
'@
}

if ($Background) {
    $arguments = @('-NoProfile', '-NonInteractive', '-File', ('"{0}"' -f $PSCommandPath),
        '-DataDir', ('"{0}"' -f $DataDir), '-IntervalSeconds', $IntervalSeconds,
        '-DurationHours', $DurationHours.ToString([Globalization.CultureInfo]::InvariantCulture),
        '-MemoryThresholdMiB', $MemoryThresholdMiB, '-TargetProcessId', $TargetProcessId)
    if ($CaptureNow) { $arguments += '-CaptureNow' }
    $watcherPid = [BatDiagnostics.Native]::StartDetached((Get-Process -Id $PID).Path, ($arguments -join ' '))
    [pscustomobject]@{ WatcherPid=$watcherPid; InJob=[BatDiagnostics.Native]::InJob($watcherPid);
        Directory=$script:DiagnosticDir; DurationHours=$DurationHours }
    return
}

function Write-DiagnosticEvent($Value) {
    $path = Join-Path $script:DiagnosticDir 'watcher.jsonl'
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -ge 2MB) {
        Move-Item -LiteralPath $path -Destination (Join-Path $script:DiagnosticDir 'watcher.prev.jsonl') -Force
    }
    $Value['time'] = [DateTime]::UtcNow.ToString('o')
    [IO.File]::AppendAllText($path, (($Value | ConvertTo-Json -Depth 6 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
}

function Get-CaptureReason($State, [long]$MemoryBytes, [bool]$Unresponsive, [DateTime]$Now) {
    if ($MemoryBytes -ge ([long]$MemoryThresholdMiB * 1MB)) { $State.HighMemory++ } else { $State.HighMemory = 0 }
    if ($Unresponsive) { $State.Hung++ } else { $State.Hung = 0 }
    if ($State.Captures -ge 3 -or $Now -lt $State.NextCapture) { return $null }
    if ($State.Hung -ge 2) { return 'window-unresponsive' }
    if ($State.HighMemory -ge 2) { return 'high-memory' }
    return $null
}

function Copy-LogTail([string]$Source, [string]$Destination) {
    if (!(Test-Path -LiteralPath $Source)) { return }
    $inputFile = [IO.File]::Open($Source, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $size = [int][Math]::Min(65536, $inputFile.Length)
        [void]$inputFile.Seek(-$size, [IO.SeekOrigin]::End)
        $buffer = [byte[]]::new($size)
        $read = $inputFile.Read($buffer, 0, $size)
        [IO.File]::WriteAllText($Destination, [Text.Encoding]::UTF8.GetString($buffer, 0, $read))
    } finally { $inputFile.Dispose() }
}

function Limit-Snapshots {
    # Only exact monitor-owned files inside this directory; never recursive.
    $snapshots = @(Get-ChildItem -LiteralPath $script:DiagnosticDir -Filter 'bat-*.json' -File |
        Where-Object { $_.BaseName -match '^bat-\d{8}T\d{9}Z-\d+$' } | Sort-Object Name -Descending)
    foreach ($old in ($snapshots | Select-Object -Skip 3)) {
        foreach ($suffix in @('.json', '.dmp', '.debug.log', '.sidecar.log')) {
            $candidate = [IO.Path]::GetFullPath((Join-Path $script:DiagnosticDir ($old.BaseName + $suffix)))
            if ([IO.Path]::GetDirectoryName($candidate) -ne $script:DiagnosticDir) { throw 'Invalid snapshot path.' }
            if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Force }
        }
    }
}

function Save-Snapshot($Process, $Sample, [string]$Reason) {
    $prefix = Join-Path $script:DiagnosticDir ('bat-{0}-{1}' -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'), $Process.Id)
    $Sample['reason'] = $Reason
    $Sample['version'] = $Process.MainModule.FileVersionInfo.FileVersion
    $Sample['threads'] = @($Process.Threads | ForEach-Object {
        $thread = $_
        $info = @{ id=$thread.Id; state=$thread.ThreadState.ToString() }
        try {
            $info['cpuMs'] = $thread.TotalProcessorTime.TotalMilliseconds
            if ($thread.ThreadState -eq 'Wait') { $info['waitReason'] = $thread.WaitReason.ToString() }
        } catch { $info['error'] = $_.Exception.Message }
        $info
    })
    $Sample | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath ($prefix + '.json') -Encoding UTF8
    Write-DiagnosticEvent @{ type='snapshot-start'; processId=$Process.Id; reason=$Reason; file=($prefix + '.json') }
    foreach ($name in @('debug', 'sidecar')) {
        try { Copy-LogTail (Join-Path $DataDir "logs\$name.log") ($prefix + ".$name.log") }
        catch { Write-DiagnosticEvent @{ type='log-copy-error'; message=$_.Exception.Message } }
    }
    Limit-Snapshots
    try {
        [BatDiagnostics.Native]::Dump($Process.Id, $Process.StartTime.ToUniversalTime().Ticks, ($prefix + '.dmp'))
        Write-DiagnosticEvent @{ type='snapshot-complete'; processId=$Process.Id; file=($prefix + '.dmp'); bytes=(Get-Item -LiteralPath ($prefix + '.dmp')).Length }
    } catch { Write-DiagnosticEvent @{ type='snapshot-error'; processId=$Process.Id; message=$_.Exception.Message } }
}

if ($LoadOnly) { return }
[void][IO.Directory]::CreateDirectory($script:DiagnosticDir)
# The file share lock releases even if this monitor is terminated. A second
# launcher cannot accidentally double the dump/log workload.
$lock = [IO.File]::Open((Join-Path $script:DiagnosticDir 'watcher.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $stopFile = Join-Path $script:DiagnosticDir 'stop'
    if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile }
    $states = @{}
    $deadline = [DateTime]::UtcNow.AddHours($DurationHours)
    Write-DiagnosticEvent @{ type='watcher-start'; watcherPid=$PID; until=$deadline.ToString('o'); memoryThresholdMiB=$MemoryThresholdMiB }
    while ([DateTime]::UtcNow -lt $deadline -and !(Test-Path -LiteralPath $stopFile)) {
        $processes = if ($TargetProcessId -gt 0) {
            @(Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)
        } else { @(Get-Process -Name BetterAgentTerminal -ErrorAction SilentlyContinue) }
        $live = @{}
        foreach ($process in $processes) {
            try {
                $start = $process.StartTime.ToUniversalTime()
                $key = '{0}-{1}' -f $process.Id, $start.Ticks
                $live[$key] = $true
                if (!$states.ContainsKey($key)) {
                    $states[$key] = @{ HighMemory=0; Hung=0; Captures=0; NextCapture=[DateTime]::MinValue }
                }
                $windows = @([BatDiagnostics.Native]::Windows($process.Id))
                $sample = @{ type='sample'; processId=$process.Id; started=$start.ToString('o');
                    workingSetBytes=$process.WorkingSet64; privateBytes=$process.PrivateMemorySize64;
                    cpuMs=$process.TotalProcessorTime.TotalMilliseconds; handles=$process.HandleCount;
                    threadCount=$process.Threads.Count; windows=$windows }
                Write-DiagnosticEvent $sample
                $unresponsive = @($windows | Where-Object { !$_.Responsive }).Count -gt 0
                $reason = Get-CaptureReason $states[$key] ([Math]::Max($process.WorkingSet64, $process.PrivateMemorySize64)) $unresponsive ([DateTime]::UtcNow)
                if ($CaptureNow) { $reason = 'manual-capture' }
                if ($reason) {
                    $states[$key].Captures++
                    $states[$key].NextCapture = [DateTime]::UtcNow.AddMinutes(5)
                    Save-Snapshot $process $sample $reason
                }
            } catch { Write-DiagnosticEvent @{ type='sample-error'; processId=$process.Id; message=$_.Exception.Message } }
            finally { $process.Dispose() }
        }
        foreach ($key in @($states.Keys)) {
            if (!$live.ContainsKey($key)) { Write-DiagnosticEvent @{ type='process-ended'; identity=$key }; $states.Remove($key) }
        }
        if ($CaptureNow) { break }
        Start-Sleep -Seconds $IntervalSeconds
    }
    Write-DiagnosticEvent @{ type='watcher-stop'; watcherPid=$PID }
} finally { $lock.Dispose() }
