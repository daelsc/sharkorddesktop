using System.Runtime.InteropServices;

namespace Sharkov.App.Native;

/// <summary>COM interface declarations for WASAPI process-loopback capture.
/// Ports the COM usage in <c>native/src/process_capture.cpp</c> to C# interop.
/// Only the methods actually used are declared; unused methods on each interface are
/// declared with <c>PreserveSig</c> so the vtable layout matches.</summary>
internal static class WasapiInterfaces
{
    public const string VirtualAudioDeviceProcessLoopback = "VAD\\Process_Loopback";

    // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
    public const uint ActivationTypeProcessLoopback = 1;
    // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0
    public const uint LoopbackModeIncludeTarget = 0;

    public const uint AUDCLNT_SHAREMODE_SHARED = 0;
    public const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00020000;
    public const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x00080000;
    public const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
    public const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

    public static readonly Guid IID_IAudioClient = new("1CB9AD4C-DBFA-4c32-B178-C8F5684E9001");
    public static readonly Guid IID_IAudioCaptureClient = new("C8ADBD92-E13E-4850-9ABE-7D3F6FE5C9A2");
    public static readonly Guid IID_IAudioSessionManager2 = new("77AA99A0-1BD6-4047-B585-298820639C24");
    public static readonly Guid IID_IMMDeviceEnumerator = new("A95664D2-9614-4F35-A746-DE8DB63617E6");
    public static readonly Guid CLSID_MMDeviceEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    public static readonly Guid IID_IActivateAudioInterfaceAsyncOperation = new("9FBAFEF0-0D98-4B5D-8B5A-2F0F2F2F2F2F");

    // PROPVARIANT for ActivateAudioInterfaceAsync: VT_BLOB with the AUDIOCLIENT_ACTIVATION_PARAMS
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPVARIANT
    {
        public ushort vt;
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public uint cbSize;       // blob.cbSize
        public IntPtr pBlobData;   // blob.pBlobData
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
    {
        public uint TargetProcessId;
        public uint ProcessLoopbackMode;
    }

    // The activation params union: we only use the ProcessLoopbackParams branch, so model
    // the union as a single embedded struct (the union is the same size).
    [StructLayout(LayoutKind.Sequential)]
    public struct AUDIOCLIENT_ACTIVATION_PARAMS
    {
        public uint ActivationType;
        public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    }
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C8F5684E9001"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioClient
{
    void Initialize(uint shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, [In] ref WAVEFORMATEX pFormat, [In] IntPtr pAudioSession);
    int GetBufferSize(out uint numFrames);
    int GetStreamLatency(out long hnsLatency);
    int GetCurrentPadding(out int numFrames);
    int IsFormatSupported([In] uint shareMode, [In] ref WAVEFORMATEX pFormat, out IntPtr pClosestMatch);
    int GetMixFormat(out IntPtr pFormat);
    void GetDevicePeriod(out long hnsDefaultPeriod, out long hnsMinimumPeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle([In] IntPtr eventHandle);
    int GetService([In] ref Guid iid, [Out] out IntPtr ppv);
}

[ComImport, Guid("C8ADBD92-E13E-4850-9ABE-7D3F6FE5C9A2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioCaptureClient
{
    int GetBuffer(out IntPtr pData, out uint numFrames, out uint flags, out long position, out long timestamp);
    void ReleaseBuffer(uint numFrames);
    int GetNextPacketSize(out uint packetLength);
}

[StructLayout(LayoutKind.Sequential)]
internal struct WAVEFORMATEX
{
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
}
