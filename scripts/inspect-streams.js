// Inspect what each user in a voice channel is offering (producer codecs/layers).
// Joins a channel, lists remote producers, consumes each video+screen producer,
// and dumps the consumer rtpParameters (codec, scalability, encodings) + qualityLayers.
const { ipcRenderer } = require('electron');
const { createServerSession, createRecvTransport } = require('../static/mediasoup-session.js');

const CFG = window.__CFG || {
  host: process.argv[2] || 'sharkord.thesemite.com',
  token: process.argv[3] || '',
  channel: parseInt(process.argv[4] || '3', 10)
};
if (!CFG.token) { console.error('usage: needs token'); }
function logToDom(m){const el=document.getElementById('log');if(el){const d=document.createElement('div');d.textContent=m;el.appendChild(d);}}
const wsUrl = 'wss://' + CFG.host;
let ws, client, closeClient;
let device;

function log(m) { console.log('[inspect] ' + m); logToDom('[inspect] ' + m); }

(async () => {
  const session = await createServerSession({ host: CFG.host, token: CFG.token, channelId: CFG.channel });
  log('connecting tRPC ws -> ' + wsUrl);
  closeClient = session.wsClient;
  client = session.trpc;
  device = session.device;
  log('joined server, joining voice channel ' + CFG.channel);
  log('got routerRtpCapabilities, codecs: ' + session.routerRtpCapabilities.codecs.map(c => c.mimeType).join(', '));

  // Create a consumer transport (needed to consume)
  const consumerTransportParams = await client.voice.createConsumerTransport.mutate({});
  const consumerTransport = await createRecvTransport(session, consumerTransportParams);

  // List remote producers
  const remotes = await client.voice.getProducers.query();
  log('remote producers: ' + JSON.stringify(remotes));

  const rtpCaps = device.rtpCapabilities;
  const SAMPLE_MS = 5000; // how long to poll each consumer for live bitrate

  function fmtBytes(b){ if(!b) return '0'; if(b<1024) return b+'B'; if(b<1048576) return (b/1024).toFixed(1)+'KB'; return (b/1048576).toFixed(2)+'MB'; }
  function fmtKbps(bps){ return Math.round(bps/1000)+'kbps'; }

  async function inspectKind(kind, ids) {
    for (const remoteId of ids) {
      try {
        // Server-side consume -> returns the consumer's rtpParameters (static config)
        const res = await client.voice.consume.mutate({ kind, remoteId, rtpCapabilities: rtpCaps });
        const codec = res.consumerRtpParameters.codecs && res.consumerRtpParameters.codecs[0];
        const encs = (res.consumerRtpParameters.encodings || []).map(e => ({
          rid: e.rid, scalabilityMode: e.scalabilityMode,
          maxBitrate: e.maxBitrate, ssrc: e.ssrc,
          spatialLayers: e.spatialLayers, temporalLayers: e.temporalLayers
        }));
        log('--- ' + kind + ' from userId ' + remoteId + ' (type=' + res.consumerType + ') ---');
        log('  codec: ' + (codec ? codec.mimeType + ' (clock ' + codec.clockRate + ')' : 'none'));
        log('  encodings (' + encs.length + '): ' + JSON.stringify(encs));
        log('  qualityLayers (server): ' + JSON.stringify(res.qualityLayers));

        // Create a LOCAL consumer so we actually receive the stream and can poll
        // getStats() for LIVE bitrate + frame dimensions.
        let localConsumer = null;
        try {
          localConsumer = await consumerTransport.consume({
            id: res.consumerId,
            producerId: res.producerId,
            // mediasoup-client only accepts 'video'/'audio' as the track kind; a
            // 'screen' producer is still a video track on the wire.
            kind: (res.consumerKind === 'screen' || res.consumerKind === 'video') ? 'video' : 'audio',
            rtpParameters: res.consumerRtpParameters
          });
        } catch (ce) {
          log('  (local consume failed, no live stats: ' + ce.message + ')');
        }
        if (localConsumer) {
          // poll getStats over SAMPLE_MS to compute a live bitrate delta
          const t0 = Date.now();
          let prev = null;
          let live = null;
          for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, SAMPLE_MS / 5));
            try {
              const st = await localConsumer.getStats();
              st.forEach(s => {
                if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video' || s.kind === 'audio' || s.mediaType === 'audio')) {
                  if (prev) {
                    const dt = (s.timestamp - prev.ts) / 1000;
                    if (dt > 0) {
                      const bps = 8 * (s.bytesReceived - prev.bytes) / dt;
                      live = {
                        bitrate: Math.round(bps),
                        framesDecoded: s.framesDecoded || 0,
                        width: s.frameWidth || 0, height: s.frameHeight || 0,
                        fps: s.framesPerSecond || 0,
                        keyFrames: s.keyFramesDecoded || 0,
                        jitter: s.jitter || 0, packetsLost: s.packetsLost || 0
                      };
                    }
                  }
                  prev = { ts: s.timestamp, bytes: s.bytesReceived };
                }
              });
            } catch (e) {}
          }
          if (live) {
            log('  LIVE: ' + fmtKbps(live.bitrate) + ' | ' + live.width + 'x' + live.height +
                ' | ' + live.fps + 'fps | framesDecoded=' + live.framesDecoded +
                ' | keyFrames=' + live.keyFrames + ' | lost=' + live.packetsLost + ' | jitter=' + (live.jitter*1000).toFixed(1) + 'ms');
          } else {
            log('  LIVE: no inbound-rtp stats yet (stream may be paused or not sending)');
          }
          try { localConsumer.close(); } catch (e) {}
        }
        log('');
      } catch (e) {
        log('  ' + kind + ' userId ' + remoteId + ' consume failed: ' + e.message);
      }
    }
  }

  await inspectKind('video', remotes.remoteVideoIds || []);
  await inspectKind('screen', remotes.remoteScreenIds || []);
  if ((remotes.remoteAudioIds || []).length) log('audio producers (microphone) from userIds: ' + remotes.remoteAudioIds.join(','));
  if ((remotes.remoteScreenAudioIds || []).length) log('screen-audio producers from userIds: ' + remotes.remoteScreenAudioIds.join(','));

  try { await client.voice.leave.mutate({}); } catch (e) {}
  closeClient.close();
  log('DONE');
  // report back to main via IPC if present
  try { ipcRenderer && ipcRenderer.send('inspect-done'); } catch(e){}
  setTimeout(()=>process.exit(0), 500);
})().catch(e => { 
  const detail = e && (e.message || e.name || (typeof e === 'object' ? JSON.stringify(e) : String(e)));
  console.error('[inspect] FATAL: ' + detail); 
  if (e && e.stack) console.error('[inspect] stack: ' + e.stack); 
  try { closeClient && closeClient.close(); } catch(_){} 
  try { ipcRenderer && ipcRenderer.send('inspect-done'); } catch(_){}
  setTimeout(()=>process.exit(1), 500); 
});
