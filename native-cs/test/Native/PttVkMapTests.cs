using Sharkov.App.Native;

namespace Sharkov.Tests.Native;

/// <summary>Tests for <see cref="PttPoller.PttBindingToVk"/> — the e.code → Windows VK map.
/// Ports the VK-mapping coverage implied by pttBackgroundPoller.ts.</summary>
public class PttVkMapTests
{
    [Fact]
    public void NullOrEmpty_ReturnsNull()
    {
        Assert.Null(PttPoller.PttBindingToVk(null));
        Assert.Null(PttPoller.PttBindingToVk(""));
        Assert.Null(PttPoller.PttBindingToVk("   "));
    }

    [Theory]
    [InlineData("KeyA", 0x41)]
    [InlineData("KeyZ", 0x5A)]
    [InlineData("KeyP", 0x50)]
    [InlineData("Keya", 0x41)] // case-insensitive
    public void KeyLetters_MapToAscii(string binding, int expected)
        => Assert.Equal(expected, PttPoller.PttBindingToVk(binding));

    [Theory]
    [InlineData("Digit0", 0x30)]
    [InlineData("Digit9", 0x39)]
    public void Digits_MapToNumpad(string binding, int expected)
        => Assert.Equal(expected, PttPoller.PttBindingToVk(binding));

    [Theory]
    [InlineData("Numpad0", 0x60)]
    [InlineData("Numpad9", 0x69)]
    public void NumpadDigits_MapToVkNumpad(string binding, int expected)
        => Assert.Equal(expected, PttPoller.PttBindingToVk(binding));

    [Theory]
    [InlineData("F1", 0x70)]
    [InlineData("F12", 0x7B)]
    public void FunctionKeys_MapToVkF(string binding, int expected)
        => Assert.Equal(expected, PttPoller.PttBindingToVk(binding));

    [Theory]
    [InlineData("BracketLeft", 0xdb)]
    [InlineData("BracketRight", 0xdd)]
    [InlineData("Backslash", 0xdc)]
    [InlineData("Semicolon", 0xba)]
    [InlineData("Quote", 0xde)]
    [InlineData("Comma", 0xbc)]
    [InlineData("Period", 0xbe)]
    [InlineData("Slash", 0xbf)]
    [InlineData("Backquote", 0xc0)]
    [InlineData("Minus", 0xbd)]
    [InlineData("Equal", 0xbb)]
    public void PunctuationCodes_MapToOemVk(string binding, int expected)
        => Assert.Equal(expected, PttPoller.PttBindingToVk(binding));

    [Theory]
    [InlineData("Space", 0x20)]
    [InlineData("Enter", 0x0d)]
    [InlineData("Tab", 0x09)]
    [InlineData("Escape", 0x1b)]
    [InlineData("Backspace", 0x08)]
    [InlineData("CapsLock", 0x14)]
    [InlineData("ArrowLeft", 0x25)]
    [InlineData("ArrowUp", 0x26)]
    [InlineData("ArrowRight", 0x27)]
    [InlineData("ArrowDown", 0x28)]
    [InlineData("Home", 0x24)]
    [InlineData("End", 0x23)]
    [InlineData("PageUp", 0x21)]
    [InlineData("PageDown", 0x22)]
    [InlineData("Insert", 0x2d)]
    [InlineData("Delete", 0x2e)]
    public void SpecialKeys_MapCorrectly(string binding, int expected)
        => Assert.Equal(expected, PttPoller.PttBindingToVk(binding));

    [Theory]
    [InlineData("ShiftLeft", 0xa0)]
    [InlineData("ShiftRight", 0xa1)]
    [InlineData("ControlLeft", 0xa2)]
    [InlineData("ControlRight", 0xa3)]
    [InlineData("AltLeft", 0xa4)]
    [InlineData("AltRight", 0xa5)]
    public void Modifiers_MapCorrectly(string binding, int expected)
        => Assert.Equal(expected, PttPoller.PttBindingToVk(binding));

    // ---- mouse: DOM button index → Windows VK ----
    [Theory]
    [InlineData("Mouse0", 0x01)] // left → VK_LBUTTON
    [InlineData("Mouse1", 0x04)] // middle → VK_MBUTTON
    [InlineData("Mouse2", 0x02)] // right → VK_RBUTTON
    [InlineData("Mouse3", 0x05)] // back (X1) → VK_XBUTTON1
    [InlineData("Mouse4", 0x06)] // forward (X2) → VK_XBUTTON2
    public void MouseButtons_MapToVk(string binding, int expected)
        => Assert.Equal(expected, PttPoller.PttBindingToVk(binding));

    [Fact]
    public void UnsupportedBinding_ReturnsNull()
    {
        Assert.Null(PttPoller.PttBindingToVk("KeyAB"));    // two-char letter key
        Assert.Null(PttPoller.PttBindingToVk("F13"));     // F13 out of range
        Assert.Null(PttPoller.PttBindingToVk("NumpadX")); // not a number
        Assert.Null(PttPoller.PttBindingToVk("Mouse9"));   // only 0-4
        Assert.Null(PttPoller.PttBindingToVk("Whatever"));
    }
}
