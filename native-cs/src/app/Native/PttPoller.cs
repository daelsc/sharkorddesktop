using System.Runtime.InteropServices;

namespace Sharkov.App.Native;

/// <summary>Windows-only: PTT when the app is in the background by polling
/// <see cref="Win32.GetAsyncKeyState"/>. No global hooks — just periodic state reads,
/// less likely to trigger keylogger detection than SetWindowsHookEx-based packages.
/// Ports <c>src/pttBackgroundPoller.ts</c>.</summary>
public sealed class PttPoller : IDisposable
{
    private const int PollMs = 50;
    private const short KeyDownMask = unchecked((short)0x8000);

    private Timer? _timer;
    private bool _lastPressed;
    private readonly int _vk;
    private readonly Action<bool> _onState;

    private PttPoller(int vk, Action<bool> onState)
    {
        _vk = vk;
        _onState = onState;
    }

    // e.code → VK for the named (non-Key/non-Digit/non-Numpad/non-F/non-Mouse) keys.
    // Shared by PttBindingToVk (forward) and VkToPttBinding (reverse, used by the picker).
    private static readonly Dictionary<string, int> CodeToVk = new(StringComparer.Ordinal)
    {
        { "BracketLeft",  0xdb }, // VK_OEM_4 [
        { "BracketRight", 0xdd }, // VK_OEM_6 ]
        { "Backslash",    0xdc }, // VK_OEM_5 \
        { "Semicolon",    0xba }, // VK_OEM_1 ;
        { "Quote",        0xde }, // VK_OEM_7 '
        { "Comma",        0xbc }, // VK_OEM_COMMA ,
        { "Period",       0xbe }, // VK_OEM_PERIOD .
        { "Slash",        0xbf }, // VK_OEM_2 /
        { "Backquote",    0xc0 }, // VK_OEM_3 `
        { "Minus",        0xbd }, // VK_OEM_MINUS -
        { "Equal",        0xbb }, // VK_OEM_PLUS =
        { "Space",        0x20 },
        { "Enter",        0x0d },
        { "Tab",          0x09 },
        { "Escape",       0x1b },
        { "Backspace",    0x08 },
        { "ShiftLeft",    0xa0 },
        { "ShiftRight",   0xa1 },
        { "ControlLeft",  0xa2 },
        { "ControlRight", 0xa3 },
        { "AltLeft",      0xa4 },
        { "AltRight",     0xa5 },
        { "CapsLock",     0x14 },
        { "ArrowLeft",    0x25 },
        { "ArrowUp",      0x26 },
        { "ArrowRight",   0x27 },
        { "ArrowDown",    0x28 },
        { "Home",         0x24 },
        { "End",          0x23 },
        { "PageUp",       0x21 },
        { "PageDown",     0x22 },
        { "Insert",       0x2d },
        { "Delete",       0x2e }
    };

    // Reverse of CodeToVk, built once. VK → e.code for the picker (which captures a VK via
    // KeyInterop.VirtualKeyFromKey and needs the e.code string the injection compares against).
    private static readonly Dictionary<int, string> VkToCode = BuildVkToCode();
    private static Dictionary<int, string> BuildVkToCode()
    {
        var d = new Dictionary<int, string>();
        foreach (var kv in CodeToVk) d[kv.Value] = kv.Key;
        return d;
    }

    /// <summary>Map a virtual key code to the PTT binding string the injection expects
    /// (a KeyboardEvent.code, e.g. "KeyV", "BracketLeft", "F5", "Numpad3"). Returns null
    /// for keys we don't support as PTT bindings. Used by the WPF picker dialog.</summary>
    public static string? VkToPttBinding(int vk)
    {
        if (VkToCode.TryGetValue(vk, out var code)) return code;
        if (vk is >= 0x41 and <= 0x5A) return "Key" + ((char)vk).ToString();           // A-Z → KeyA-KeyZ
        if (vk is >= 0x30 and <= 0x39) return "Digit" + (vk - 0x30);     // 0-9 → Digit0-Digit9
        if (vk is >= 0x60 and <= 0x69) return "Numpad" + (vk - 0x60);    // numpad 0-9
        if (vk is >= 0x70 and <= 0x7B) return "F" + (vk - 0x70 + 1);    // F1-F12
        return null;
    }

    /// <summary>Format a PTT binding string for display, mirroring
    /// <c>formatPttBindingDisplay</c> in static/wrapper.js ("[", "V", "Numpad 3", "F5",
    /// "Mouse 4", "Left Shift"…). Returns "Not set" for null/empty.</summary>
    public static string FormatBinding(string? binding)
    {
        if (string.IsNullOrEmpty(binding)) return "Not set";
        var s = binding;
        if (s.StartsWith("Mouse", StringComparison.Ordinal))
        {
            if (int.TryParse(s.AsSpan(5), out var n)) return "Mouse " + n;
            return s;
        }
        if (s.StartsWith("Key", StringComparison.Ordinal) && s.Length == 4)
            return s[3..]; // KeyV → V
        var friendly = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["BracketLeft"]="[", ["BracketRight"]="]", ["Backslash"]="\\", ["Semicolon"]=";",
            ["Quote"]="'", ["Comma"]=",", ["Period"]=".", ["Slash"]="/", ["Backquote"]="`",
            ["Minus"]="-", ["Equal"]="=", ["Space"]="Space", ["Enter"]="Enter", ["Tab"]="Tab",
            ["Backspace"]="Backspace", ["ShiftLeft"]="Left Shift", ["ShiftRight"]="Right Shift",
            ["ControlLeft"]="Left Ctrl", ["ControlRight"]="Right Ctrl",
            ["AltLeft"]="Left Alt", ["AltRight"]="Right Alt", ["CapsLock"]="Caps Lock",
            ["ArrowLeft"]="←", ["ArrowUp"]="↑", ["ArrowRight"]="→", ["ArrowDown"]="↓",
            ["Home"]="Home", ["End"]="End", ["PageUp"]="Page Up", ["PageDown"]="Page Down",
            ["Insert"]="Insert", ["Delete"]="Delete", ["Escape"]="Esc"
        };
        if (friendly.TryGetValue(s, out var f)) return f;
        if (s.StartsWith("Digit", StringComparison.Ordinal) && s.Length == 6) return s[5..];
        if (s.StartsWith("Numpad", StringComparison.Ordinal)) return "Numpad " + s[6..];
        if (s.StartsWith('F') && s.Length is >= 2 and <= 3) return s;
        return s;
    }

    /// <summary>Map a PTT binding string (e.g. "KeyP", "Mouse4", "BracketLeft") to a
    /// Windows virtual key code. Returns null if unsupported. Ports
    /// <c>pttBindingToVk</c> exactly, including the DOM-button → VK mapping for mouse.</summary>
    public static int? PttBindingToVk(string? binding)
    {
        if (string.IsNullOrEmpty(binding)) return null;
        var s = binding.Trim();

        if (s.StartsWith("Mouse", StringComparison.Ordinal))
        {
            if (!int.TryParse(s.AsSpan("Mouse".Length), out var n)) return null;
            // Windows VK: LBUTTON=0x01, RBUTTON=0x02, MBUTTON=0x04, XBUTTON1=0x05, XBUTTON2=0x06
            // DOM button: 0=left, 1=middle, 2=right, 3=back (X1), 4=forward (X2)
            return n switch
            {
                0 => 0x01, // VK_LBUTTON
                1 => 0x04, // VK_MBUTTON
                2 => 0x02, // VK_RBUTTON
                3 => 0x05, // VK_XBUTTON1 (back)
                4 => 0x06, // VK_XBUTTON2 (forward)
                _ => null
            };
        }

        if (CodeToVk.TryGetValue(s, out var vk)) return vk;

        if (s.StartsWith("Key", StringComparison.Ordinal))
        {
            var key = s["Key".Length..];
            if (key.Length == 1)
            {
                var upper = char.ToUpperInvariant(key[0]);
                if (upper is >= 'A' and <= 'Z') return upper; // 0x41-0x5A
            }
        }

        if (s.StartsWith("Digit", StringComparison.Ordinal) && s.Length == "Digit0".Length)
        {
            if (int.TryParse(s.AsSpan("Digit".Length), out var d)) return 0x30 + d;
        }

        if (s.StartsWith("Numpad", StringComparison.Ordinal))
        {
            if (int.TryParse(s.AsSpan("Numpad".Length), out var n) && n is >= 0 and <= 9)
                return 0x60 + n; // VK_NUMPAD0-9
        }

        if (s.StartsWith('F') && s.Length is >= 2 and <= 3)
        {
            if (int.TryParse(s.AsSpan(1), out var n) && n is >= 1 and <= 12)
                return 0x70 + (n - 1);
        }

        return null;
    }

    /// <summary>Start polling the given VK. When key state changes, calls <paramref name="onState"/>.
    /// Returns a stop action. No-op (returns a no-op disposer) if not on Windows.</summary>
    public static IDisposable Start(int vk, Action<bool> onState)
    {
        if (!OperatingSystem.IsWindows()) return new NoopDisposable();
        var poller = new PttPoller(vk, onState);
        poller._timer = new Timer(poller.Tick, null, PollMs, PollMs);
        return poller;
    }

    private void Tick(object? _)
    {
        try
        {
            var state = Win32.GetAsyncKeyState(_vk);
            var pressed = (state & KeyDownMask) != 0;
            if (pressed != _lastPressed)
            {
                _lastPressed = pressed;
                _onState(pressed);
            }
        }
        catch
        {
            // ignore — polling must never throw into the caller
        }
    }

    public void Dispose()
    {
        _timer?.Dispose();
        _timer = null;
    }

    private sealed class NoopDisposable : IDisposable
    {
        public void Dispose() { }
    }
}
