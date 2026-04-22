// ── P2P connection layer ────────────────────────────────────────
//
// Raw WebRTC with signaling via signal.neevs.io.
// Desktop creates a room. Phone joins it via QR code.

var SIGNAL_URL = 'wss://signal.neevs.io';
// Google + Cloudflare STUN for zero-roundtrip local/near-direct paths.
// openrelay.metered.ca is a public, shared TURN relay on generic
// "openrelayproject" credentials. Best-effort uptime, fine for the
// classroom demo. Swap for a private TURN key if quota bites.
// Ports the pattern from aipi540-tabletop-perception/public/webrtc.js.
var ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

var SEND_BUFFER_MAX = 1024 * 1024; // 1MB backpressure threshold
var SEND_QUEUE = [];
var SEND_DRAINING = false;

// ── State ──────────────────────────────────────────────────────

var pc = null;
var dataChannel = null;
var signalWs = null;
var peerCtx = null;
var myPeerId = null;
var myRole = null; // 'desktop' or 'phone'
var pendingIce = []; // ICE candidates received before remote description

// ── Init ───────────────────────────────────────────────────────

function initPeer(myId, ctx) {
  myPeerId = myId;
  peerCtx = ctx;

  // Check if we should connect to a remote peer (phone with ?peer= URL)
  var params = new URLSearchParams(location.search);
  var remotePeer = params.get('peer');

  if (remotePeer) {
    // Phone: join the desktop's room
    myRole = 'phone';
    openSignaling('cw-' + remotePeer.trim(), function () {
      createOffer(ctx);
    });
  } else {
    // Desktop: open own room, wait for connections
    myRole = 'desktop';
    openSignaling('cw-' + myId);
  }
}

// ── Connect (manual pairing via ID input) ──────────────────────

function connectToPeer(remotePeerIdOverride, ctx) {
  var remotePeerId = remotePeerIdOverride || ctx.getRemotePeerId();
  if (!remotePeerId) {
    var el = document.getElementById('manual-peer-mobile');
    remotePeerId = el ? el.value.trim() : '';
  }
  if (!remotePeerId) return;

  myRole = 'phone';
  peerCtx = ctx;
  ctx.setStatus('', 'Connecting...');

  openSignaling('cw-' + remotePeerId, function () {
    createOffer(ctx);
  });
}

// ── Signaling WebSocket ────────────────────────────────────────

var heartbeatTimer = null;

function openSignaling(roomId, onOpen) {
  if (signalWs) { try { signalWs.close(); } catch (_) {} }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

  var url = SIGNAL_URL + '/' + roomId + '/ws';
  console.log('[peer] Opening signaling:', url);
  signalWs = new WebSocket(url);

  signalWs.onopen = function () {
    console.log('[peer] Signaling connected, room:', roomId);
    // Keep WebSocket alive (Cloudflare closes idle connections)
    heartbeatTimer = setInterval(function () {
      if (signalWs && signalWs.readyState === 1) {
        signalWs.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
    if (onOpen) onOpen();
  };

  signalWs.onmessage = function (e) {
    try {
      var msg = JSON.parse(e.data);
      console.log('[peer] WS msg:', msg.type, msg.peer || '', Object.keys(msg.data || msg.peers || {}).join(','));
      if (msg.type === 'signal' && msg.peer !== myRole) {
        handleSignal(msg.data);
      }
      if (msg.type === 'state') {
        var peers = msg.peers || {};
        Object.keys(peers).forEach(function (key) {
          if (key !== myRole) handleSignal(peers[key]);
        });
      }
    } catch (err) { console.warn('[peer] Signal parse error:', err); }
  };

  signalWs.onclose = function () {
    console.warn('[peer] Signaling disconnected');
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    // Only reconnect if we're the desktop (always listening)
    if (myRole === 'desktop') {
      setTimeout(function () { openSignaling(roomId); }, 3000);
    }
  };

  signalWs.onerror = function () {
    console.warn('[peer] Signaling error');
  };
}

function sendSignal(data) {
  if (signalWs && signalWs.readyState === 1) {
    console.log('[peer] sendSignal:', Object.keys(data).join(','));
    signalWs.send(JSON.stringify({ type: 'signal', peer: myRole, data: data }));
  } else {
    console.warn('[peer] sendSignal dropped; WS state=', signalWs && signalWs.readyState);
  }
}

// ── Handle incoming signals ────────────────────────────────────

function handleSignal(data) {
  if (!data) return;

  if (data.offer) {
    console.log('[peer] Received offer');
    createPeerConnection();
    pc.setRemoteDescription(new RTCSessionDescription(data.offer))
      .then(function () {
        // Flush queued ICE candidates
        pendingIce.forEach(function (c) { pc.addIceCandidate(c).catch(function () {}); });
        pendingIce = [];
        // Add local stream
        var stream = peerCtx.getLocalStream();
        if (stream) stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
        return pc.createAnswer();
      })
      .then(function (answer) {
        return pc.setLocalDescription(answer).then(function () {
          sendSignal({ answer: answer });
        });
      })
      .catch(function (err) { console.warn('[peer] Error handling offer:', err); });
  }

  if (data.answer) {
    console.log('[peer] Received answer');
    if (pc) {
      pc.setRemoteDescription(new RTCSessionDescription(data.answer))
        .then(function () {
          pendingIce.forEach(function (c) { pc.addIceCandidate(c).catch(function () {}); });
          pendingIce = [];
        })
        .catch(function (err) { console.warn('[peer] Error setting answer:', err); });
    }
  }

  if (data.ice) {
    var candidate = new RTCIceCandidate(data.ice);
    if (pc && pc.remoteDescription) {
      pc.addIceCandidate(candidate).catch(function () {});
    } else {
      pendingIce.push(candidate);
    }
  }
}

// ── Create RTCPeerConnection ───────────────────────────────────

function createPeerConnection() {
  if (pc) { try { pc.close(); } catch (_) {} }
  pendingIce = [];

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = function (e) {
    if (e.candidate) sendSignal({ ice: e.candidate });
  };

  pc.oniceconnectionstatechange = function () {
    var state = pc.iceConnectionState;
    console.log('[peer] ICE state:', state);
    if (state === 'connected' || state === 'completed') {
      peerCtx.setStatus('ok', 'Connected (P2P)');
    } else if (state === 'failed') {
      // Attempt ICE restart before giving up
      console.warn('[peer] ICE failed, attempting restart');
      peerCtx.setStatus('', 'Reconnecting...');
      pc.restartIce();
      if (myRole === 'phone') {
        pc.createOffer({ iceRestart: true })
          .then(function (offer) {
            return pc.setLocalDescription(offer).then(function () {
              sendSignal({ offer: offer });
            });
          })
          .catch(function () {
            peerCtx.setStatus('err', 'Connection failed');
            peerCtx.hideRemoteFeed();
          });
      }
    } else if (state === 'disconnected') {
      setTimeout(function () {
        if (pc && pc.iceConnectionState === 'disconnected') {
          peerCtx.setStatus('err', 'Connection lost');
          peerCtx.hideRemoteFeed();
        }
      }, 5000);
    }
  };

  pc.ondatachannel = function (e) {
    setupDataChannel(e.channel);
    console.log('[peer] Incoming data channel');
    peerCtx.setStatus('ok', 'Phone connected');
    if (!document.getElementById('screen-live').classList.contains('active')) {
      peerCtx.startApp();
    }
  };

  pc.ontrack = function (e) {
    console.log('[peer] Received remote track');
    document.getElementById('remote-video').srcObject = e.streams[0];
    peerCtx.showRemoteFeed();
    peerCtx.setStatus('ok', 'Connected (P2P)');
  };
}

// ── Create offer (phone initiates) ─────────────────────────────

function createOffer(ctx) {
  // Wait for camera stream before creating offer
  function doOffer() {
    createPeerConnection();

    var channel = pc.createDataChannel('tallyho', { ordered: true });
    setupDataChannel(channel);

    var stream = ctx.getLocalStream();
    if (stream) stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });

    console.log('[peer] createOffer starting; stream=', !!stream);
    pc.createOffer()
      .then(function (offer) {
        return pc.setLocalDescription(offer).then(function () {
          console.log('[peer] offer set as local, sending');
          sendSignal({ offer: offer });
        });
      })
      .catch(function (err) { console.warn('[peer] Error creating offer:', err && err.message); });

    setTimeout(function () {
      if (pc && pc.iceConnectionState === 'new') {
        ctx.setStatus('err', 'Connection timed out');
      }
    }, 15000);
  }

  var stream = ctx.getLocalStream();
  if (stream) {
    doOffer();
  } else {
    // Camera not ready yet. Poll until available.
    console.log('[peer] Waiting for camera...');
    var attempts = 0;
    var wait = setInterval(function () {
      attempts++;
      if (ctx.getLocalStream()) {
        clearInterval(wait);
        doOffer();
      } else if (attempts > 50) { // 10 seconds
        clearInterval(wait);
        console.warn('[peer] Camera not available, connecting without video');
        doOffer();
      }
    }, 200);
  }
}

// ── Data channel ───────────────────────────────────────────────

function setupDataChannel(channel) {
  if (dataChannel) { try { dataChannel.close(); } catch (_) {} }
  dataChannel = channel;
  dataChannel.onopen = function () { console.log('[peer] Data channel open'); };
  dataChannel.onmessage = function (e) {
    try { peerCtx.handlePeerData(JSON.parse(e.data)); } catch (_) {}
  };
  dataChannel.onclose = function () {
    dataChannel = null;
    peerCtx.setStatus('err', 'Phone disconnected');
  };
}

// ── Disconnect ─────────────────────────────────────────────────

function closePeer() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (dataChannel) { try { dataChannel.close(); } catch (_) {} dataChannel = null; }
  if (pc) { try { pc.close(); } catch (_) {} pc = null; }
  if (signalWs) { try { signalWs.close(); } catch (_) {} signalWs = null; }
  pendingIce = [];
  var remoteVid = document.getElementById('remote-video');
  if (remoteVid) remoteVid.srcObject = null;
}

// ── Accessors ──────────────────────────────────────────────────

function getDataConn() {
  return dataChannel && dataChannel.readyState === 'open'
    ? { open: true, send: function (msg) { sendData(msg); } }
    : null;
}

function sendData(msg) {
  if (!dataChannel || dataChannel.readyState !== 'open') return;
  var data = JSON.stringify(msg);
  if (dataChannel.bufferedAmount > SEND_BUFFER_MAX) {
    // Backpressure: queue and drain
    SEND_QUEUE.push(data);
    if (!SEND_DRAINING) {
      SEND_DRAINING = true;
      drainQueue();
    }
    return;
  }
  dataChannel.send(data);
}

function drainQueue() {
  if (!dataChannel || dataChannel.readyState !== 'open' || !SEND_QUEUE.length) {
    SEND_DRAINING = false;
    return;
  }
  if (dataChannel.bufferedAmount < SEND_BUFFER_MAX) {
    dataChannel.send(SEND_QUEUE.shift());
  }
  setTimeout(drainQueue, 50);
}

function isPrivateIp(addr) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fe80:|fd[0-9a-f]{2}:)/.test(addr);
}

function isSameNetwork(a, b) {
  if (/^(10\.|192\.168\.|172\.)/.test(a) && /^(10\.|192\.168\.|172\.)/.test(b)) return true;
  if (a.startsWith('fe80:') && b.startsWith('fe80:')) return true;
  if (a.includes(':') && b.includes(':') && !a.startsWith('fe80:')) {
    return a.split(':').slice(0, 3).join(':') === b.split(':').slice(0, 3).join(':');
  }
  return false;
}

var CONN_DESCRIPTIONS = {
  LAN: 'Same Wi-Fi. Traffic stays on your local network — no internet involved.',
  VPN: 'Through an overlay network (e.g. Tailscale). Traffic crosses the internet inside the overlay tunnel.',
  P2P: 'Direct peer-to-peer over the internet via NAT hole-punching. No third-party relay.',
  relay: 'Routed through a TURN relay server. Both peers send to the server, which forwards to each other.'
};

function classifyPair(local, remote) {
  if (!local || !remote) return 'relay';
  var lt = local.candidateType, rt = remote.candidateType;
  if (lt === 'relay' || rt === 'relay') return 'relay';
  if (lt === 'host' && rt === 'host') {
    return isSameNetwork(local.address, remote.address) ? 'LAN' : 'VPN';
  }
  // srflx on either side (or prflx) means we hole-punched across the public internet
  return 'P2P';
}

async function getConnectionInfo() {
  if (!pc) return null;
  var stats = await pc.getStats();
  var pair = null;
  stats.forEach(function (r) { if (r.type === 'candidate-pair' && r.state === 'succeeded') pair = r; });
  if (!pair) return null;
  var local = null, remote = null;
  stats.forEach(function (r) {
    if (r.id === pair.localCandidateId) local = r;
    if (r.id === pair.remoteCandidateId) remote = r;
  });
  var type = classifyPair(local, remote);
  return {
    local: local ? local.address + ':' + local.port + ' (' + local.candidateType + ')' : '?',
    remote: remote ? remote.address + ':' + remote.port + ' (' + remote.candidateType + ')' : '?',
    type: type,
    description: CONN_DESCRIPTIONS[type] || ''
  };
}

export {
  initPeer,
  connectToPeer,
  closePeer,
  getDataConn,
  sendData,
  getConnectionInfo
};
