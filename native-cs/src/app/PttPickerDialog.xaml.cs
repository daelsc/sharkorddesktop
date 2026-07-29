using System.Windows;
using System.Windows.Input;
using Sharkov.App.Native;
using Sharkov.App.Storage;
using Sharkov.App.WebViews;

namespace Sharkov.App;

/// <summary>Push-to-talk key picker. Mirrors the Electron wrapper's
/// <c>device-ptt-set</c> listen mode (static/wrapper.js): click "Set key", then the next
/// key or mouse button becomes the binding; Escape cancels; left/right mouse are ignored
/// (they're UI interactions). Captures via WPF PreviewKeyDown/PreviewMouseDown and maps
/// the key to the KeyboardEvent.code string the injection compares against (e.g.
/// "BracketLeft", "KeyV", "F5", "Numpad3", "Mouse4") using the reverse of
/// <see cref="PttPoller.PttBindingToVk"/>. On save, writes the binding to ConfigStore and
/// re-injects the device-prefs so the live webview picks it up without a restart.</summary>
public partial class PttPickerDialog : Window
{
    private readonly ConfigStore _store;
    private readonly FrameInjector _injector;
    private readonly Func<Microsoft.Web.WebView2.Wpf.WebView2?> _getActiveWebView;
    private bool _listening;
    private string? _binding;

    public PttPickerDialog(ConfigStore store, FrameInjector injector,
        Func<Microsoft.Web.WebView2.Wpf.WebView2?> getActiveWebView, string? currentBinding)
    {
        InitializeComponent();
        _store = store;
        _injector = injector;
        _getActiveWebView = getActiveWebView;
        _binding = currentBinding;
        UpdateDisplay();
    }

    private void SetBtn_Click(object sender, RoutedEventArgs e)
    {
        _listening = true;
        SetBtn.Content = "Listening…";
        SetBtn.IsEnabled = false;
        Hint.Text = "Press any key, or a middle/side mouse button (Esc to cancel).";
        BindingDisplay.Text = "Listening…";
        BindingDisplay.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x3b, 0x82, 0xf6));
        // Grab keyboard focus so PreviewKeyDown fires here even if the user's last
        // interaction was clicking the button.
        Keyboard.Focus(this);
        Focus();
    }

    private void ResetBtn_Click(object sender, RoutedEventArgs e)
    {
        StopListening();
        _binding = null;
        SaveAndReinject();
        UpdateDisplay();
    }

    private void CloseBtn_Click(object sender, RoutedEventArgs e) => Close();

    // ---- listen mode: capture the next key or mouse button ----

    protected override void OnPreviewKeyDown(KeyEventArgs e)
    {
        if (!_listening) { base.OnPreviewKeyDown(e); return; }
        e.Handled = true;

        // Escape cancels listen mode without changing the binding (mirrors wrapper.js).
        if (e.Key == Key.Escape)
        {
            StopListening();
            UpdateDisplay();
            return;
        }

        // Map the WPF Key to a Windows VK, then to the e.code binding string.
        var vk = KeyInterop.VirtualKeyFromKey(e.Key);
        var code = PttPoller.VkToPttBinding(vk);
        if (code is null)
        {
            // Unsupported key — keep listening, flash a hint.
            Hint.Text = "That key isn't supported as a PTT key; try another.";
            return;
        }
        _binding = code;
        StopListening();
        SaveAndReinject();
        UpdateDisplay();
    }

    protected override void OnPreviewMouseDown(MouseButtonEventArgs e)
    {
        if (!_listening) { base.OnPreviewMouseDown(e); return; }
        e.Handled = true;

        // Mirror wrapper.js: ignore left (0) and right (2) — they're UI clicks. Accept
        // middle (1), back/X1 (3), forward/X2 (4). DOM button numbering → "Mouse<N>".
        int? domButton = e.ChangedButton switch
        {
            MouseButton.Middle => 1,
            MouseButton.XButton1 => 3,
            MouseButton.XButton2 => 4,
            _ => null
        };
        if (domButton is null) return; // left/right — keep listening
        _binding = "Mouse" + domButton;
        StopListening();
        SaveAndReinject();
        UpdateDisplay();
    }

    // Make the whole dialog clickable during listen mode so a stray left-click doesn't
    // silently fall through to whatever's behind it.
    protected override void OnMouseDown(MouseButtonEventArgs e)
    {
        if (_listening) e.Handled = true;
        base.OnMouseDown(e);
    }

    private void StopListening()
    {
        _listening = false;
        SetBtn.Content = "Set key";
        SetBtn.IsEnabled = true;
    }

    private void UpdateDisplay()
    {
        BindingDisplay.Text = PttPoller.FormatBinding(_binding);
        BindingDisplay.Foreground = new System.Windows.Media.SolidColorBrush(
            string.IsNullOrEmpty(_binding)
                ? System.Windows.Media.Color.FromRgb(0xa1, 0xa1, 0xaa)
                : System.Windows.Media.Color.FromRgb(0xe4, 0xe4, 0xe7));
        Hint.Text = string.IsNullOrEmpty(_binding)
            ? "Click “Set key” then press a key or mouse button."
            : "Hold this key while in a voice channel to talk.";
    }

    private void SaveAndReinject()
    {
        var prefs = _store.GetDevicePreferences();
        prefs.PttBinding = _binding;
        _store.SetDevicePreferences(prefs);
        // Re-inject device prefs into the active webview so the new key takes effect
        // immediately (the listeners read pttBinding at injection time).
        var wv = _getActiveWebView();
        if (wv?.CoreWebView2 is not null)
            _ = wv.CoreWebView2.ExecuteScriptAsync(FrameInjector.BuildDevicePrefsJsForReinject(prefs));
    }
}
