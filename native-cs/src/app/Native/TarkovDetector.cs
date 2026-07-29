using System.Runtime.InteropServices;
using System.Text;

namespace Sharkov.App.Native;

/// <summary>Detects a running Escape from Tarkov window (Desktop or Arena) at app launch
/// so we can auto-select it as the screen-share source, mirroring the Electron app's
/// screen-picker auto-select (static/screen-picker.html:200 — "Auto-select
/// EscapeFromTarkov / EscapeFromTarkovArena if present"). The Electron picker matched
/// source names starting with "escapefromtarkov"; here we match visible top-level window
/// titles starting with "EscapeFromTarkov" via Win32 EnumWindows.
///
/// Why this exists: WebView2's ScreenCaptureStarting can't feed a chosen source back to
/// the page (unlike Electron's setDisplayMediaRequestHandler), so we can't pre-select in
/// a custom picker. The closest feasible behavior is the --auto-select-desktop-capture-source
/// Chromium flag, which bypasses the picker entirely and shares the named source. We set
/// it at WebView2 environment creation when a Tarkov window is found, so screen share
/// becomes one click with no picker (matching the old app's "default to Tarkov" feel).
///
/// Limitations (inherent to the platform, documented for honesty):
///  - Launch-time only: starting Tarkov AFTER Sharkov, or switching Desktop↔Arena
///    mid-session, isn't tracked (the flag is baked into the environment at startup).
///  - If both Desktop and Arena are running, the first match wins (no choosing).
///  - The Chromium "Stop sharing" indicator still shows during the share — WebView2
///    can't suppress it (only Electron's source-providing bypass could, and WebView2
///    has no equivalent).</summary>
public static class TarkovDetector
{
    private const string Prefix = "EscapeFromTarkov";

    /// <summary>Returns the window title of the first visible top-level window whose title
    /// starts with "EscapeFromTarkov" (matches both "EscapeFromTarkov" Desktop and
    /// "EscapeFromTarkovArena"), case-insensitive, or null if none is found / not on Windows.
    /// The returned title is the exact string to pass to --auto-select-desktop-capture-source
    /// (Chromium keys source names off window titles).</summary>
    public static string? FindTarkovWindowTitle()
    {
        if (!OperatingSystem.IsWindows()) return null;
        string? found = null;
        Win32.EnumWindows((hwnd, _) =>
        {
            try
            {
                if (!Win32.IsWindowVisible(hwnd)) return true;
                var len = Win32.GetWindowTextLengthW(hwnd);
                if (len <= 0) return true;
                var buf = new char[len + 1];
                var copied = Win32.GetWindowTextW(hwnd, buf, buf.Length);
                if (copied <= 0) return true;
                var title = new string(buf, 0, copied);
                if (title.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase))
                {
                    found = title;
                    return false; // stop enumerating — first match wins
                }
            }
            catch { /* ignore individual window failures, keep scanning */ }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
