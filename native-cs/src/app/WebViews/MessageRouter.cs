using System.Text.Json;
using System.Text.Json.Nodes;
using Sharkov.App.Models;
using Sharkov.App.Storage;

namespace Sharkov.App.WebViews;

/// <summary>The shape of a postMessage received from an iframe via WebView2.
/// Mirrors the Electron app's <c>{ type: "sharkord-*", ... }</c> protocol.
/// Uses <see cref="JsonObject"/> (owned, no disposal) rather than JsonDocument so the
/// parsed payload outlives the parse call.</summary>
public readonly record struct WebMessage(string Type, JsonObject Data, string Origin)
{
    public static WebMessage? Parse(string json, string origin)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try
        {
            var node = JsonNode.Parse(json);
            if (node is not JsonObject obj) return null;
            if (!obj.TryGetPropertyValue("type", out var t) || t is null) return null;
            return new WebMessage(t.GetValue<string>(), obj, origin);
        }
        catch { return null; }
    }
}

/// <summary>Handles every <c>sharkord-*</c> postMessage type. Ports the message listener
/// in wrapper.js. Each handler is a pure decision; the side effects (IPC calls, modal
/// shows, frame navigation) are delegated to <see cref="IMessageHandlerActions"/> so this
/// class is unit-testable without a WebView.</summary>
public sealed class MessageRouter
{
    // Small helpers — JsonNode's GetValue<JsonValueKind>() throws on a JsonValue<string>,
    // so probe by attempting the typed conversion instead.
    private static bool IsBool(JsonNode? n)
    { try { if (n is null) return false; n.GetValue<bool>(); return true; } catch { return false; } }
    private static bool IsNum(JsonNode? n)
    { try { if (n is null) return false; n.GetValue<double>(); return true; } catch { return false; } }
    private static bool IsStr(JsonNode? n)
    { try { if (n is null) return false; n.GetValue<string>(); return true; } catch { return false; } }

    private readonly IMessageHandlerActions _actions;
    private readonly Func<List<SavedServer>> _getServers;
    private readonly Func<string, (string Identity, string Password)?> _getCredentials;
    private readonly Action<string, string, string> _saveCredentials;
    private readonly Action<string> _clearCredentials;
    private readonly Func<int, bool> _startProcessAudio;
    private readonly Action _stopProcessAudio;
    private readonly Action<string> _logRtcStats;

    public MessageRouter(IMessageHandlerActions actions, Func<List<SavedServer>> getServers,
        Func<string, (string, string)?> getCredentials,
        Action<string, string, string> saveCredentials, Action<string> clearCredentials,
        Func<int, bool> startProcessAudio, Action stopProcessAudio, Action<string> logRtcStats)
    {
        _actions = actions;
        _getServers = getServers;
        _getCredentials = getCredentials;
        _saveCredentials = saveCredentials;
        _clearCredentials = clearCredentials;
        _startProcessAudio = startProcessAudio;
        _stopProcessAudio = stopProcessAudio;
        _logRtcStats = logRtcStats;
    }

    /// <summary>Route one parsed message. Returns true if handled.</summary>
    public bool Route(WebMessage msg)
    {
        return msg.Type switch
        {
            "sharkord-ptt" => HandlePtt(msg),
            "sharkord-start-process-audio" => HandleStartProcessAudio(msg),
            "sharkord-stop-process-audio" => HandleStopProcessAudio(),
            "sharkord-process-audio-chunk" => false, // handled by the audio relay directly
            "sharkord-rtc-stats" => HandleRtcStats(msg),
            "sharkord-copy-to-clipboard" => HandleCopyToClipboard(msg),
            "sharkord-save-credentials" => HandleSaveCredentials(msg),
            "sharkord-clear-credentials" => HandleClearCredentials(msg),
            "sharkord-request-credentials" => HandleRequestCredentials(msg),
            "sharkord-request-bitrate" => HandleRequestBitrate(),
            "sharkord-set-video-bitrate" => false, // the bitrate bar sends this, doesn't receive
            "sharkord-add-server" => HandleAddServerFromCommunity(msg),
            "sharkord-iframe-contextmenu" => false, // TODO: context menu modal
            _ => false
        };
    }

    private bool HandlePtt(WebMessage msg)
    {
        if (!msg.Data.TryGetPropertyValue("pressed", out var p) || !IsBool(p)) return false;
        _actions.SetPtt(p!.GetValue<bool>());
        return true;
    }

    private bool HandleStartProcessAudio(WebMessage msg)
    {
        if (!msg.Data.TryGetPropertyValue("pid", out var p) || !IsNum(p)) return false;
        var pid = p!.GetValue<int>();
        if (pid <= 0) return false;
        var ok = _startProcessAudio(pid);
        if (!ok) _actions.NotifyProcessAudioFailed(msg.Origin, "not available");
        return true;
    }

    private bool HandleStopProcessAudio()
    {
        _stopProcessAudio();
        return true;
    }

    private bool HandleRtcStats(WebMessage msg)
    {
        if (!msg.Data.TryGetPropertyValue("report", out _)) return false;
        _logRtcStats(msg.Data.ToJsonString());
        return true;
    }

    private bool HandleCopyToClipboard(WebMessage msg)
    {
        if (!msg.Data.TryGetPropertyValue("text", out var t) || !IsStr(t)) return false;
        _actions.ShowCopyTextModal(t!.GetValue<string>()!);
        return true;
    }

    private bool HandleSaveCredentials(WebMessage msg)
    {
        if (!msg.Data.TryGetPropertyValue("identity", out var idEl) || !IsStr(idEl)) return false;
        if (!msg.Data.TryGetPropertyValue("password", out var pwEl) || !IsStr(pwEl)) return false;
        // Only persist for origins we already have a saved server for (origin validation).
        var known = _getServers().Any(s => ConfigStore.OriginOf(s.Url) == msg.Origin);
        if (known) _saveCredentials(msg.Origin, idEl!.GetValue<string>()!, pwEl!.GetValue<string>()!);
        return true;
    }

    private bool HandleClearCredentials(WebMessage msg)
    {
        _clearCredentials(msg.Origin);
        return true;
    }

    private bool HandleRequestCredentials(WebMessage msg)
    {
        var known = _getServers().Any(s => ConfigStore.OriginOf(s.Url) == msg.Origin);
        if (!known) return true;
        var creds = _getCredentials(msg.Origin);
        _actions.PostCredentialsToFrame(msg.Origin, creds?.Identity, creds?.Password);
        return true;
    }

    private bool HandleRequestBitrate()
    {
        _actions.RespondWithCurrentBitrate();
        return true;
    }

    private bool HandleAddServerFromCommunity(WebMessage msg)
    {
        if (!msg.Data.TryGetPropertyValue("url", out var u) || !IsStr(u)) return false;
        var url = u!.GetValue<string>()!;
        var name = msg.Data.TryGetPropertyValue("name", out var n) && IsStr(n)
            ? n!.GetValue<string>()! : new Uri(url).Host;
        _actions.ShowAddServerConfirmModal(url, name);
        return true;
    }
}

/// <summary>Side-effect interface used by <see cref="MessageRouter"/>. Implemented by the
/// WPF shell; mocked in tests.</summary>
public interface IMessageHandlerActions
{
    void SetPtt(bool pressed);
    void NotifyProcessAudioFailed(string origin, string error);
    void ShowCopyTextModal(string text);
    void PostCredentialsToFrame(string origin, string? identity, string? password);
    void RespondWithCurrentBitrate();
    void ShowAddServerConfirmModal(string url, string name);
}
