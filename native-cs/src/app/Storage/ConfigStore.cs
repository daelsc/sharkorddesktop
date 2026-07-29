using System.IO;
using System.Text.Json;
using Sharkov.App.Models;

namespace Sharkov.App.Storage;

/// <summary>Persists <see cref="AppConfig"/> as JSON in <c>%APPDATA%\Sharkov\config.json</c>.</summary>
public sealed class ConfigStore
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true
    };

    private readonly string _path;

    public ConfigStore(string? path = null)
    {
        _path = path ?? DefaultPath();
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
    }

    public static string DefaultPath()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return Path.Combine(appData, "Sharkov", "config.json");
    }

    /// <summary>Loads the config, or creates defaults if missing/corrupt.</summary>
    public AppConfig Load()
    {
        if (!File.Exists(_path)) return new AppConfig();
        try
        {
            var json = File.ReadAllText(_path);
            var cfg = JsonSerializer.Deserialize<AppConfig>(json, JsonOpts);
            return cfg ?? new AppConfig();
        }
        catch
        {
            // Corrupt config — fall back to defaults rather than crashing the app.
            return new AppConfig();
        }
    }

    public void Save(AppConfig config)
    {
        var dir = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        var json = JsonSerializer.Serialize(config, JsonOpts);
        File.WriteAllText(_path, json);
    }

    // ---- typed accessors that read/write the JSON-encoded sub-keys ----

    public List<SavedServer> GetSavedServers()
    {
        var raw = Load().SavedServersJson;
        return string.IsNullOrEmpty(raw)
            ? new List<SavedServer>()
            : JsonSerializer.Deserialize<List<SavedServer>>(raw) ?? new List<SavedServer>();
    }

    public void SetSavedServers(IEnumerable<SavedServer> servers)
    {
        var cfg = Load();
        cfg.SavedServersJson = JsonSerializer.Serialize(servers, JsonOpts);
        Save(cfg);
    }

    public DevicePreferences GetDevicePreferences()
    {
        var raw = Load().DevicePreferencesJson;
        return string.IsNullOrEmpty(raw)
            ? new DevicePreferences()
            : JsonSerializer.Deserialize<DevicePreferences>(raw) ?? new DevicePreferences();
    }

    public void SetDevicePreferences(DevicePreferences prefs)
    {
        var cfg = Load();
        cfg.DevicePreferencesJson = JsonSerializer.Serialize(prefs, JsonOpts);
        Save(cfg);
    }

    public string GetServerUrl()
    {
        var url = (Load().ServerUrl ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(url)) return AppDefaults.DefaultServerUrl;
        return url.StartsWith("http://") || url.StartsWith("https://")
            ? url
            : $"https://{url}";
    }

    public void SetServerUrl(string url)
    {
        var normalized = (url ?? string.Empty).Trim();
        var withProtocol = string.IsNullOrEmpty(normalized) || normalized.StartsWith("http://") || normalized.StartsWith("https://")
            ? normalized
            : $"https://{normalized}";
        var cfg = Load();
        cfg.ServerUrl = string.IsNullOrEmpty(withProtocol) ? AppDefaults.DefaultServerUrl : withProtocol;
        Save(cfg);
    }

    /// <summary>Helper: parse an origin (scheme + host + port) string, returning null if not a valid URL.
    /// Equivalent to the JS <c>new URL(url).origin</c> used throughout the Electron app.</summary>
    public static string? OriginOf(string url)
    {
        try
        {
            var u = new Uri(url);
            // Normalize: drop default ports so https://host:443 == https://host.
            return u.IsDefaultPort ? $"{u.Scheme}://{u.Host}" : $"{u.Scheme}://{u.Host}:{u.Port}";
        }
        catch { return null; }
    }
}
