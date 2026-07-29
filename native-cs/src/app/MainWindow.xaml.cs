using System.ComponentModel;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Sharkov.App.Injection;
using Sharkov.App.Models;
using Sharkov.App.Native;
using Sharkov.App.Storage;
using Sharkov.App.WebViews;

namespace Sharkov.App;

/// <summary>The main window: a sidebar of saved servers + a WebView2 per server tab.
/// Ports the parent-frame responsibilities of static/wrapper.js + the injection +
/// message-routing from main.ts. The SPA itself renders inside each WebView2.</summary>
public partial class MainWindow : Window, IMessageHandlerActions
{
    private readonly ConfigStore _store;
    private readonly CredentialService _creds;
    private readonly FrameInjector _injector;
    private readonly MessageRouter _router;
    private readonly Dictionary<string, WebView2> _webviews = new();
    private string? _activeServerId;
    private CoreWebView2Environment? _webview2Env; // cached so EnsureCoreWebView2Async picks up the Tarkov auto-select flag

    public MainWindow()
    {
        InitializeComponent();
        _store = new ConfigStore();
        _creds = new CredentialService(new DpapiCredentialCrypto());
        _injector = new FrameInjector(_store);
        _router = new MessageRouter(this,
            () => _store.GetSavedServers(),
            origin => _creds.LoadCredentials(_store.GetSavedServers(), origin),
            (origin, id, pw) => _store.SetSavedServers(_creds.SaveCredentials(_store.GetSavedServers(), origin, id, pw)),
            origin => _store.SetSavedServers(_creds.ClearCredentials(_store.GetSavedServers(), origin)),
            pid => StartProcessAudio(pid),
            StopProcessAudio,
            LogRtcStats);

        VersionLabel.Text = "v" + GetType().Assembly.GetName().Version!.ToString(3);
        LoadBitrateCombo();
        CenterOnPrimaryMonitor();
        _ = InitializeAsync();
    }

    /// <summary>Center the window on the primary monitor. WPF's CenterScreen centers on
    /// whichever screen the mouse is on, which on multi-mon setups with a left-arranged
    /// secondary (e.g. DISPLAY1 at negative X) can strand the window off-screen. We place
    /// the window at the primary monitor's origin offset by half the screen-size
    /// difference, using WPF SystemParameters (no WinForms dependency to avoid namespace
    /// collisions with System.Windows.*).</summary>
    private void CenterOnPrimaryMonitor()
    {
        try
        {
            var sw = System.Windows.SystemParameters.PrimaryScreenWidth;
            var sh = System.Windows.SystemParameters.PrimaryScreenHeight;
            Left = Math.Max(0, (sw - Width) / 2);
            Top = Math.Max(0, (sh - Height) / 2);
        }
        catch { /* fall back to default placement */ }
    }

    // Writes one JSON line per report to %APPDATA%\Sharkov\rtc-stats.log (ported from the
    // Electron app's rtc-stats.log, capped at 50MB with single .1 rotation).
    private static void LogRtcStats(string line)
    {
        try
        {
            var path = System.IO.Path.Combine(
                System.IO.Path.GetDirectoryName(ConfigStore.DefaultPath())!, "rtc-stats.log");
            if (new System.IO.FileInfo(path).Length > 50 * 1024 * 1024)
                System.IO.File.Move(path, path + ".1", overwrite: true);
            System.IO.File.AppendAllText(path, DateTime.Now.ToString("o") + " " + line + "\n");
        }
        catch { }
    }

    private async Task InitializeAsync()
    {
        await EnsureWebView2EnvironmentAsync();
        RenderSidebar();
    }

    private async Task EnsureWebView2EnvironmentAsync()
    {
        try
        {
            // NOTE: an earlier attempt here set --auto-select-desktop-capture-source=<Tarkov>
            // when a Tarkov window was detected, to mirror the Electron app's picker auto-select.
            // That Chromium flag is documented as unreliable (chromium issues 41167327, 475372)
            // and in practice here it left a frozen, uncancellable picker when the SPA called
            // getDisplayMedia — strictly worse than the default built-in picker. Reverted.
            // The screen-share picker now uses WebView2's built-in Tab/Window/Screen chooser.
            // See git history (commit 4b10f9e) for the failed approach + TarkovDetector (kept
            // for a future native-capture approach that bypasses getDisplayMedia entirely).
            _webview2Env = await CoreWebView2Environment.CreateAsync();
        }
        catch { /* uses the installed evergreen runtime by default */ }
    }

    // ---- sidebar ----

    private void RenderSidebar()
    {
        ServerButtons.Children.Clear();
        var servers = _store.GetSavedServers();
        foreach (var server in servers)
        {
            var btn = new Button
            {
                Style = (Style)Resources["ServerBtn"],
                Content = GetServerIcon(server),
                Tag = server.Id,
                ToolTip = server.Name + (server.KeepConnected ? " (keep connected)" : ""),
            };
            btn.Click += (s, e) => ShowServer((string)((Button)s).Tag);
            ServerButtons.Children.Add(btn);
        }
        if (servers.Count == 0)
        {
            EmptyState.Visibility = Visibility.Visible;
        }
        else
        {
            EmptyState.Visibility = Visibility.Collapsed;
            ShowServer(servers[0].Id);
        }
    }

    private static string GetServerIcon(SavedServer s)
    {
        if (!string.IsNullOrWhiteSpace(s.Icon)) return s.Icon.Trim();
        return string.IsNullOrEmpty(s.Name) ? "?" : s.Name[..1].ToUpperInvariant();
    }

    private void ShowServer(string serverId)
    {
        var servers = _store.GetSavedServers();
        var server = servers.FirstOrDefault(s => s.Id == serverId);
        if (server is null) return;
        _activeServerId = serverId;
        _store.SetServerUrl(server.Url);

        // ensure a webview exists for this server
        if (!_webviews.TryGetValue(serverId, out var wv))
        {
            wv = new WebView2();
            wv.WebMessageReceived += OnWebMessageReceived;
            wv.NavigationCompleted += async (_, e) =>
            {
                if (e.IsSuccess) await _injector.InjectAllAsync(wv.CoreWebView2);
            };
            // Lock the top frame: only navigate to the server URL, never away to arbitrary origins.
            // (Mirrors the will-navigate guard in main.ts that pins the top frame.)
            _webviews[serverId] = wv;
            ContentArea.Children.Add(wv);
        }

        // toggle visibility: active visible, others hidden
        foreach (var (id, v) in _webviews)
            v.Visibility = id == serverId ? Visibility.Visible : Visibility.Collapsed;

        if (wv.CoreWebView2 is null)
            _ = InitializeWebViewAndNavigateAsync(wv, server.Url);
        else if (wv.Source != new Uri(server.Url))
            wv.CoreWebView2.Navigate(server.Url);

        // update sidebar active styles
        foreach (Button b in ServerButtons.Children)
            b.Style = (string)b.Tag == serverId ? (Style)Resources["ActiveServerBtn"] : (Style)Resources["ServerBtn"];
    }

    /// <summary>Initialize the control's CoreWebView2 then navigate. Without this the
    /// first ShowServer call at startup would leave a blank page: EnsureCoreWebView2Async
    /// alone doesn't load any URL, leaving users staring at an empty frame until they
    /// re-click the server button.</summary>
    private async Task InitializeWebViewAndNavigateAsync(WebView2 wv, string url)
    {
        // Pass the cached env (with the Tarkov auto-select flag) so the WebView2 process
        // inherits it. Omitting the arg builds a fresh default env and discards the flag.
        if (_webview2Env is not null) await wv.EnsureCoreWebView2Async(_webview2Env);
        else await wv.EnsureCoreWebView2Async();
        wv.Source = new Uri(url);
    }

    // ---- graceful shutdown: close the SPA's WebSockets so the server sees us leave ----

    private bool _isClosing;

    /// <summary>On close, first close the SPA's tRPC WebSockets cleanly so the server fires
    /// "left the server" + tears down voice state immediately, instead of relying on the
    /// TCP/proxy timeout which accumulated zombie sessions (and could crash the mediasoup
    /// worker under load). ws.close() is async (close-frame handshake), so we cancel the
    /// first close, flush for ~1.5s, then close for real on the second pass.</summary>
    protected override void OnClosing(CancelEventArgs e)
    {
        base.OnClosing(e);
        if (_isClosing) return;
        e.Cancel = true;
        _isClosing = true;
        _ = CloseGracefullyAsync();
    }

    private async Task CloseGracefullyAsync()
    {
        foreach (var wv in _webviews.Values)
        {
            if (wv.CoreWebView2 is null) continue;
            try { await wv.CoreWebView2.ExecuteScriptAsync(InjectionBuilders.BuildCloseWebSocketsJs()); }
            catch { /* webview already torn down — nothing to close */ }
        }
        // Give the close frames time to flush through the proxy before the process dies;
        // otherwise the OS RSTs the TCP socket and the server only learns on its own timeout.
        await Task.Delay(1500);
        Close();
    }

    // ---- WebView2 message bridge ----

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // The injections post OBJECTS ({type:"sharkord-*",...}) via chrome.webview.postMessage.
        // TryGetWebMessageAsString() THROWS ArgumentException for object messages (it only handles
        // plain strings), so every sharkord-* message used to throw here and never route — which
        // is why PTT was stuck hot (sharkord-ptt never reached SetPtt) and rtc-stats never logged.
        // WebMessageAsJson handles both: for an object it returns the object's JSON (e.g.
        // '{"type":"sharkord-ptt","pressed":true}'); for a plain string it returns '"str"'.
        // We prefer JSON; fall back to the string API only if the page posted a bare string.
        string json;
        try { json = e.WebMessageAsJson; }
        catch
        {
            try { json = e.TryGetWebMessageAsString(); }
            catch { return; }
        }
        // The message's origin: take it from the webview's current Source (the sender),
        // normalized to scheme+host+port. Mirrors e.origin in the postMessage protocol.
        var origin = "";
        if (sender is WebView2 wv && wv.Source is { } src && src.IsAbsoluteUri)
            origin = ConfigStore.OriginOf(src.ToString()) ?? "";
        var msg = WebMessage.Parse(json ?? "", origin);
        if (msg is not null) _router.Route(msg.Value);
    }

    // ---- bitrate bar ----

    private void LoadBitrateCombo()
    {
        BitrateCombo.Items.Clear();
        foreach (var (label, value) in new[] {
            ("Auto", 0), ("1 Mbps", 1000), ("2 Mbps", 2000), ("4 Mbps", 4000),
            ("6 Mbps", 6000), ("8 Mbps", 8000), ("10 Mbps", 10000), ("15 Mbps", 15000)
        })
        {
            BitrateCombo.Items.Add(new ComboBoxItem { Content = label, Tag = value });
        }
        var current = _store.GetDevicePreferences().VideoBitrate ?? 0;
        BitrateCombo.SelectedIndex = Array.FindIndex(
            new[] { 0, 1000, 2000, 4000, 6000, 8000, 10000, 15000 }, v => v == current);
        if (BitrateCombo.SelectedIndex < 0) BitrateCombo.SelectedIndex = 0;
    }

    private void BitrateCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (BitrateCombo.SelectedItem is not ComboBoxItem item) return;
        var kbps = (int)(item.Tag ?? 0);
        var prefs = _store.GetDevicePreferences();
        prefs = prefs with { VideoBitrate = kbps };
        _store.SetDevicePreferences(prefs);
        // post the live update to the active webview
        if (_activeServerId is not null && _webviews.TryGetValue(_activeServerId, out var wv) && wv.CoreWebView2 is not null)
            _injector.PostBitrate(wv.CoreWebView2, kbps);
    }

    private void PttBtn_Click(object sender, RoutedEventArgs e)
    {
        var current = _store.GetDevicePreferences().PttBinding;
        var dlg = new PttPickerDialog(_store, _injector,
            () => _activeServerId is not null && _webviews.TryGetValue(_activeServerId, out var wv) ? wv : null,
            current)
        { Owner = this };
        dlg.ShowDialog();
    }

    // ---- add server ----

    private void AddServerBtn_Click(object sender, RoutedEventArgs e)
    {
        var url = PromptDialog.Show(this, "Add server", "Server URL:", "https://");
        if (string.IsNullOrWhiteSpace(url)) return;
        var normalized = url.StartsWith("http://") || url.StartsWith("https://") ? url : $"https://{url}";
        string name;
        try { name = new Uri(normalized).Host; }
        catch { return; }
        var servers = _store.GetSavedServers();
        if (servers.Any(s => s.Url == normalized)) return;
        servers.Add(new SavedServer { Id = Guid.NewGuid().ToString(), Url = normalized, Name = name });
        _store.SetSavedServers(servers);
        RenderSidebar();
    }

    // ---- process audio ----

    private ProcessAudioCapture? _processAudio;
    private bool StartProcessAudio(int pid)
    {
        try
        {
            StopProcessAudio();
            _processAudio = new ProcessAudioCapture((uint)pid, _ => { /* TODO: relay PCM to active webview */ });
            _processAudio.Start();
            return true;
        }
        catch
        {
            // WASAPI activation is stubbed in this port — the screen picker falls back to
            // system loopback. See native-cs/README.md.
            return false;
        }
    }

    private void StopProcessAudio()
    {
        _processAudio?.Dispose();
        _processAudio = null;
    }

    // ---- IMessageHandlerActions ----

    public void SetPtt(bool pressed)
    {
        // PTT state: enable/disable the audio tracks in the active webview.
        // Ports applyPttStateToFrames in main.ts.
        if (_activeServerId is null || !_webviews.TryGetValue(_activeServerId, out var wv) || wv.CoreWebView2 is null) return;
        var js = $"(function(p){{window.__sharkordPttAudioTracks&&window.__sharkordPttAudioTracks.forEach(function(t){{t.enabled=p;}});}})({pressed.ToString().ToLower()});";
        _ = wv.CoreWebView2.ExecuteScriptAsync(js);
    }

    public void NotifyProcessAudioFailed(string origin, string error)
        => Dispatcher.Invoke(() => MessageBox.Show($"Process audio capture failed: {error}", "Sharkov"));

    public void ShowCopyTextModal(string text)
    {
        Dispatcher.Invoke(() =>
        {
            try { Clipboard.SetText(text); } catch { }
            MessageBox.Show(text, "Copied");
        });
    }

    public void PostCredentialsToFrame(string origin, string? identity, string? password)
    {
        if (_activeServerId is null || !_webviews.TryGetValue(_activeServerId, out var wv) || wv.CoreWebView2 is null) return;
        var js = $"window.postMessage({{ type: 'sharkord-credentials', identity: {JsonSerializer.Serialize(identity)}, password: {JsonSerializer.Serialize(password)} }}, '*');";
        _ = wv.CoreWebView2.ExecuteScriptAsync(js);
    }

    public void RespondWithCurrentBitrate()
    {
        if (_activeServerId is null || !_webviews.TryGetValue(_activeServerId, out var wv) || wv.CoreWebView2 is null) return;
        _injector.PostCurrentBitrate(wv.CoreWebView2);
    }

    public void ShowAddServerConfirmModal(string url, string name)
    {
        Dispatcher.Invoke(() =>
        {
            var add = MessageBox.Show($"Add \"{name}\" ({url}) to your server panel?", "Add server", MessageBoxButton.OKCancel);
            if (add != MessageBoxResult.OK) return;
            var servers = _store.GetSavedServers();
            if (servers.Any(s => s.Url == url)) return;
            servers.Add(new SavedServer { Id = Guid.NewGuid().ToString(), Url = url, Name = name });
            _store.SetSavedServers(servers);
            RenderSidebar();
        });
    }
}
