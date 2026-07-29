using System.Windows;
using System.Windows.Controls;

namespace Sharkov.App;

/// <summary>A simple modal input dialog for "Add server" and other prompts. Returns the
/// entered text, or null if cancelled.</summary>
public static class PromptDialog
{
    public static string? Show(Window owner, string title, string label, string defaultValue = "")
    {
        var dlg = new Window
        {
            Title = title,
            Width = 400,
            Height = 160,
            Owner = owner,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            ResizeMode = ResizeMode.NoResize,
            Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x1a, 0x1a, 0x1a))
        };
        var panel = new StackPanel { Margin = new Thickness(16) };
        var lbl = new TextBlock { Text = label, Foreground = System.Windows.Media.Brushes.White, Margin = new Thickness(0, 0, 0, 4) };
        var input = new TextBox { Text = defaultValue, Foreground = System.Windows.Media.Brushes.White, Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x27, 0x27, 0x2a)), BorderBrush = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x3f, 0x3f, 0x46)), Padding = new Thickness(4) };
        input.SelectAll();
        var btns = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 12, 0, 0) };
        var ok = new Button { Content = "OK", Width = 80, Margin = new Thickness(4, 0, 0, 0) };
        var cancel = new Button { Content = "Cancel", Width = 80, Margin = new Thickness(4, 0, 0, 0) };
        btns.Children.Add(ok); btns.Children.Add(cancel);
        panel.Children.Add(lbl); panel.Children.Add(input); panel.Children.Add(btns);
        dlg.Content = panel;

        string? result = null;
        ok.Click += (_, _) => { result = input.Text; dlg.DialogResult = true; dlg.Close(); };
        cancel.Click += (_, _) => { dlg.DialogResult = false; dlg.Close(); };
        input.KeyDown += (_, e) =>
        {
            if (e.Key == System.Windows.Input.Key.Enter) { result = input.Text; dlg.DialogResult = true; dlg.Close(); }
            if (e.Key == System.Windows.Input.Key.Escape) { dlg.DialogResult = false; dlg.Close(); }
        };

        dlg.ShowDialog();
        return result;
    }
}
