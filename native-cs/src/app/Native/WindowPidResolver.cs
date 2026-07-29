using System.Runtime.InteropServices;

namespace Sharkov.App.Native;

/// <summary>Resolves a window HWND to its owning process PID via user32!
/// <see cref="Win32.GetWindowThreadProcessId"/>. Ports <c>getWindowPid</c> in main.ts.</summary>
public static class WindowPidResolver
{
    /// <summary>Returns the PID for the given HWND, or 0 if not on Windows / HWND is zero /
    /// the Win32 call fails.</summary>
    public static uint GetWindowPid(IntPtr hwnd)
    {
        if (!OperatingSystem.IsWindows() || hwnd == IntPtr.Zero) return 0;
        try
        {
            Win32.GetWindowThreadProcessId(hwnd, out var pid);
            return pid;
        }
        catch
        {
            return 0;
        }
    }
}
