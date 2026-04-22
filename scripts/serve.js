#!/usr/bin/env node

const http = require('http');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const ROOT = path.join(__dirname, '..');

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// Kill any stale cloudflared from previous runs
try { execSync('pkill -f "cloudflared tunnel" 2>/dev/null'); } catch (_) {}

// Omit the host arg so Node binds the unspecified IPv6 address (::), which
// on macOS / Linux also accepts IPv4 via IPV6_V6ONLY=0. Binding IPv4-only
// (0.0.0.0) caused ~5-second stalls on Chrome/curl because both try ::1
// first for "localhost" and wait for the IPv6 attempt to fail before
// falling back to 127.0.0.1.
server.listen(8000, () => {
  console.log('');
  console.log(`  \x1b[32m→  Desktop:\x1b[0m  http://localhost:8000`);
  console.log(`  \x1b[2m→  Tunnel:   starting...\x1b[0m`);

  const tunnel = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:8000'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let tunnelUrl = null;

  function parseLine(line) {
    if (tunnelUrl) return;
    const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      tunnelUrl = match[0];
      const hostname = new URL(tunnelUrl).hostname;
      waitForDns(hostname, () => {
        console.log(`  \x1b[32m→  Phone:  \x1b[0m  ${tunnelUrl}`);
        console.log(`  \x1b[33m→  Signal: \x1b[0m  signal.neevs.io`);
        console.log('');
      });
    }
  }

  // Poll DNS directly (no HTTP, no hanging connections)
  const resolver = new dns.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);

  function waitForDns(hostname, done) {
    let attempts = 0;
    const check = () => {
      attempts++;
      resolver.resolve4(hostname, (err) => {
        if (!err) return done();
        if (attempts > 30) {
          // Give up waiting, print anyway (DNS might work for the phone)
          console.log(`  \x1b[33m→  Warning:\x1b[0m  DNS slow to propagate, URL may need a moment`);
          return done();
        }
        setTimeout(check, 1000);
      });
    };
    check();
  }

  tunnel.stdout.on('data', (d) => d.toString().split('\n').forEach(parseLine));
  tunnel.stderr.on('data', (d) => d.toString().split('\n').forEach(parseLine));

  tunnel.on('close', (code) => {
    if (code) console.error('Tunnel exited with code', code);
    process.exit(code || 0);
  });

  process.on('SIGINT', () => { tunnel.kill(); process.exit(0); });
  process.on('SIGTERM', () => { tunnel.kill(); process.exit(0); });
});
