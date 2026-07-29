using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Sharkov.App.Models;

namespace Sharkov.App.Storage;

/// <summary>
/// Saves / loads / clears per-server login credentials with DPAPI encryption at rest.
/// Mirrors <c>src/credentials.ts</c> (which wraps Electron <c>safeStorage</c> / DPAPI).
/// Passwords are encrypted with <see cref="ProtectedData"/> (CurrentUser scope) and
/// base64-encoded; plaintext is never written to disk. If DPAPI is unavailable on
/// the current platform, credential storage is refused (credentials are not saved).
/// </summary>
public interface ICredentialCrypto
{
    /// <summary>Encrypt plaintext to a base64 ciphertext string.</summary>
    string Encrypt(string plaintext);
    /// <summary>Decrypt a base64 ciphertext back to plaintext.</summary>
    string Decrypt(string cipher);
    /// <summary>True when OS-keyring encryption is available.</summary>
    bool IsAvailable { get; }
}

/// <summary>DPAPI-backed credential crypto (Windows CurrentUser scope).</summary>
public sealed class DpapiCredentialCrypto : ICredentialCrypto
{
    public bool IsAvailable => OperatingSystem.IsWindows();

    public string Encrypt(string plaintext)
    {
        var bytes = Encoding.UTF8.GetBytes(plaintext);
        var cipher = ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(cipher);
    }

    public string Decrypt(string cipher)
    {
        var cipherBytes = Convert.FromBase64String(cipher);
        var plain = ProtectedData.Unprotect(cipherBytes, null, DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(plain);
    }
}

/// <summary>
/// Credential storage operations, ported 1:1 from <c>credentials.ts</c>.
/// Never auto-creates a server entry — credentials are only stored for origins
/// that already appear in the saved-server list.
/// </summary>
public sealed class CredentialService
{
    private readonly ICredentialCrypto _crypto;

    public CredentialService(ICredentialCrypto crypto) => _crypto = crypto;

    public static SavedServer? FindServerByOrigin(IEnumerable<SavedServer> servers, string origin)
    {
        return servers.FirstOrDefault(s => ConfigStore.OriginOf(s.Url) == origin);
    }

    /// <summary>Encrypt and store credentials for the server matching <paramref name="origin"/>.
    /// No-op if no saved server matches (never auto-creates an entry).</summary>
    public List<SavedServer> SaveCredentials(
        List<SavedServer> servers, string origin, string identity, string password)
    {
        if (!_crypto.IsAvailable) return servers;
        var idx = servers.FindIndex(s => ConfigStore.OriginOf(s.Url) == origin);
        if (idx == -1) return servers; // never auto-create a server entry
        var next = servers.ToList();
        next[idx] = next[idx] with
        {
            Identity = identity,
            Password = _crypto.Encrypt(password)
        };
        return next;
    }

    /// <summary>Load and decrypt credentials for the server matching <paramref name="origin"/>.</summary>
    public (string Identity, string Password)? LoadCredentials(
        List<SavedServer> servers, string origin)
    {
        if (!_crypto.IsAvailable) return null;
        var srv = FindServerByOrigin(servers, origin);
        if (srv is null || string.IsNullOrEmpty(srv.Identity) || string.IsNullOrEmpty(srv.Password))
            return null;
        return (srv.Identity, _crypto.Decrypt(srv.Password));
    }

    /// <summary>Clear stored credentials for the server matching <paramref name="origin"/>.</summary>
    public List<SavedServer> ClearCredentials(List<SavedServer> servers, string origin)
    {
        var idx = servers.FindIndex(s => ConfigStore.OriginOf(s.Url) == origin);
        if (idx == -1) return servers;
        var next = servers.ToList();
        next[idx] = next[idx] with { Identity = null, Password = null };
        return next;
    }
}

/// <summary>A no-op crypto used on non-Windows and in tests where DPAPI is unavailable.
/// Refuses to store — <see cref="IsAvailable"/> is false.</summary>
public sealed class NullCredentialCrypto : ICredentialCrypto
{
    public bool IsAvailable => false;
    public string Encrypt(string plaintext) => throw new InvalidOperationException("credential crypto unavailable");
    public string Decrypt(string cipher) => throw new InvalidOperationException("credential crypto unavailable");
}
