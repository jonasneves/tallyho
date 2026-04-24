import { runAgent, stopAgent, buildSystemPrompt, getModelName } from './src/agent.js';
import { VLM_DEFAULT_PROMPT, TARGET_CATEGORY } from './src/tools.js';
import { initPeer, connectToPeer, closePeer, getDataConn, sendData, getConnectionInfo } from './src/peer.js';
import { analyzeFrame as classicalAnalyzeFrame, preload as classicalPreload, isLoaded as classicalIsLoaded } from './src/classical.js';
import { discover } from './src/discover.js';

window.flashBtn = function (btn, label) {
  if (!btn) return;
  var original = btn.textContent;
  var originalColor = btn.style.color;
  btn.textContent = label;
  btn.style.color = '#9fe29f';
  setTimeout(function () { btn.textContent = original; btn.style.color = originalColor; }, 600);
};

// ── Debug panel (enabled via ?debug=1) ─────────────────────────

(function () {
  if (!new URLSearchParams(location.search).has('debug')) return;
  var panel = document.getElementById('debug-panel');
  if (panel) panel.style.display = '';
  var role = new URLSearchParams(location.search).get('peer') ? 'phone' : 'desktop';
  var roleEl = document.getElementById('debug-role');
  if (roleEl) roleEl.textContent = role;
  var logEl = document.getElementById('debug-log');
  function write(kind, args) {
    if (!logEl) return;
    var txt = Array.prototype.map.call(args, function (a) {
      try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
    if (txt.indexOf('[peer]') === -1 && kind !== 'error') return;
    var t = new Date().toISOString().slice(11, 19);
    logEl.textContent += t + ' ' + kind + ' ' + txt + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
  var log = console.log, warn = console.warn, err = console.error;
  console.log = function () { write('log', arguments); log.apply(console, arguments); };
  console.warn = function () { write('warn', arguments); warn.apply(console, arguments); };
  console.error = function () { write('error', arguments); err.apply(console, arguments); };
  window.addEventListener('error', function (e) { write('error', [e.message + ' at ' + e.filename + ':' + e.lineno]); });
  window.addEventListener('unhandledrejection', function (e) { write('error', ['unhandled: ' + (e.reason && e.reason.message || e.reason)]); });
})();

// ── Persistence (IndexedDB for captures, localStorage for memory) ──

var db = null;

function initDB() {
  return new Promise(function (resolve) {
    var req = indexedDB.open('tallyho', 1);
    req.onupgradeneeded = function () {
      req.result.createObjectStore('captures', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = function () { db = req.result; resolve(); };
    req.onerror = function () { resolve(); }; // continue without persistence
  });
}

function saveCaptureToDB(capture) {
  if (!db) return;
  var tx = db.transaction('captures', 'readwrite');
  tx.objectStore('captures').add(capture);
}

function loadCapturesFromDB() {
  return new Promise(function (resolve) {
    if (!db) { resolve([]); return; }
    var tx = db.transaction('captures', 'readonly');
    var req = tx.objectStore('captures').getAll();
    req.onsuccess = function () { resolve(req.result || []); };
    req.onerror = function () { resolve([]); };
  });
}

function saveMemoryToStorage() {
  try { localStorage.setItem('agent_memory', JSON.stringify(agentMemory)); } catch (_) {}
}

function loadMemoryFromStorage() {
  try {
    var saved = localStorage.getItem('agent_memory');
    return saved ? JSON.parse(saved) : [];
  } catch (_) { return []; }
}

var VLM_MODEL = 'LiquidAI/LFM2.5-VL-450M-ONNX';
// Wake the agent on any VLM phrasing that might refer to the target category. Vocabulary is broader than the category word alone because the VLM often describes a can without using "can" (e.g. "tin", "aluminum container", "beverage").
var TARGET_PATTERN = /\b(cans?|tins?|aluminum|beverage|soda|container)\b/i;

function refreshProviderIndicators() {
  var label = document.querySelector('#agent-panel .agent-model');
  if (label) label.textContent = getModelName();
  var hint = document.getElementById('active-provider');
  if (hint) hint.textContent = getModelName();
}

function saveApiKey(value) {
  if (value.trim()) {
    localStorage.setItem('anthropic_key', value.trim());
  } else {
    localStorage.removeItem('anthropic_key');
  }
  refreshProviderIndicators();
}

function saveOpenaiKey(value) {
  if (value.trim()) {
    localStorage.setItem('openai_key', value.trim());
  } else {
    localStorage.removeItem('openai_key');
  }
  refreshProviderIndicators();
}

function loadApiKey() {
  var el = document.getElementById('api-key-input');
  if (el) el.value = localStorage.getItem('anthropic_key') || '';
}

// ── GitHub OAuth ───────────────────────────────────────────────

var _authLib = null;
function getAuthLib() {
  if (!_authLib) _authLib = import('https://neevs.io/auth/lib.js');
  return _authLib;
}

async function loginWithGitHub() {
  var btn = document.getElementById('gh-login-btn');
  if (btn) btn.disabled = true;
  try {
    var { connectGitHub } = await getAuthLib();
    var result = await connectGitHub('read:user', 'tallyho');
    localStorage.setItem('github_token', result.token);
    localStorage.setItem('github_login', result.username || '');
    renderGitHubStatus();
  } catch (err) {
    console.warn('GitHub login failed:', err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function logoutGitHub() {
  localStorage.removeItem('github_token');
  localStorage.removeItem('github_login');
  renderGitHubStatus();
}

async function renderGitHubStatus() {
  var container = document.getElementById('header-auth');
  if (!container) return;
  var login = localStorage.getItem('github_login');
  var token = localStorage.getItem('github_token');
  var apiKey = localStorage.getItem('anthropic_key') || '';
  var openaiKey = localStorage.getItem('openai_key') || '';

  var keyFields =
    '<form onsubmit="return false" autocomplete="off">' +
      '<div class="field">' +
        '<label>Anthropic API key or token</label>' +
        '<input id="api-key-input" type="password" placeholder="sk-ant-api03-… or sk-ant-oat01-…" value="' + escapeHtml(apiKey) + '" oninput="saveApiKey(this.value)" />' +
      '</div>' +
      '<div class="field">' +
        '<label>OpenAI API key</label>' +
        '<input id="openai-key-input" type="password" placeholder="sk-…" value="' + escapeHtml(openaiKey) + '" oninput="saveOpenaiKey(this.value)" />' +
      '</div>' +
    '</form>' +
    '<p class="settings-hint">Active model: <code id="active-provider">' + getModelName() + '</code>. Anthropic routes via proxy.neevs.io; OpenAI calls <code>api.openai.com</code> directly. Anthropic takes precedence if both are set — clear that field to use OpenAI.</p>';

  if (token) {
    container.innerHTML =
      '<div class="auth-menu">' +
        '<button class="auth-trigger" onclick="this.parentElement.classList.toggle(\'open\')">' +
          '<span class="auth-avatar">' + (login || 'U').charAt(0).toUpperCase() + '</span>' +
          '<span class="auth-name">' + escapeHtml(login || 'Connected') + '</span>' +
        '</button>' +
        '<div class="auth-dropdown">' +
          '<div class="auth-dropdown-section">' +
            '<span class="auth-dropdown-label">Signed in via GitHub</span>' +
          '</div>' +
          '<div class="auth-dropdown-section">' + keyFields + '</div>' +
          '<button class="auth-signout" onclick="logoutGitHub()">Sign out</button>' +
        '</div>' +
      '</div>';
  } else {
    var icon = '';
    try { icon = (await getAuthLib()).GITHUB_ICON_SVG || ''; } catch (_) { /* offline */ }
    container.innerHTML =
      '<div class="auth-menu">' +
        '<button class="auth-trigger" onclick="this.parentElement.classList.toggle(\'open\')">' +
          '<span class="auth-trigger-label">Sign in</span>' +
        '</button>' +
        '<div class="auth-dropdown">' +
          '<div class="auth-dropdown-section">' +
            '<button class="btn-github" id="gh-login-btn" onclick="loginWithGitHub()">' +
              icon + 'Sign in with GitHub' +
            '</button>' +
          '</div>' +
          '<div class="settings-divider"><span>or</span></div>' +
          '<div class="auth-dropdown-section">' + keyFields + '</div>' +
        '</div>' +
      '</div>';
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', function closeAuth(e) {
    var menu = container.querySelector('.auth-menu');
    if (menu && !menu.contains(e.target)) {
      menu.classList.remove('open');
    }
  });
}

// ── State ───────────────────────────────────────────────────────

var myId = ((new URLSearchParams(location.search).get('room') || '').match(/^[a-z0-9]{3,20}$/i) || [])[0] || generatePeerId();
var remotePeerIdToConnect = '';
var localStream = null;
// Detect mobile: touch + small screen OR mobile platform.
// Can't rely on UA alone — iOS Safari may request desktop site.
var isMobileDevice = (
  ('ontouchstart' in window && window.innerWidth < 1024) ||
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) // iPad
);
// VLM needs WebGPU on a desktop with enough memory.
var hasWebGPU = !!navigator.gpu && !isMobileDevice;

var scannerStream = null;
var scannerRaf = null;

var vlm = null;
var vlmLoading = false;
var vlmRunning = false;
var vlmTimer = null;
var vlmSource = 'auto'; // 'auto' | 'local' | 'remote' | 'both'
var vlmSourceToggle = 0; // for 'both' mode: alternates between cameras

var agentBusy = false;
var agentAbort = false;
var agentMessages = [];
var agentPromptChanges = 0;
var agentCooldownUntil = 0;
var agentLastCapture = null; // { label, time, vlmSnippet }
var agentConsecutiveRejects = 0;
var agentMemory = [];
var agentTokensTotal = { input: 0, output: 0 };
var captures = [];

// Pipeline: 'dl' (LFM2.5 + Claude) or 'classical' (HSV + shape + OCR).
// In classical mode the VLM keeps running for the operator's eyes but the
// agent dispatch is paused (no Claude calls), and a Snap button drives
// classical analysis on demand.
var pipeline = 'dl';
var classicalLoading = false;
var classicalBusy = false;


// ── UI helpers ──────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
  document.body.classList.toggle('live', id === 'screen-live');
}

function renderTargetLabel() {
  var el = document.getElementById('target-label');
  if (!el) return;
  el.textContent = TARGET_CATEGORY.charAt(0).toUpperCase() + TARGET_CATEGORY.slice(1);
}

function showRemoteFeed() {
  var feedRemote = document.getElementById('feed-remote');
  var feedLocal = document.getElementById('feed-local');
  var qrBadge = document.getElementById('qr-badge');
  if (feedRemote) feedRemote.style.display = '';
  if (feedLocal) feedLocal.classList.remove('camera-feed-full');
  if (qrBadge) qrBadge.classList.add('hidden');
}

function hideRemoteFeed() {
  var feedRemote = document.getElementById('feed-remote');
  var feedLocal = document.getElementById('feed-local');
  var qrBadge = document.getElementById('qr-badge');
  if (feedRemote) feedRemote.style.display = 'none';
  if (feedLocal) feedLocal.classList.add('camera-feed-full');
  if (qrBadge) qrBadge.classList.remove('hidden');
}

var connInfoTimer = null;

function setStatus(state, message) {
  var dot = document.getElementById('live-dot');
  var text = document.getElementById('live-status');
  dot.className = 'status-dot' + (state === 'ok' ? ' connected' : state === 'err' ? ' error' : '');
  text.textContent = message;

  // Start polling connection info when connected
  if (state === 'ok' && !connInfoTimer) {
    connInfoTimer = setInterval(updateConnectionInfo, 3000);
    setTimeout(updateConnectionInfo, 1000);
  } else if (state !== 'ok' && connInfoTimer) {
    clearInterval(connInfoTimer);
    connInfoTimer = null;
    text.title = '';
  }
}

async function updateConnectionInfo() {
  var info = await getConnectionInfo();
  var el = document.getElementById('live-status');
  if (!el || !info) return;
  el.title =
    info.type + ' — ' + info.description +
    '\n\nlocal:  ' + info.local +
    '\nremote: ' + info.remote;
}

function generatePeerId() {
  return Math.random().toString(36).slice(2, 8);
}

function hashPeerId(username) {
  // Simple hash: deterministic across devices, not easily guessable
  var str = username + ':tallyho:' + username.length;
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function updatePeerDisplay() {
  var display = document.getElementById('my-peer-display');
  if (display) display.textContent = myId;
  var shareUrl = location.origin + location.pathname + '?peer=' + myId +
    (new URLSearchParams(location.search).has('debug') ? '&debug=1' : '');
  var qrWrap = document.getElementById('my-qr');
  if (qrWrap) {
    var qr = qrcode(0, 'M');
    qr.addData(shareUrl);
    qr.make();
    qrWrap.innerHTML = '';
    var img = document.createElement('img');
    img.src = qr.createDataURL(4, 0);
    img.className = 'qr-img';
    qrWrap.appendChild(img);
  }
  // Update live QR too
  var liveQr = document.getElementById('live-qr');
  if (liveQr) {
    var qr2 = qrcode(0, 'M');
    qr2.addData(shareUrl);
    qr2.make();
    liveQr.innerHTML = '';
    var img2 = document.createElement('img');
    img2.src = qr2.createDataURL(4, 0);
    img2.className = 'qr-img';
    liveQr.appendChild(img2);
  }
}

// ── Agent log with collapsible pills ────────────────────────────

function agentLog(tag, summary, detail, suffix) {
  summary = summary || '';
  detail = detail || null;
  suffix = suffix || '';
  appendLogEntry(document.getElementById('agent-log'), tag, summary, detail, suffix);
  sendData({ type: 'agent_log', tag: tag, summary: summary, detail: detail });
}

function appendLogEntry(log, tag, summary, detail, suffix) {
  if (!log) return;
  suffix = suffix || '';
  var entry = document.createElement('div');
  entry.className = 'agent-entry';
  if (detail) {
    entry.classList.add('agent-expandable');
    entry.innerHTML =
      '<div class="agent-step-head" role="button" tabindex="0" onclick="this.parentElement.classList.toggle(\'expanded\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.parentElement.classList.toggle(\'expanded\')}">' +
        '<span class="tag ' + tag + '">' + tag + '</span>' +
        '<span class="agent-summary">' + renderInlineMarkdown(summary) + suffix + '</span>' +
        '<span class="agent-toggle">Details</span>' +
      '</div>' +
      '<div class="agent-detail"><pre class="agent-pre">' + escapeHtml(detail) + '</pre></div>';
  } else {
    entry.innerHTML = '<span class="tag ' + tag + '">' + tag + '</span>' + renderInlineMarkdown(summary) + suffix;
  }
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInlineMarkdown(s) {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// ── Boot (page load: set up PeerJS, QR code) ───────────────────

async function boot() {
  // Load persisted data
  await initDB();
  var savedCaptures = await loadCapturesFromDB();
  if (savedCaptures.length) {
    captures = savedCaptures;
    renderCaptures();
  }
  agentMemory = loadMemoryFromStorage();
  renderMemory();
  renderTargetLabel();
  document.getElementById('my-peer-display').textContent = myId;

  // Desktop: persist room ID in URL so reloads keep the same QR
  if (!new URLSearchParams(location.search).has('peer')) {
    var rp = new URLSearchParams(location.search);
    if (rp.get('room') !== myId) {
      rp.set('room', myId);
      history.replaceState(null, '', location.pathname + '?' + rp.toString());
    }
  }

  var shareUrl = location.origin + location.pathname + '?peer=' + myId +
    (new URLSearchParams(location.search).has('debug') ? '&debug=1' : '');
  var qr = qrcode(0, 'M');
  qr.addData(shareUrl);
  qr.make();
  var qrWrap = document.getElementById('my-qr');
  qrWrap.innerHTML = '';
  var img = document.createElement('img');
  img.src = qr.createDataURL(4, 0);
  img.className = 'qr-img';
  qrWrap.appendChild(img);

  renderGitHubStatus();
  initPeer(myId, peerCtx);

  // Auto-start if phone scanned a QR (has ?peer= in URL)
  var params = new URLSearchParams(location.search);
  if (params.get('peer')) {
    remotePeerIdToConnect = params.get('peer').trim();
    await startApp();
    setStatus('', 'Connecting to desktop...');
  } else if (hasWebGPU) {
    publishDesktopAd();
  } else {
    startMobileScanner();
    initMobileNearbyDiscovery();
  }
}

// ── LAN discovery (signal /discover) ───────────────────────────

var _lobby = null;

function getLobby() {
  if (!_lobby) _lobby = discover();
  return _lobby;
}

function deviceLabel() {
  var ua = navigator.userAgent || '';
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return /iPhone|iPad|iPod/i.test(ua) ? 'iPhone' : 'Mac';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Computer';
}

function publishDesktopAd() {
  getLobby().publish('tallyho:' + myId, {
    app: 'tallyho',
    peerId: myId,
    label: deviceLabel()
  }, 60000);
}

function initMobileNearbyDiscovery() {
  var wrap = document.getElementById('nearby-desktops');
  var list = document.getElementById('nearby-list');
  if (!wrap || !list) return;

  getLobby().onChange(function (ads) {
    var desktops = ads.filter(function (ad) {
      return ad.data && ad.data.app === 'tallyho'
        && ad.data.peerId && ad.data.peerId !== myId;
    });
    if (!desktops.length) {
      wrap.hidden = true;
      list.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    list.innerHTML = '';
    desktops.forEach(function (ad) {
      var btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = 'Connect to ' + (ad.data.label || 'Computer');
      btn.addEventListener('click', function () { connectFromNearby(ad.data.peerId); });
      list.appendChild(btn);
    });
  });
}

function connectFromNearby(peerId) {
  if (!peerId || peerId === myId) return;
  remotePeerIdToConnect = peerId;
  stopScanner();
  syncUrlForPeer(peerId);
  connectToPeer(peerId, peerCtx);
  startApp();
}

// Peer context: bridges src/peer.js with app state and UI
var peerCtx = {
  getLocalStream: function () { return localStream; },
  getRemotePeerId: function () { return remotePeerIdToConnect; },
  startApp: startApp,
  showRemoteFeed: showRemoteFeed,
  hideRemoteFeed: hideRemoteFeed,
  setStatus: setStatus,
  handlePeerData: handlePeerData
};

// ── Start (user clicks Start: camera → live → auto-load VLM) ───

async function startApp() {
  stopScanner();
  // Request camera
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
  } catch (e) {
    console.warn('Camera failed:', e);
  }

  // Go live
  showScreen('screen-live');
  setStatus('ok', localStream ? 'Camera active' : 'No camera');

  var localVid = document.getElementById('local-video');
  if (localVid && localStream) localVid.srcObject = localStream;
  var mobileVid = document.getElementById('mobile-camera');
  if (mobileVid && localStream) mobileVid.srcObject = localStream;

  initVLMPanel();
  initAgentPanel();

  // Render QR code in the remote camera placeholder
  var liveQr = document.getElementById('live-qr');
  if (liveQr) {
    var shareUrl = location.origin + location.pathname + '?peer=' + myId +
    (new URLSearchParams(location.search).has('debug') ? '&debug=1' : '');
    var qr = qrcode(0, 'M');
    qr.addData(shareUrl);
    qr.make();
    liveQr.innerHTML = '';
    var img = document.createElement('img');
    img.src = qr.createDataURL(4, 0);
    img.className = 'qr-img';
    liveQr.appendChild(img);
  }

  // Auto-load VLM on desktop
  if (hasWebGPU) {
    loadVLM();
  }
}




// ── QR scanner (mobile only) ────────────────────────────────────

function startMobileScanner() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  var video = document.getElementById('scanner-video-mobile');
  if (!video) return;
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(function (stream) {
      scannerStream = stream;
      video.srcObject = stream;
      return video.play();
    })
    .then(function () { scanMobileFrame(); })
    .catch(function (e) {
      console.warn('Mobile scanner failed:', e);
    });
}

function scanMobileFrame() {
  var video = document.getElementById('scanner-video-mobile');
  var canvas = document.getElementById('scanner-canvas-mobile');
  if (!video || !scannerStream || video.readyState < 2) {
    scannerRaf = requestAnimationFrame(scanMobileFrame);
    return;
  }
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0);
  var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (typeof jsQR !== 'undefined') {
    var result = jsQR(imageData.data, canvas.width, canvas.height);
    if (result && result.data) {
      console.log('[peer] QR decoded:', result.data);
      var match = result.data.match(/[?&]peer=([a-z0-9]+)/i);
      if (match && match[1] !== myId) {
        console.log('[peer] QR scanned, connecting to:', match[1]);
        remotePeerIdToConnect = match[1];
        stopScanner();
        syncUrlForPeer(match[1]);
        connectToPeer(match[1], peerCtx);
        startApp();
        return;
      }
    }
  }
  scannerRaf = requestAnimationFrame(scanMobileFrame);
}

function connectFromMobile() {
  var input = document.getElementById('manual-peer-mobile');
  if (!input) return;
  var peerId = input.value.trim();
  if (!peerId) return;
  remotePeerIdToConnect = peerId;
  stopScanner();
  syncUrlForPeer(peerId);
  connectToPeer(peerId, peerCtx);
  startApp();
}

function syncUrlForPeer(peerId) {
  try {
    var params = new URLSearchParams(location.search);
    params.set('peer', peerId);
    history.replaceState(null, '', location.pathname + '?' + params.toString());
  } catch (_) {}
}

function stopScanner() {
  if (scannerRaf) { cancelAnimationFrame(scannerRaf); scannerRaf = null; }
  if (scannerStream) {
    scannerStream.getTracks().forEach(function (t) { t.stop(); });
    scannerStream = null;
  }
  var video = document.getElementById('scanner-video-mobile');
  if (video) video.srcObject = null;
}

// ── VLM panel ───────────────────────────────────────────────────

function initVLMPanel() {
  var badge = document.getElementById('vlm-badge');
  var body = document.getElementById('vlm-body');
  badge.style.display = 'none';
  if (hasWebGPU) {
    body.innerHTML = '<button class="vlm-load-btn" onclick="loadVLM()">Load vision model (~770 MB)</button>';
  } else {
    body.innerHTML = '<div class="vlm-output" id="vlm-output"></div>';
  }
}

async function loadVLM() {
  if (!hasWebGPU || vlmLoading || vlm) return;
  vlmLoading = true;
  var body = document.getElementById('vlm-body');
  body.innerHTML =
    '<div class="vlm-progress"><div class="vlm-progress-bar" id="vlm-bar"></div></div>' +
    '<span class="vlm-progress-text" id="vlm-progress-text">Loading library...</span>';

  try {
    var tf = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers');
    document.getElementById('vlm-progress-text').textContent = 'Downloading model...';
    var model = await tf.AutoModelForImageTextToText.from_pretrained(VLM_MODEL, {
      device: 'webgpu',
      dtype: { vision_encoder: 'fp16', embed_tokens: 'fp16', decoder_model_merged: 'q4' },
      progress_callback: function (p) {
        if (p.status === 'progress') {
          var bar = document.getElementById('vlm-bar');
          var text = document.getElementById('vlm-progress-text');
          if (bar) bar.style.width = Math.round(p.progress) + '%';
          if (text) {
            var name = (p.file || '').split('/').pop();
            text.textContent = name + ' ' + Math.round(p.progress) + '%';
          }
        }
      }
    });
    document.getElementById('vlm-progress-text').textContent = 'Loading processor...';
    var processor = await tf.AutoProcessor.from_pretrained(VLM_MODEL);
    vlm = { model: model, processor: processor, RawImage: tf.RawImage };
    vlmLoading = false;
    body.innerHTML =
      '<div class="vlm-source-row">' +
        '<label class="vlm-source-label">Camera:</label>' +
        '<select id="vlm-source" onchange="setVLMSource(this.value)">' +
          '<option value="auto">Auto</option>' +
          '<option value="remote">Remote (phone)</option>' +
          '<option value="local">Local (webcam)</option>' +
          '<option value="both">Both (alternate)</option>' +
        '</select>' +
      '</div>' +
      '<div class="field"><textarea id="vlm-prompt" rows="2">' + VLM_DEFAULT_PROMPT + '</textarea></div>' +
      '<div class="vlm-output" id="vlm-output"></div>';
    startInferenceLoop();
  } catch (e) {
    vlmLoading = false;
    body.innerHTML =
      '<span class="vlm-progress-text" style="color:var(--red)">Failed: ' + e.message + '</span>' +
      '<button class="vlm-load-btn" style="margin-top:8px" onclick="loadVLM()">Retry</button>';
  }
}

// ── VLM inference loop ──────────────────────────────────────────

function startInferenceLoop() {
  if (!vlm || vlmTimer) return;
  runOneInference();
}

function stopInferenceLoop() {
  if (vlmTimer) { clearTimeout(vlmTimer); vlmTimer = null; }
}

function getVideoElement() {
  var remote = document.getElementById('remote-video');
  var local = document.getElementById('local-video');
  var remoteOk = remote && remote.videoWidth;
  var localOk = local && local.videoWidth;
  var picked = null;

  if (vlmSource === 'remote') picked = remoteOk ? remote : null;
  else if (vlmSource === 'local') picked = localOk ? local : null;
  else if (vlmSource === 'both') {
    vlmSourceToggle++;
    if (vlmSourceToggle % 2 === 0) picked = remoteOk ? remote : (localOk ? local : null);
    else picked = localOk ? local : (remoteOk ? remote : null);
  } else {
    picked = remoteOk ? remote : (localOk ? local : null);
  }

  // Highlight active feed
  var feedRemote = document.getElementById('feed-remote');
  var feedLocal = document.getElementById('feed-local');
  if (feedRemote) feedRemote.classList.toggle('vlm-active', picked === remote);
  if (feedLocal) feedLocal.classList.toggle('vlm-active', picked === local);

  return picked;
}

function setVLMSource(value) {
  vlmSource = value;
  vlmSourceToggle = 0;
}

function captureCurrentFrame(maxDim) {
  var video = getVideoElement();
  if (!video || video.paused || video.ended) return null;
  var w = video.videoWidth;
  var h = video.videoHeight;
  if (!w || !h) return null;
  if (maxDim && Math.max(w, h) > maxDim) {
    var scale = maxDim / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  var canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return canvas;
}

async function runOneInference() {
  if (!vlm || vlmRunning || agentBusy) {
    vlmTimer = setTimeout(runOneInference, 2000);
    return;
  }
  var video = getVideoElement();
  if (!video) { vlmTimer = setTimeout(runOneInference, 1000); return; }

  vlmRunning = true;
  var output = document.getElementById('vlm-output');

  try {
    var canvas = captureCurrentFrame();
    var imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    var image = new vlm.RawImage(imageData.data, canvas.width, canvas.height, 4);

    var promptText = (document.getElementById('vlm-prompt') || {}).value || VLM_DEFAULT_PROMPT;
    var messages = [
      { role: 'user', content: [{ type: 'image' }, { type: 'text', text: promptText }] }
    ];
    var chatPrompt = vlm.processor.apply_chat_template(messages, { add_generation_prompt: true });
    var inputs = await vlm.processor(image, chatPrompt, { add_special_tokens: false });
    var outputs = await vlm.model.generate({ ...inputs, do_sample: false, max_new_tokens: 128 });
    var decoded = vlm.processor.batch_decode(
      outputs.slice(null, [inputs.input_ids.dims.at(-1), null]),
      { skip_special_tokens: true }
    );
    var text = decoded[0];

    sendData({ type: 'vlm', text: text });

    // Trigger agent only when a target item is detected, agent is idle, and not a duplicate
    var triggered = false;
    if (pipeline === 'dl' && TARGET_PATTERN.test(text) && !agentBusy && Date.now() > agentCooldownUntil) {
      var shouldSkip = false;
      if (agentLastCapture && Date.now() - agentLastCapture.time < 60000) {
        var snippet = text.slice(0, 80).toLowerCase();
        var lastSnippet = (agentLastCapture.vlmSnippet || '').toLowerCase();
        var overlap = snippet.split(' ').filter(function (w) { return lastSnippet.indexOf(w) !== -1; }).length;
        shouldSkip = overlap / Math.max(snippet.split(' ').length, 1) > 0.4;
      }
      if (!shouldSkip) {
        triggered = true;
        triggerAgent(text);
      }
    }
    if (output) {
      if (triggered) {
        output.innerHTML = escapeHtml(text).replace(TARGET_PATTERN, '<mark class="vlm-trigger">$&</mark>');
      } else {
        output.textContent = text;
      }
      output.scrollTop = output.scrollHeight;
    }
  } catch (e) {
    if (output) output.textContent = 'Inference error: ' + e.message;
  }

  vlmRunning = false;
  vlmTimer = setTimeout(runOneInference, 2000);
}

// ── Agent panel ─────────────────────────────────────────────────

function initAgentPanel() {
  var panel = document.getElementById('agent-panel');
  panel.innerHTML =
    '<div class="agent-section">' +
      '<div class="panel-header">' +
        '<span>Agent <span class="agent-model">' + getModelName() + '</span></span>' +
        '<span class="panel-header-actions">' +
          '<span class="token-total" id="token-total" title="Total tokens used">0</span>' +
          '<button class="copy-btn" onclick="copyAgentLog()">Copy</button>' +
          '<button class="stop-btn" id="agent-stop" onclick="triggerStopAgent()" style="display:none">Stop</button>' +
          '<span id="agent-status">' + (hasWebGPU ? 'idle' : 'remote') + '</span>' +
        '</span>' +
      '</div>' +
      '<div class="agent-log" id="agent-log"></div>' +
    '</div>';
}

function copyAgentLog() {
  var log = document.getElementById('agent-log');
  if (!log) return;
  var entries = log.querySelectorAll('.agent-entry');
  var lines = [];
  entries.forEach(function (entry) {
    var tag = entry.querySelector('.tag');
    var summary = entry.querySelector('.agent-summary');
    var detail = entry.querySelector('.agent-pre');
    var tagText = tag ? tag.textContent : '';
    var summaryText = summary ? summary.textContent : entry.textContent.replace(tagText, '').trim();
    var line = '[' + tagText + '] ' + summaryText;
    if (detail) line += '\n' + detail.textContent;
    lines.push(line);
  });
  var text = lines.join('\n');
  navigator.clipboard.writeText(text).then(function () {
    var btn = log.parentElement.querySelector('.copy-btn');
    if (btn) { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); }
  });
}

// ── Agent: delegates to src/agent.js ────────────────────────────

// Build the context object that agent and tools modules need
// Live proxy: getters/setters read and write the outer variables directly.
// Avoids stale snapshots when agent.js reassigns arrays (e.g. agentMessages = []).
var agentCtx = {
  get agentBusy() { return agentBusy; },
  set agentBusy(v) { agentBusy = v; },
  get agentAbort() { return agentAbort; },
  set agentAbort(v) { agentAbort = v; },
  get agentMessages() { return agentMessages; },
  set agentMessages(v) { agentMessages = v; },
  get agentPromptChanges() { return agentPromptChanges; },
  set agentPromptChanges(v) { agentPromptChanges = v; },
  get agentMemory() { return agentMemory; },
  set agentMemory(v) { agentMemory = v; },
  get agentTokensTotal() { return agentTokensTotal; },
  get agentLastCapture() { return agentLastCapture; },
  set agentLastCapture(v) { agentLastCapture = v; },
  get agentCooldownUntil() { return agentCooldownUntil; },
  set agentCooldownUntil(v) { agentCooldownUntil = v; },
  get agentConsecutiveRejects() { return agentConsecutiveRejects; },
  set agentConsecutiveRejects(v) { agentConsecutiveRejects = v; },
  get captures() { return captures; },
  get vlm() { return vlm; },
  get dataConn() { return getDataConn(); },
  captureCurrentFrame: captureCurrentFrame,
  agentLog: agentLog,
  renderMemory: renderMemory,
  renderCaptures: renderCaptures
};

function triggerAgent(vlmText) {
  runAgent(vlmText, agentCtx);
}

function triggerStopAgent() {
  stopAgent(agentCtx);
}

function clearMemory() {
  agentMemory = [];
  agentConsecutiveRejects = 0;
  renderMemory();
}
window.clearMemory = clearMemory;

function renderMemory() {
  saveMemoryToStorage();
  var container = document.getElementById('memory-list');
  if (!container) return;
  // Rejected column only shows scene rejections — catalog entries live in the catalog.
  var rejections = agentMemory.filter(function (m) { return (m.entry || '').indexOf('scene: ') === 0; });
  var count = document.getElementById('memory-count');
  if (count) count.textContent = rejections.length;
  var telemetryReject = document.getElementById('rejected-count');
  if (telemetryReject) telemetryReject.textContent = rejections.length;
  var clearBtn = document.getElementById('memory-clear');
  if (clearBtn) clearBtn.style.display = agentMemory.length > 0 ? '' : 'none';
  container.innerHTML = '';
  if (rejections.length === 0) {
    container.innerHTML =
      '<div class="empty-state empty-state-sm" aria-live="polite">' +
        '<span class="empty-title">Nothing ruled out yet</span>' +
        '<span class="empty-sub">The agent will list refusals here.</span>' +
      '</div>';
    return;
  }
  for (var i = rejections.length - 1; i >= 0; i--) {
    var m = rejections[i];
    var reason = m.entry.slice(7); // strip "scene: " prefix
    var el = document.createElement('div');
    el.className = 'memory-entry';
    el.innerHTML =
      '<span class="memory-reason">' + escapeHtml(reason) + '</span>' +
      '<span class="memory-time">' + m.time + '</span>';
    container.appendChild(el);
  }
}

function clearCaptures() {
  captures = [];
  if (db) {
    var tx = db.transaction('captures', 'readwrite');
    tx.objectStore('captures').clear();
  }
  renderCaptures();
}
window.clearCaptures = clearCaptures;

function renderCaptures(newCapture) {
  if (newCapture) saveCaptureToDB(newCapture);
  var container = document.getElementById('captures');
  var count = document.getElementById('captures-count');
  var telemetry = document.getElementById('catalog-count');
  if (!container) return;
  if (count) count.textContent = captures.length;
  if (telemetry) telemetry.textContent = captures.length;
  var telemetryReject = document.getElementById('rejected-count');
  if (telemetryReject) {
    var rejCount = agentMemory.filter(function (m) { return (m.entry || '').indexOf('scene: ') === 0; }).length;
    telemetryReject.textContent = rejCount;
  }
  container.innerHTML = '';
  if (captures.length === 0) {
    container.innerHTML =
      '<div class="empty-state" aria-live="polite">' +
        '<svg viewBox="0 0 40 40" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<rect x="8" y="6" width="24" height="28" rx="2"/>' +
          '<path d="M14 14h12M14 20h12M14 26h8"/>' +
        '</svg>' +
        '<span class="empty-title">No entries yet</span>' +
        '<span class="empty-sub">Captured frames will land here.</span>' +
      '</div>';
    return;
  }
  for (var i = captures.length - 1; i >= 0; i--) {
    var c = captures[i];
    var card = document.createElement('div');
    card.className = 'diary-entry';
    card.innerHTML =
      '<img src="' + c.image + '" role="button" tabindex="0" aria-label="View full image of ' + escapeHtml(c.label) + '" onclick="showLightbox(this.src)" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();showLightbox(this.src)}" />' +
      '<div class="diary-text">' +
        '<div class="diary-header"><span class="diary-name">' + escapeHtml(c.label) + '</span><span class="diary-time">' + c.time + '</span></div>' +
        (c.description ? '<div class="diary-desc">' + escapeHtml(c.description) + '</div>' : '') +
      '</div>';
    container.appendChild(card);
  }
}

// ── Pipeline toggle (DL vs Classical) ───────────────────────────

async function setPipeline(mode) {
  if (mode === pipeline || classicalLoading) return;
  if (mode === 'classical' && !classicalIsLoaded()) {
    classicalLoading = true;
    updatePipelineUI('loading');
    try {
      if (typeof classicalPreload === 'function') await classicalPreload();
      else { var c = document.createElement('canvas'); c.width = 64; c.height = 64; await classicalAnalyzeFrame(c, { withOCR: false }); }
    } catch (e) { classicalLoading = false; updatePipelineUI('error', e.message); return; }
    classicalLoading = false;
  }
  pipeline = mode;
  updatePipelineUI('ready');
  document.body.classList.toggle('pipeline-classical', mode === 'classical');
  var panel = document.getElementById('agent-panel');
  if (mode === 'classical' && panel) {
    panel.innerHTML =
      '<div class="agent-section classical-mode"><div class="panel-header">' +
      '<span>Classical CV pipeline <span class="agent-model">HSV · shape · OCR</span></span>' +
      '<span class="panel-header-actions"><span id="classical-latency" class="agent-model"></span></span>' +
      '</div><div class="classical-body">' +
      '<button class="snap-btn" id="snap-btn" onclick="snapAndAnalyze()">Snap and analyze</button>' +
      '<p class="classical-hint">Single-shot. Same camera frame; no VLM, no Claude.</p>' +
      '<div class="agent-log" id="agent-log"></div></div></div>';
  } else { initAgentPanel(); }
  var vlmOut = document.getElementById('vlm-output');
  if (vlmOut) vlmOut.classList.toggle('vlm-paused', mode === 'classical');
}
window.setPipeline = setPipeline;

function updatePipelineUI(state, msg) {
  var dl = document.getElementById('pipeline-dl');
  var cl = document.getElementById('pipeline-classical');
  var status = document.getElementById('pipeline-status');
  if (!dl || !cl) return;
  var loading = state === 'loading';
  dl.disabled = cl.disabled = loading;
  dl.classList.toggle('is-active', pipeline === 'dl' && !loading);
  cl.classList.toggle('is-active', pipeline === 'classical' && !loading);
  dl.setAttribute('aria-pressed', pipeline === 'dl' && !loading);
  cl.setAttribute('aria-pressed', pipeline === 'classical' && !loading);
  cl.textContent = loading ? 'Loading…' : 'Classical';
  if (status) status.textContent = loading ? 'Loading classical pipeline (~15MB, first time only)…' : (state === 'error' ? 'Failed: ' + (msg || 'unknown') : '');
}

async function snapAndAnalyze() {
  if (classicalBusy) return;
  if (classicalLoading) { var s = document.getElementById('pipeline-status'); if (s) s.textContent = 'Still loading…'; return; }
  var canvas = captureCurrentFrame(640);
  if (!canvas) { renderClassicalDecision({ detected: false, reasons: ['no camera frame available'], confidence: 0, latency_ms: 0 }, null); return; }
  classicalBusy = true;
  var btn = document.getElementById('snap-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing…'; }
  try {
    var decision = await classicalAnalyzeFrame(canvas);
    renderClassicalDecision(decision, canvas.toDataURL('image/jpeg', 0.85));
  } catch (e) {
    renderClassicalDecision({ detected: false, reasons: ['Classical pipeline error: ' + e.message], confidence: 0, latency_ms: 0 }, null);
  }
  classicalBusy = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Snap and analyze'; }
}
window.snapAndAnalyze = snapAndAnalyze;

function renderClassicalDecision(decision, dataUrl) {
  var lat = document.getElementById('classical-latency');
  var conf = (decision.confidence || 0).toFixed(2);
  var ms = Math.round(decision.latency_ms || 0);
  if (lat) lat.textContent = ms + 'ms · conf ' + conf;
  var now = new Date().toLocaleTimeString();
  var meta = 'classical · conf ' + conf + ' · ' + ms + 'ms';
  if (decision.detected) {
    var label = (decision.label && decision.label.trim()) || 'Unlabeled can';
    var desc = (decision.reasons || []).join(' · ').slice(0, 80);
    var cap = { label: label, description: desc + ' [' + meta + ']', image: dataUrl || '', time: now };
    captures.push(cap); renderCaptures(cap);
    appendLogEntry(document.getElementById('agent-log'), 'capture', label, (decision.reasons || []).join('\n'));
  } else {
    var reason = (decision.reasons && decision.reasons[0]) || 'no signals fired';
    agentMemory.push({ entry: 'scene: ' + reason + ' [' + meta + ']', time: now });
    if (agentMemory.length > 20) agentMemory.shift();
    renderMemory();
    appendLogEntry(document.getElementById('agent-log'), 'reject', reason, (decision.reasons || []).join('\n'));
  }
}

// ── Data channel ────────────────────────────────────────────────

function handlePeerData(data) {
  if (!data) return;

  if (data.type === 'vlm') {
    var output = document.getElementById('vlm-output');
    if (output) output.textContent = data.text;
  }

  if (data.type === 'agent_log') {
    appendLogEntry(
      document.getElementById('agent-log'),
      data.tag || 'agent',
      data.summary || '',
      data.detail || null
    );
  }

  if (data.type === 'capture') {
    captures.push({ label: data.label, description: data.description || '', image: data.image, time: data.time });
    renderCaptures();
  }

  if (data.type === 'memory') {
    agentMemory = data.entries || [];
    renderMemory();
  }

  if (data.type === 'operator_message') {
    // Only the phone side renders overlays on its live camera feed.
    if (!isMobileDevice) return;
    showOperatorOverlay(data.text || '');
  }
}

// ── Operator overlay (phone side) ───────────────────────────────

var _operatorOverlayTimer = null;
function showOperatorOverlay(text) {
  var el = document.getElementById('operator-overlay');
  if (!el || !text) return;
  el.textContent = text;
  el.classList.remove('fade-out');
  el.classList.add('visible');
  if (_operatorOverlayTimer) clearTimeout(_operatorOverlayTimer);
  _operatorOverlayTimer = setTimeout(function () {
    el.classList.add('fade-out');
    el.classList.remove('visible');
  }, 4000);
}

function dismissOperatorOverlay() {
  var el = document.getElementById('operator-overlay');
  if (!el) return;
  if (_operatorOverlayTimer) { clearTimeout(_operatorOverlayTimer); _operatorOverlayTimer = null; }
  el.classList.add('fade-out');
  el.classList.remove('visible');
}
window.dismissOperatorOverlay = dismissOperatorOverlay;

// ── Disconnect ──────────────────────────────────────────────────

function goHome() {
  if (!document.getElementById('screen-live').classList.contains('active')) return;
  stopInferenceLoop();
  vlmRunning = false;
  agentBusy = false;
  agentMessages = [];
  agentPromptChanges = 0;
  closePeer();
  hideRemoteFeed();
  showScreen('screen-lobby');
}

function disconnect() {
  stopInferenceLoop();
  vlmRunning = false;
  agentBusy = false;
  agentMessages = [];
  agentPromptChanges = 0;
  closePeer();
  document.getElementById('local-video').srcObject = localStream;
  showScreen('screen-lobby');
  if (!hasWebGPU) startMobileScanner();
}

// ── Lightbox ────────────────────────────────────────────────────

function showLightbox(src) {
  var el = document.getElementById('lightbox');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lightbox';
    el.className = 'lightbox';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Image preview');
    el.onclick = hideLightbox;
    el.onkeydown = function (e) { if (e.key === 'Escape') hideLightbox(); };
    el.setAttribute('tabindex', '-1');
    el.innerHTML = '<img alt="Full size capture" />';
    document.body.appendChild(el);
  }
  el.querySelector('img').src = src;
  el.classList.add('active');
  el.focus();
}

function hideLightbox() {
  var el = document.getElementById('lightbox');
  if (el) el.classList.remove('active');
}


// ── Init ────────────────────────────────────────────────────────

// Expose onclick handlers to HTML (ES modules have their own scope)
window.goHome = goHome;
window.startApp = startApp;
window.connectFromMobile = connectFromMobile;
window.disconnect = disconnect;
window.loadVLM = loadVLM;
window.copyAgentLog = copyAgentLog;
window.triggerStopAgent = triggerStopAgent;
window.setVLMSource = setVLMSource;
window.saveApiKey = saveApiKey;
window.saveOpenaiKey = saveOpenaiKey;
window.loginWithGitHub = loginWithGitHub;
window.logoutGitHub = logoutGitHub;
window.showLightbox = showLightbox;
window.hideLightbox = hideLightbox;

document.body.classList.add(hasWebGPU ? 'is-desktop' : 'is-mobile');
boot();

fetch('https://api.github.com/repos/jonasneves/tallyho/commits/main', { headers: { Accept: 'application/vnd.github.sha' } })
  .then(function (r) { if (!r.ok) throw 0; return r.text(); })
  .then(function (sha) { var el = document.getElementById('commit-hash'); if (el) el.textContent = sha.trim().slice(0, 7); })
  .catch(function () {});
