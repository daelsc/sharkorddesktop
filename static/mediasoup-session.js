// Shared tRPC + mediasoup-client session bootstrap for the self-test/inspect harnesses.
// Previously copy-pasted across static/selftest-live.js, static/selftest-bitrate.js, and
// scripts/inspect-streams.js — a server API change had to be re-applied in 3 places.
//
// Usage:
//   const s = await createServerSession({ host, token, channelId });
//   // s.trpc, s.wsClient, s.device, s.routerRtpCapabilities
//   // s.leave() closes the voice channel (does not close wsClient; caller does)
//
// All harnesses run in an Electron renderer with nodeIntegration, so require() works.
const { createTRPCProxyClient, wsLink, createWSClient } = require('@trpc/client');
const mediasoupClient = require('mediasoup-client');

async function createServerSession({ host, token, channelId }) {
  const wsUrl = 'wss://' + host;
  const wsClient = createWSClient({ url: wsUrl, connectionParams: async () => ({ token }) });
  const trpc = createTRPCProxyClient({ links: [wsLink({ client: wsClient })] });

  // 1. handshake + joinServer
  const hs = await trpc.others.handshake.query();
  await trpc.others.joinServer.query({ handshakeHash: hs.handshakeHash });

  // 2. join the voice channel + load the router capabilities into a Device
  const { routerRtpCapabilities } = await trpc.voice.join.mutate({ channelId, state: {} });
  const device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities });

  return { trpc, wsClient, device, routerRtpCapabilities };
}

/** Create a SEND transport wired to call connectProducerTransport/connectProducer on connect. */
async function createSendTransport(session, transportParams) {
  const transport = session.device.createSendTransport(transportParams);
  transport.on('connect', ({ dtlsParameters }, cb, eb) => {
    session.trpc.voice.connectProducerTransport.mutate({ dtlsParameters }).then(cb).catch(eb);
  });
  return transport;
}

/** Create a RECV transport wired to call connectConsumerTransport on connect. */
async function createRecvTransport(session, transportParams) {
  const transport = session.device.createRecvTransport(transportParams);
  transport.on('connect', ({ dtlsParameters }, cb, eb) => {
    session.trpc.voice.connectConsumerTransport.mutate({ dtlsParameters }).then(cb).catch(eb);
  });
  return transport;
}

/** Standard 3-layer simulcast encodings (low/mid/high) used by the harnesses. */
const SIMULCAST_ENCODINGS = [
  { rid: 'low', scaleResolutionDownBy: 4, maxBitrate: 300000, maxFramerate: 30, scalabilityMode: 'L1T3', active: true },
  { rid: 'mid', scaleResolutionDownBy: 2, maxBitrate: 800000, maxFramerate: 30, scalabilityMode: 'L1T3', active: true },
  { rid: 'high', scaleResolutionDownBy: 1, maxBitrate: 4000000, maxFramerate: 30, scalabilityMode: 'L1T3', active: true }
];

const QUALITY_LAYERS = [
  { spatialLayer: 0, label: 'Low' },
  { spatialLayer: 1, label: 'Medium' },
  { spatialLayer: 2, label: 'High' }
];

module.exports = { createServerSession, createSendTransport, createRecvTransport, SIMULCAST_ENCODINGS, QUALITY_LAYERS };
