using Sharkov.App.Models;
using Sharkov.App.Storage;

namespace Sharkov.Tests.Storage;

/// <summary>Deterministic fake crypto: reverse the string as "encryption".
/// Mirrors the fakeCrypto in test/credentials.test.ts.</summary>
internal sealed class FakeCrypto : ICredentialCrypto
{
    public bool IsAvailable => true;
    public string Encrypt(string plaintext) => string.Concat(plaintext.Reverse());
    public string Decrypt(string cipher) => string.Concat(cipher.Reverse());
}

public class CredentialServiceTests
{
    private static List<SavedServer> Servers() => new()
    {
        new SavedServer { Id = "a", Url = "https://chat.example.com" },
        new SavedServer { Id = "b", Url = "https://demo.sharkord.com" }
    };

    [Fact]
    public void FindServerByOrigin_MatchesByOrigin()
    {
        Assert.Equal("a", CredentialService.FindServerByOrigin(Servers(), "https://chat.example.com")!.Id);
    }

    [Fact]
    public void FindServerByOrigin_ReturnsNullWhenNoMatch()
    {
        Assert.Null(CredentialService.FindServerByOrigin(Servers(), "https://nope.example.com"));
    }

    // ---- saveCredentials ----

    [Fact]
    public void SaveCredentials_EncryptsPasswordAndStoresIdentity()
    {
        var svc = new CredentialService(new FakeCrypto());
        var next = svc.SaveCredentials(Servers(), "https://chat.example.com", "alice", "hunter2");
        var srv = next.Single(s => s.Id == "a");
        Assert.Equal("alice", srv.Identity);
        Assert.Equal("2retnuh", srv.Password); // reversed
    }

    [Fact]
    public void SaveCredentials_DoesNotMutateInput()
    {
        var svc = new CredentialService(new FakeCrypto());
        var original = Servers();
        var next = svc.SaveCredentials(original, "https://chat.example.com", "alice", "hunter2");
        Assert.NotSame(original, next);
        Assert.Null(original[0].Identity);
        Assert.Null(original[0].Password);
    }

    [Fact]
    public void SaveCredentials_NoMatch_ReturnsUnchanged()
    {
        var svc = new CredentialService(new FakeCrypto());
        var original = Servers();
        var next = svc.SaveCredentials(original, "https://nope.example.com", "alice", "hunter2");
        Assert.Equal(original, next);
    }

    [Fact]
    public void SaveCredentials_RefusesWhenCryptoUnavailable()
    {
        var svc = new CredentialService(new NullCredentialCrypto());
        var next = svc.SaveCredentials(Servers(), "https://chat.example.com", "alice", "hunter2");
        Assert.Null(next.Single(s => s.Id == "a").Identity); // not stored
    }

    // ---- loadCredentials ----

    [Fact]
    public void LoadCredentials_DecryptsStoredCredentials()
    {
        var svc = new CredentialService(new FakeCrypto());
        var saved = svc.SaveCredentials(Servers(), "https://chat.example.com", "alice", "hunter2");
        var creds = svc.LoadCredentials(saved, "https://chat.example.com");
        Assert.Equal(("alice", "hunter2"), creds);
    }

    [Fact]
    public void LoadCredentials_NoMatch_ReturnsNull()
    {
        var svc = new CredentialService(new FakeCrypto());
        Assert.Null(svc.LoadCredentials(Servers(), "https://nope.example.com"));
    }

    [Fact]
    public void LoadCredentials_MissingIdentityOrPassword_ReturnsNull()
    {
        var svc = new CredentialService(new FakeCrypto());
        Assert.Null(svc.LoadCredentials(Servers(), "https://demo.sharkord.com"));
    }

    // ---- clearCredentials ----

    [Fact]
    public void ClearCredentials_RemovesIdentityAndPassword()
    {
        var svc = new CredentialService(new FakeCrypto());
        var saved = svc.SaveCredentials(Servers(), "https://chat.example.com", "alice", "hunter2");
        var cleared = svc.ClearCredentials(saved, "https://chat.example.com");
        var srv = cleared.Single(s => s.Id == "a");
        Assert.Null(srv.Identity);
        Assert.Null(srv.Password);
    }

    [Fact]
    public void ClearCredentials_DoesNotMutateInput()
    {
        var svc = new CredentialService(new FakeCrypto());
        var saved = svc.SaveCredentials(Servers(), "https://chat.example.com", "alice", "hunter2");
        svc.ClearCredentials(saved, "https://chat.example.com");
        Assert.Equal("alice", saved.Single(s => s.Id == "a").Identity);
    }
}
