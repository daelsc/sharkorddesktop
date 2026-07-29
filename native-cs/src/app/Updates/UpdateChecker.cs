using System.Windows;
using Velopack;
using Velopack.Sources;

namespace Sharkov.App.Updates;

/// <summary>Checks GitHub Releases for a new version on startup, downloads it in the
/// background, and prompts the user to restart. Ports the Electron app's
/// <c>electron-updater</c> flow (update-downloaded → "Restart Now / Later" dialog) to
/// the native client. Velopack handles the installer + delta payloads; this just wires
/// the check/download/apply + the prompt.</summary>
public static class UpdateChecker
{
    /// <summary>The GitHub repository hosting releases. Must match the --repoUrl passed
    /// to <c>vpk upload github</c> in CI. The built-in GITHUB_TOKEN in CI has permission
    /// to read public releases, so the client needs no token for a public repo.</summary>
    private const string RepoUrl = "https://github.com/daelsc/sharkov-desktop";

    /// <summary>Check for an update on startup. No-op if running un-packaged (dev / dotnet run)
    /// — Velopack only has an update context when the app was installed by its Setup.exe.
    /// Catches all errors so a broken update check never blocks app startup.</summary>
    /// <param name="overrideSourcePath">If set (e.g. via the SHARKOV_UPDATE_SOURCE env var),
    /// checks a local folder instead of GitHub — used for testing the update flow without a
    /// GitHub round-trip. Production reads from <see cref="RepoUrl"/>.</param>
    public static async Task CheckForUpdateAsync(string? overrideSourcePath = null)
    {
        try
        {
            UpdateManager mgr;
            if (!string.IsNullOrEmpty(overrideSourcePath))
            {
                // Local folder source (testing). new UpdateManager(path) accepts a dir.
                mgr = new UpdateManager(overrideSourcePath);
            }
            else
            {
                // Stable channel only (no prereleases). Matches the Electron app's
                // releaseType: release behavior.
                mgr = new UpdateManager(new GithubSource(RepoUrl, accessToken: null, prerelease: false));
            }

            if (!mgr.IsInstalled)
            {
                // Not installed via Setup.exe (e.g. `dotnet run` in dev) — no update context.
                return;
            }

            var newVersion = await mgr.CheckForUpdatesAsync();
            if (newVersion is null) return; // up to date

            // Download in the background (silent); the user is only prompted once it's ready.
            await mgr.DownloadUpdatesAsync(newVersion);

            // Prompt — matches the Electron app's "Restart Now / Later" dialog text.
            var result = MessageBox.Show(
                $"Version {newVersion.TargetFullRelease.Version} has been downloaded. " +
                "It will be installed when you quit the app.",
                "Update Ready",
                MessageBoxButton.OKCancel,
                MessageBoxImage.Information);

            if (result == MessageBoxResult.OK)
            {
                // Apply the update and relaunch into the new version.
                mgr.ApplyUpdatesAndRestart(newVersion);
            }
            // If the user picks Later, Velopack applies the update on next app exit
            // (mgr.WaitExitThenApplyUpdates is wired by VelopackApp.Build().Run()).
        }
        catch
        {
            // Update checks must never crash the app. Fail silently.
        }
    }
}

