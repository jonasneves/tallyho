// LAN-scoped peer discovery client.
//
// Subscribes to /discover/ws on the signal server. Every connected client
// behind the same public IP shares one Lobby DO and sees the same set of
// advertisements. Use it to surface "there's a peer on your network — tap
// to connect" UI without the user scanning a QR.
//
// Privacy: ads are visible to anyone behind the same NAT. Treat them as
// hints, not credentials. The actual room ID inside an ad is still a
// capability — defense-in-depth comes from your room-level auth, not from
// the discovery layer.
//
// Usage:
//   import { discover } from './discover.js';
//   const lobby = discover();                 // default signal.neevs.io
//   const stop = lobby.onChange(ads => render(ads));
//   lobby.publish('my-id', { app: 'foo', roomId: 'abc' }, 60_000);
//   lobby.remove('my-id');
//   lobby.close();

const DEFAULT_SIGNAL_URL = 'https://signal.neevs.io';
const RECONNECT_BASE_MS  = 1500;
const RECONNECT_MAX_MS   = 30_000;
const HEARTBEAT_MS       = 20_000;
// Republish ads on this cadence so the server-side TTL never expires while
// we're still connected. Half of DEFAULT_AD_TTL with margin.
const REPUBLISH_MS       = 25_000;

export class DiscoveryClient {
  constructor(opts) {
    opts = opts || {};
    const base = (opts.signalUrl || DEFAULT_SIGNAL_URL).replace(/^http/, 'ws');
    this._url = base + '/discover/ws';
    this._ws = null;
    this._ads = [];
    this._listeners = new Set();
    this._myAds = new Map();          // id -> { data, ttl }
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._republishTimer = null;
    this._closed = false;
    this._connect();
  }

  _connect() {
    if (this._closed) return;
    try { this._ws = new WebSocket(this._url); }
    catch (err) { this._scheduleReconnect(); return; }

    this._ws.addEventListener('open', () => {
      this._reconnectDelay = RECONNECT_BASE_MS;
      // Re-publish anything we had before the disconnect — the server may
      // have lost our entries on close.
      for (const [id, payload] of this._myAds) {
        this._sendPublish(id, payload.data, payload.ttl);
      }
      this._startHeartbeat();
      this._startRepublish();
    });

    this._ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'ads') {
        this._ads = Array.isArray(msg.ads) ? msg.ads : [];
        for (const fn of this._listeners) {
          try { fn(this._ads); } catch {}
        }
      }
    });

    this._ws.addEventListener('close', () => {
      this._stopHeartbeat();
      this._stopRepublish();
      this._scheduleReconnect();
    });

    // Errors are followed by close which already reconnects. Empty handler
    // suppresses unhandled-error noise.
    this._ws.addEventListener('error', () => {});
  }

  _scheduleReconnect() {
    if (this._closed) return;
    if (this._reconnectTimer) return;
    const delay = this._reconnectDelay + Math.random() * 1000;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
      this._connect();
    }, delay);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === 1) {
        try { this._ws.send(JSON.stringify({ type: 'ping' })); } catch {}
      }
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  _startRepublish() {
    this._stopRepublish();
    this._republishTimer = setInterval(() => {
      if (!this._ws || this._ws.readyState !== 1) return;
      for (const [id, payload] of this._myAds) {
        this._sendPublish(id, payload.data, payload.ttl);
      }
    }, REPUBLISH_MS);
  }

  _stopRepublish() {
    if (this._republishTimer) { clearInterval(this._republishTimer); this._republishTimer = null; }
  }

  _sendPublish(id, data, ttl) {
    if (!this._ws || this._ws.readyState !== 1) return;
    try { this._ws.send(JSON.stringify({ type: 'publish', id, data, ttl })); } catch {}
  }

  // ── Public API ────────────────────────────────────────────────

  publish(id, data, ttlMs) {
    this._myAds.set(id, { data, ttl: ttlMs });
    this._sendPublish(id, data, ttlMs);
  }

  remove(id) {
    this._myAds.delete(id);
    if (this._ws && this._ws.readyState === 1) {
      try { this._ws.send(JSON.stringify({ type: 'remove', id })); } catch {}
    }
  }

  // Subscribe to ad-set changes. Fires immediately with the current snapshot.
  onChange(cb) {
    this._listeners.add(cb);
    try { cb(this._ads); } catch {}
    return () => this._listeners.delete(cb);
  }

  ads() { return this._ads.slice(); }

  close() {
    this._closed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._stopHeartbeat();
    this._stopRepublish();
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
    this._listeners.clear();
    this._myAds.clear();
  }
}

export function discover(opts) { return new DiscoveryClient(opts); }
