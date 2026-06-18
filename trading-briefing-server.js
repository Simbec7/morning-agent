/**
 * Local server for the Trading Briefing tool.
 * Run: node trading-briefing-server.js
 * Then open: http://localhost:3333
 *
 * Required env vars (from .env):
 *   GOOGLE_API_KEY
 *   ANTHROPIC_API_KEY
 */

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = 3333;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!GOOGLE_API_KEY) console.warn('[WARN] GOOGLE_API_KEY not set in .env');
if (!ANTHROPIC_API_KEY) console.warn('[WARN] ANTHROPIC_API_KEY not set in .env');

// ---------- tiny HTTPS helper ----------
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------- request handlers ----------
async function handleSheets(req, res, body) {
  const { spreadsheetId, range } = body;
  if (!spreadsheetId || !range) {
    res.writeHead(400); res.end(JSON.stringify({ error: 'Missing spreadsheetId or range' })); return;
  }
  const encodedRange = encodeURIComponent(range);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}?key=${GOOGLE_API_KEY}`;
  try {
    const result = await httpsGet(url);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  } catch (e) {
    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleClaude(req, res, body) {
  const { system, user } = body;
  if (!system || !user) {
    res.writeHead(400); res.end(JSON.stringify({ error: 'Missing system or user' })); return;
  }
  try {
    const result = await httpsPost(
      'api.anthropic.com',
      '/v1/messages',
      {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: user }],
      }
    );
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  } catch (e) {
    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/trading-briefing.html')) {
    const htmlPath = path.join(__dirname, 'trading-briefing.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404); res.end('trading-briefing.html not found');
    }
    return;
  }

  if (req.method === 'POST') {
    let rawBody = '';
    req.on('data', (c) => (rawBody += c));
    await new Promise((r) => req.on('end', r));
    let parsed;
    try { parsed = JSON.parse(rawBody); } catch { res.writeHead(400); res.end('Bad JSON'); return; }

    if (req.url === '/api/sheets') { await handleSheets(req, res, parsed); return; }
    if (req.url === '/api/claude') { await handleClaude(req, res, parsed); return; }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Trading Briefing server running at http://localhost:${PORT}`);
  console.log('Open that URL in your browser.');
});
