using System.Text.Json.Serialization;

namespace Sharkov.App.Models;

/// <summary>A saved Sharkord server tab. Mirrors the Electron <c>SavedServer</c>.
/// Record so credential updates can use <c>with</c> cloning without mutating the list entry.</summary>
public sealed record SavedServer
{
    public string Id { get; set; } = string.Empty;
    public string Url { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;

    public string? Icon { get; set; }
    public bool KeepConnected { get; set; }

    /// <summary>Plaintext identity (username). Only present when credentials are saved for this server.</summary>
    public string? Identity { get; set; }

    /// <summary>Base64 ciphertext of the password, encrypted with DPAPI. Never plaintext at rest.</summary>
    public string? Password { get; set; }
}

/// <summary>Per-device preferences applied to the injected WebRTC / getUserMedia / PTT stack.</summary>
public sealed record DevicePreferences
{
    public string? AudioInput { get; set; }
    public string? VideoInput { get; set; }
    public string? AudioInputLabel { get; set; }
    public string? VideoInputLabel { get; set; }
    public int? AudioInputVolume { get; set; }

    /// <summary>PTT binding e.g. "KeyP", "Mouse4". <c>null</c> = no PTT.</summary>
    public string? PttBinding { get; set; }

    /// <summary>Forced video bitrate in kbps. 0 / null = Auto (let the bandwidth estimator decide).</summary>
    public int? VideoBitrate { get; set; }

    /// <summary>Preferred video codec: "H264" (default), "VP8", "VP9", "AV1", or "AUTO".</summary>
    public string? VideoCodec { get; set; }
}

/// <summary>The on-disk config file. Mirrors <c>electron-store</c> keys: serverUrl + savedServers + devicePreferences.</summary>
public sealed class AppConfig
{
    [JsonPropertyName("serverUrl")]
    public string ServerUrl { get; set; } = AppDefaults.DefaultServerUrl;

    [JsonPropertyName("savedServers")]
    public string SavedServersJson { get; set; } = "[]";

    [JsonPropertyName("devicePreferences")]
    public string DevicePreferencesJson { get; set; } = "{}";
}

public static class AppDefaults
{
    public const string DefaultServerUrl = "https://demo.sharkord.com";
}
