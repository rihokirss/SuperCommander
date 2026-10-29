param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class FirstShowTest {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Placement { public uint length, flags, showCmd; public Point min, max; public Rect normal; }
    [StructLayout(LayoutKind.Sequential)] public struct Message { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public Point point; public uint privateValue; }
    public delegate void EventCallback(IntPtr hook, uint kind, IntPtr hwnd, int objectId, int childId, uint threadId, uint time);
    [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, EventCallback callback, uint processId, uint threadId, uint flags);
    [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hwnd, ref Placement placement);
    [DllImport("user32.dll")] public static extern bool PeekMessage(out Message message, IntPtr hwnd, uint min, uint max, uint flags);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    public static void Run(string executable, string data, string profile, bool maximized) {
        Process child = null;
        Placement first = new Placement();
        IntPtr firstWindow = IntPtr.Zero;
        EventCallback callback = (hook, kind, hwnd, objectId, childId, threadId, time) => {
            if (child == null || objectId != 0 || childId != 0 || GetAncestor(hwnd, 2) != hwnd) return;
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner != child.Id || firstWindow != IntPtr.Zero) return;
            first.length = (uint)Marshal.SizeOf(typeof(Placement));
            if (GetWindowPlacement(hwnd, ref first)) firstWindow = hwnd;
        };
        IntPtr hookHandle = SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, callback, 0, 0, 0);
        if (hookHandle == IntPtr.Zero) throw new Exception("Could not observe window show events");
        try {
            ProcessStartInfo start = new ProcessStartInfo(executable);
            start.UseShellExecute = false;
            start.WorkingDirectory = System.IO.Path.GetTempPath();
            start.EnvironmentVariables["SUPERCOMMANDER_DATA_DIR"] = data;
            start.EnvironmentVariables["WEBVIEW2_USER_DATA_FOLDER"] = profile;
            child = Process.Start(start);
            Stopwatch timer = Stopwatch.StartNew();
            while (firstWindow == IntPtr.Zero && timer.ElapsedMilliseconds < 30000 && !child.HasExited) {
                Message message;
                while (PeekMessage(out message, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref message); DispatchMessage(ref message); }
                Thread.Sleep(10);
            }
            if (firstWindow == IntPtr.Zero) throw new Exception("Application did not show a window");
            if (Math.Abs(first.normal.left - 64) > 2 || Math.Abs(first.normal.top - 50) > 2 || Math.Abs(first.normal.right - 1164) > 2 || Math.Abs(first.normal.bottom - 750) > 2 || first.showCmd != (maximized ? 3u : 1u))
                throw new Exception(String.Format("First visible placement was {0},{1},{2},{3}, show={4}", first.normal.left, first.normal.top, first.normal.right, first.normal.bottom, first.showCmd));
            PostMessage(firstWindow, 16, IntPtr.Zero, IntPtr.Zero);
            if (!child.WaitForExit(10000)) throw new Exception("Test window did not close");
        } finally {
            UnhookWinEvent(hookHandle);
            if (child != null && !child.HasExited) { child.Kill(); child.WaitForExit(); }
            GC.KeepAlive(callback);
        }
    }
}
'@
$root = Join-Path ([IO.Path]::GetTempPath()) ("SuperCommander-first-show-" + [Guid]::NewGuid())
$settings = Join-Path $root 'Settings'
$profile = Join-Path $root 'WebView'
New-Item -ItemType Directory -Path $settings -Force | Out-Null
try {
    foreach ($maximized in @($false, $true)) {
        $state = @{ left = 64; top = 50; right = 1164; bottom = 750; maximized = $maximized } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path $settings 'window-state.json'), $state, [Text.UTF8Encoding]::new($false))
        [FirstShowTest]::Run((Resolve-Path $Executable).ProviderPath, $settings, $profile, $maximized)
    }
    Write-Host 'PASS first visible placement is restored for normal and maximized windows'
} finally {
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
