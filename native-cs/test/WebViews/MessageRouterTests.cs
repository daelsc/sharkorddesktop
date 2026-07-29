using System.Text.Json;
using Sharkov.App.Models;
using Sharkov.App.WebViews;

namespace Sharkov.Tests.WebViews;

/// <summary>Tests for <see cref="MessageRouter"/> — pure routing decisions with a mock
/// actions impl. Each sharkord-* message type is covered.</summary>
public class MessageRouterTests
{
    private sealed class FakeActions : IMessageHandlerActions
    {
        public bool Ptt { get; set; }
        public string? AudioFailedOrigin { get; set; }
        public string? CopyText { get; set; }
        public (string Origin, string? Id, string? Pw)? CredsPosted { get; set; }
        public bool BitrateResponded { get; set; }
        public (string Url, string Name)? AddServerPrompt { get; set; }

        public void SetPtt(bool pressed) => Ptt = pressed;
        public void NotifyProcessAudioFailed(string origin, string error) => AudioFailedOrigin = origin;
        public void ShowCopyTextModal(string text) => CopyText = text;
        public void PostCredentialsToFrame(string origin, string? identity, string? password)
            => CredsPosted = (origin, identity, password);
        public void RespondWithCurrentBitrate() => BitrateResponded = true;
        public void ShowAddServerConfirmModal(string url, string name) => AddServerPrompt = (url, name);
    }

    private static (MessageRouter router, FakeActions actions) Make(
        List<SavedServer>? servers = null,
        Func<string, (string, string)?>? getCreds = null)
    {
        var actions = new FakeActions();
        servers ??= new List<SavedServer> { new() { Id = "a", Url = "https://chat.example.com" } };
        var router = new MessageRouter(actions,
            getServers: () => servers,
            getCredentials: getCreds ?? (_ => null),
            saveCredentials: (o, i, p) => { },
            clearCredentials: _ => { },
            startProcessAudio: _ => true,
            stopProcessAudio: () => { },
            logRtcStats: _ => { });
        return (router, actions);
    }

    private static WebMessage Msg(string json, string origin = "https://chat.example.com")
        => WebMessage.Parse(json, origin)!.Value;

    [Fact]
    public void Ptt_TogglesPressed()
    {
        var (router, actions) = Make();
        Assert.True(router.Route(Msg("""{"type":"sharkord-ptt","pressed":true}""")));
        Assert.True(actions.Ptt);
        Assert.True(router.Route(Msg("""{"type":"sharkord-ptt","pressed":false}""")));
        Assert.False(actions.Ptt);
    }

    [Fact]
    public void Ptt_MissingPressed_ReturnsFalse()
    {
        var (router, _) = Make();
        Assert.False(router.Route(Msg("""{"type":"sharkord-ptt"}""")));
    }

    [Fact]
    public void StartProcessAudio_InvokesCapture()
    {
        var started = 0;
        var actions = new FakeActions();
        var router = new MessageRouter(actions, () => new(), _ => null,
            (_, _, _) => { }, _ => { }, pid => { started = pid; return true; }, () => { }, _ => { });
        Assert.True(router.Route(Msg("""{"type":"sharkord-start-process-audio","pid":1234}""")));
        Assert.Equal(1234, started);
    }

    [Fact]
    public void StartProcessAudio_NotifiesOnFailure()
    {
        var actions = new FakeActions();
        var router = new MessageRouter(actions, () => new(), _ => null,
            (_, _, _) => { }, _ => { }, _ => false, () => { }, _ => { });
        Assert.True(router.Route(Msg("""{"type":"sharkord-start-process-audio","pid":1234}""")));
        Assert.Equal("https://chat.example.com", actions.AudioFailedOrigin);
    }

    [Fact]
    public void StartProcessAudio_InvalidPid_NotHandled()
    {
        var (router, _) = Make();
        Assert.False(router.Route(Msg("""{"type":"sharkord-start-process-audio","pid":0}""")));
        Assert.False(router.Route(Msg("""{"type":"sharkord-start-process-audio"}""")));
    }

    [Fact]
    public void StopProcessAudio_Handled()
    {
        var stopped = false;
        var actions = new FakeActions();
        var router = new MessageRouter(actions, () => new(), _ => null,
            (_, _, _) => { }, _ => { }, _ => true, () => stopped = true, _ => { });
        Assert.True(router.Route(Msg("""{"type":"sharkord-stop-process-audio"}""")));
        Assert.True(stopped);
    }

    [Fact]
    public void RtcStats_Handled()
    {
        var logged = "";
        var actions = new FakeActions();
        var router = new MessageRouter(actions, () => new(), _ => null,
            (_, _, _) => { }, _ => { }, _ => true, () => { }, s => logged = s);
        Assert.True(router.Route(Msg("""{"type":"sharkord-rtc-stats","report":{"bitrate":1000}}""")));
        Assert.Contains("bitrate", logged);
    }

    [Fact]
    public void CopyToClipboard_Handled()
    {
        var (router, actions) = Make();
        Assert.True(router.Route(Msg("""{"type":"sharkord-copy-to-clipboard","text":"hello"}""")));
        Assert.Equal("hello", actions.CopyText);
    }

    [Fact]
    public void SaveCredentials_OnlyForKnownOrigin()
    {
        var savedTo = "";
        var actions = new FakeActions();
        var router = new MessageRouter(actions,
            () => new() { new() { Id = "a", Url = "https://chat.example.com" } },
            _ => null,
            (o, i, p) => savedTo = o, _ => { }, _ => true, () => { }, _ => { });
        Assert.True(router.Route(Msg("""{"type":"sharkord-save-credentials","identity":"alice","password":"pw"}""")));
        Assert.Equal("https://chat.example.com", savedTo);
        // unknown origin → not saved
        Assert.True(router.Route(Msg("""{"type":"sharkord-save-credentials","identity":"x","password":"y"}""", "https://evil.example.com")));
    }

    [Fact]
    public void ClearCredentials_Handled()
    {
        var cleared = "";
        var actions = new FakeActions();
        var router = new MessageRouter(actions, () => new(), _ => null,
            (_, _, _) => { }, o => cleared = o, _ => true, () => { }, _ => { });
        Assert.True(router.Route(Msg("""{"type":"sharkord-clear-credentials"}""")));
        Assert.Equal("https://chat.example.com", cleared);
    }

    [Fact]
    public void RequestCredentials_PostsCredsBack()
    {
        var (router, actions) = Make(getCreds: _ => ("alice", "pw"));
        Assert.True(router.Route(Msg("""{"type":"sharkord-request-credentials"}""")));
        Assert.Equal(("https://chat.example.com", "alice", "pw"), actions.CredsPosted);
    }

    [Fact]
    public void RequestCredentials_UnknownOrigin_DoesNotPost()
    {
        var (router, actions) = Make(getCreds: _ => ("alice", "pw"));
        Assert.True(router.Route(Msg("""{"type":"sharkord-request-credentials"}""", "https://evil.example.com")));
        Assert.Null(actions.CredsPosted);
    }

    [Fact]
    public void RequestBitrate_Responds()
    {
        var (router, actions) = Make();
        Assert.True(router.Route(Msg("""{"type":"sharkord-request-bitrate"}""")));
        Assert.True(actions.BitrateResponded);
    }

    [Fact]
    public void AddServerFromCommunity_Handled()
    {
        var (router, actions) = Make();
        Assert.True(router.Route(Msg("""{"type":"sharkord-add-server","url":"https://new.example.com","name":"New"}""")));
        Assert.Equal(("https://new.example.com", "New"), actions.AddServerPrompt);
    }

    [Fact]
    public void UnknownType_NotHandled()
    {
        var (router, _) = Make();
        Assert.False(router.Route(Msg("""{"type":"something-else"}""")));
    }

    [Fact]
    public void Parse_InvalidJson_ReturnsNull()
    {
        Assert.Null(WebMessage.Parse("not json", "https://x"));
        Assert.Null(WebMessage.Parse("", "https://x"));
        Assert.Null(WebMessage.Parse("""{"noType":1}""", "https://x"));
    }
}
