using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Sharkov.App.Injection;
using Sharkov.App.Models;
using Sharkov.App.Storage;

namespace Sharkov.App.WebViews;

/// <summary>Injects the 7 hook strings into a WebView2 frame on navigation. Ports
/// <c>injectDevicePrefsIntoFrame</c> in main.ts. The injected JS is vanilla Chromium API
/// and runs identically under WebView2 — only the host plumbing differs.</summary>
public sealed class FrameInjector
{
    private readonly ConfigStore _store;

    public FrameInjector(ConfigStore store) => _store = store;

    /// <summary>Run all injections into the main frame of the given webview. Called on
    /// <c>NavigationCompleted</c> for the top-level page (the SPA).</summary>
    public async Task InjectAllAsync(CoreWebView2 webview)
    {
        var prefs = _store.GetDevicePreferences();
        var prefsJson = JsonSerializer.Serialize(prefs);
        var pttBinding = prefs.PttBinding;
        var forcedBps = (prefs.VideoBitrate ?? 0) * 1000;
        var forcedCodec = prefs.VideoCodec ?? "H264";

        // Each injection is fire-and-forget; failures in one must not block the others.
        // WebSocket capture runs first so the hook is installed before the SPA's tRPC
        // client opens its socket (which happens on join/login, after NavigationCompleted).
        await TryExec(webview, InjectionBuilders.BuildWebSocketCaptureInjection());
        await TryExec(webview, InjectionBuilders.BuildDevicePrefsInjection(prefsJson, pttBinding));
        await TryExec(webview, InjectionBuilders.BuildClipboardCopyInjection());
        await TryExec(webview, InjectionBuilders.BuildMuteStreamsInjection());
        await TryExec(webview, InjectionBuilders.BuildWebrtcStatsInjection(forcedBps, forcedCodec));
        await TryExec(webview, InjectionBuilders.BuildSimulcastCodecInjection());
        await TryExec(webview, InjectionBuilders.BuildCredentialCaptureInjection());
        await TryExec(webview, InjectionBuilders.BuildAutoLoginInjection());
    }

    /// <summary>The bitrate/codec live-update message (ports the wrapper's
    /// <c>postBitrateToFrames</c>). Posted to the active frame when the selector changes.</summary>
    public void PostBitrate(CoreWebView2 webview, int kbps)
    {
        var bps = kbps * 1000;
        var js = $"window.postMessage({{ type: 'sharkord-set-video-bitrate', bps: {bps} }}, '*');";
        _ = webview.ExecuteScriptAsync(js);
    }

    /// <summary>Post the current stored bitrate to a frame (handshake response to
    /// <c>sharkord-request-bitrate</c>).</summary>
    public void PostCurrentBitrate(CoreWebView2 webview)
    {
        var kbps = _store.GetDevicePreferences().VideoBitrate ?? 0;
        PostBitrate(webview, kbps);
    }

    /// <summary>JS to update the PTT binding live in a webview (used by the picker dialog).
    /// Idempotent — safe to call repeatedly; does not re-wrap getUserMedia.</summary>
    public static string BuildDevicePrefsJsForReinject(DevicePreferences prefs)
        => InjectionBuilders.BuildPttBindingUpdateJs(prefs.PttBinding);

    private static async Task TryExec(CoreWebView2 webview, string code)
    {
        try { await webview.ExecuteScriptAsync(code); }
        catch { /* injection failures are non-fatal — the SPA still works */ }
    }
}
