using System.Windows;
using Sharkov.App.Updates;
using Velopack;

namespace Sharkov.App;

public partial class App : Application
{
    /// <summary>Custom entry point. VelopackApp.Build().Run() MUST be the very first thing
    /// — before any UI — so it can handle first-install and apply a pending update on
    /// restart (the hook runs, then re-launches the new version). Pattern from Velopack's
    /// CSharpWpf sample: App.xaml is demoted to a Page so the WPF SDK doesn't auto-generate
    /// a competing Main, and StartupObject points here.</summary>
    [STAThread]
    private static void Main(string[] args)
    {
        VelopackApp.Build().Run();
        var app = new App();
        app.InitializeComponent();
        // Check for updates once the app is up (fire-and-forget; UpdateChecker swallows errors).
        // SHARKOV_UPDATE_SOURCE overrides the GitHub source with a local folder (for testing).
        app.Startup += async (_, _) =>
            await UpdateChecker.CheckForUpdateAsync(Environment.GetEnvironmentVariable("SHARKOV_UPDATE_SOURCE"));
        app.Run();
    }
}
