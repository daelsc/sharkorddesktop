using System.Reflection;
using Sharkov.App.Native;

namespace Sharkov.Tests.Native;

/// <summary>Tests for the WASAPI capture's resampler + format conversion (pure math,
/// no COM). Uses reflection to invoke the private methods so the capture class can stay
/// sealed without extra public test hooks.</summary>
public class ProcessAudioCaptureResamplerTests
{
    private static float[] Resample(float[] input, uint srcRate, uint dstRate)
    {
        var cap = new ProcessAudioCapture(0, _ => { });
        var mi = typeof(ProcessAudioCapture).GetMethod("ResampleStereo",
            BindingFlags.NonPublic | BindingFlags.Instance)!;
        return (float[])mi.Invoke(cap, new object[] { input, srcRate, dstRate })!;
    }

    [Fact]
    public void SameRate_ReturnsInputUnchanged()
    {
        var input = new float[] { 0.1f, 0.2f, 0.3f, 0.4f };
        Assert.Equal(input, Resample(input, 48000, 48000));
    }

    [Fact]
    public void EmptyInput_ReturnsEmpty()
    {
        Assert.Empty(Resample(Array.Empty<float>(), 48000, 44100));
    }

    [Fact]
    public void Downsample_ProducesFewerFrames()
    {
        // 4 frames stereo at 48000 → 24000 (2:1) ⇒ ~2 frames out
        var input = new float[] { 1f, 1f, 0.5f, 0.5f, 0f, 0f, -0.5f, -0.5f };
        var out_ = Resample(input, 48000, 24000);
        Assert.True(out_.Length >= 4 && out_.Length <= 6); // ~2 frames stereo ±1
        Assert.True(out_.Length % 2 == 0); // stereo
    }

    [Fact]
    public void Upsample_ProducesMoreFrames()
    {
        // 2 frames stereo at 24000 → 48000 (1:2) ⇒ ~4 frames out
        var input = new float[] { 1f, 1f, -1f, -1f };
        var out_ = Resample(input, 24000, 48000);
        Assert.True(out_.Length >= 6); // at least ~3 frames
        Assert.True(out_.Length % 2 == 0); // stereo
    }

    [Fact]
    public void OutputIsStereo()
    {
        var input = new float[] { 0.5f, 0.5f, 0.25f, 0.25f, 0f, 0f };
        var out_ = Resample(input, 48000, 32000);
        Assert.True(out_.Length % 2 == 0);
    }
}
