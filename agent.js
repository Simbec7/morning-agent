require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = 3000;

const CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RUNNA_ICAL = process.env.RUNNA_ICAL;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/callback';
const IS_CLOUD = !!process.env.RAILWAY_ENVIRONMENT_NAME;
const TOKEN_FILE = IS_CLOUD ? '/data/whoop_token.json' : './whoop_token.json';

console.log('[TOKEN] Prostredi:', IS_CLOUD ? 'Railway (cloud)' : 'lokalni PC');
console.log('[TOKEN] Cesta k tokenu:', TOKEN_FILE);

function saveToken(data) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data));
    console.log('[TOKEN] Token ulozen do souboru:', TOKEN_FILE);
  } catch(e) {
    console.log('[TOKEN] Zapis do souboru se nezdaril:', e.message);
  }
}

function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE));
      console.log('[TOKEN] Nacteno z souboru:', TOKEN_FILE);
      return data;
    }
  } catch(e) {
    console.log('[TOKEN] Soubor nelze precist:', e.message);
  }
  if (process.env.WHOOP_REFRESH_TOKEN) {
    console.log('[TOKEN] Soubor nenalezen - pouzivam WHOOP_REFRESH_TOKEN z env var.');
    return { refresh_token: process.env.WHOOP_REFRESH_TOKEN };
  }
  console.log('[TOKEN] Zadny token nenalezen (ani soubor, ani env var).');
  return null;
}

async function refreshWhoopToken(rt) {
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', rt);
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  const res = await axios.post('https://api.prod.whoop.com/oauth/oauth2/token', params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return res.data;
}

async function getValidToken() {
  const saved = loadToken();
  if (!saved) return null;
  try {
    console.log('[TOKEN] Obnovovani WHOOP tokenu...');
    const newToken = await refreshWhoopToken(saved.refresh_token);
    saveToken(newToken);
    console.log('[TOKEN] Refresh uspesny, novy access_token ziskan.');
    return newToken.access_token;
  } catch(e) {
    console.log('[TOKEN] Refresh selhal:', e.response?.status, e.response?.data || e.message);
    return null;
  }
}

function parseIcalToday(icalText) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0,10).replace(/-/g,'');
  
  const events = [];
  const blocks = icalText.split('BEGIN:VEVENT');
  
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const dtstart = (block.match(/DTSTART[^:]*:(\d+)/) || [])[1] || '';
    if (!dtstart.startsWith(todayStr)) continue;
    
    const summary = (block.match(/SUMMARY:(.+)/) || [])[1] || '?';
    const desc = (block.match(/DESCRIPTION:(.+?)(\r?\n[A-Z])/) || block.match(/DESCRIPTION:(.+)/s) || [])[1] || '';
    const cleanDesc = desc.replace(/\\n/g, '\n').replace(/\\/g, '').substring(0, 400);
    
    events.push(summary.trim() + (cleanDesc ? '\n' + cleanDesc.trim() : ''));
  }
  
  return events.length > 0 ? events.join('\n\n') : 'Dnes neni zadny trenink v Runna planu.';
}

async function getTodayRunna() {
  try {
    const res = await axios.get(RUNNA_ICAL, { responseType: 'text' });
    return parseIcalToday(res.data);
  } catch(e) {
    console.log('Runna iCal chyba:', e.message);
    return 'Runna data nedostupna.';
  }
}

async function startAutoMode() {
  const token = await getValidToken();
  if (token) {
    whoopToken = token;
    await runAgent();
  } else {
    startServer();
  }
}

let whoopToken = null;

function startServer() {
  app.listen(PORT, () => {
    console.log('Server bezi, otevri: http://localhost:' + PORT + '/login');
  });
}

app.get('/login', (req, res) => {
  const state = Math.random().toString(36).substring(2, 15);
  const url = 'https://api.prod.whoop.com/oauth/oauth2/auth'
    + '?client_id=' + CLIENT_ID
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
    + '&response_type=code'
    + '&scope=read:recovery%20read:cycles%20read:sleep%20read:workout%20read:profile%20offline'
    + '&state=' + state;
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) { res.send('Chyba: chybi code.'); return; }
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', REDIRECT_URI);
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    const tokenRes = await axios.post('https://api.prod.whoop.com/oauth/oauth2/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    saveToken(tokenRes.data);
    whoopToken = tokenRes.data.access_token;
    res.send('<h2>WHOOP pripojeno! Zavri okno.</h2>');
    setTimeout(runAgent, 1000);
  } catch (e) {
    res.send('Chyba: ' + (e.response?.data ? JSON.stringify(e.response.data) : e.message));
  }
});

async function getWhoopData() {
  const headers = { Authorization: 'Bearer ' + whoopToken };
  const [cycles, sleep, recovery] = await Promise.all([
    axios.get('https://api.prod.whoop.com/developer/v2/cycle', { headers, params: { limit: 1 } }),
    axios.get('https://api.prod.whoop.com/developer/v2/activity/sleep', { headers, params: { limit: 1 } }),
    axios.get('https://api.prod.whoop.com/developer/v2/recovery', { headers, params: { limit: 1 } }),
  ]);
  return {
    cycle: cycles.data.records[0],
    sleep: sleep.data.records[0],
    recovery: recovery.data.records[0],
  };
}

async function sendTelegram(text) {
  await axios.post('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text: text,
    parse_mode: 'Markdown',
  });
  console.log('Telegram zprava odeslana!');
}

async function runAgent() {
  console.log('Nacitam WHOOP data...');
  let whoop;
  try {
    whoop = await getWhoopData();
  } catch (e) {
    console.log('WHOOP API chyba:', e.response?.status, JSON.stringify(e.response?.data) || e.message);
    process.exit(1);
  }

  console.log('Nacitam Runna trenink...');
  const runnaToday = await getTodayRunna();

  const cycle = whoop.cycle;
  const sleep = whoop.sleep;
  const recovery = whoop.recovery;
  const recoveryScore = recovery?.score?.recovery_score ?? 'N/A';
  const hrv = recovery?.score?.hrv_rmssd_milli ?? 'N/A';
  const rhr = recovery?.score?.resting_heart_rate ?? 'N/A';
  const strain = cycle?.score?.strain ?? 'N/A';
  const sleepScore = sleep?.score?.sleep_performance_percentage ?? 'N/A';
  const today = new Date().toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' });

  console.log('Recovery: ' + recoveryScore + '% | Spanek: ' + sleepScore + '%');
  console.log('Trenink: ' + runnaToday.split('\n')[0]);
  console.log('Ptam se Clauda...');

  const prompt = 'Jsi muj osobni trener a ranní kouc. Dnes je ' + today + '.\n\n'
    + 'Moje dnesni WHOOP data:\n'
    + '- Recovery score: ' + recoveryScore + '%\n'
    + '- HRV: ' + hrv + ' ms\n'
    + '- Klidova tepova frekvence: ' + rhr + ' bpm\n'
    + '- Spanek score: ' + sleepScore + '%\n'
    + '- Vcerejsi strain: ' + strain + '\n\n'
    + 'Dnesni trenink dle Runna planu:\n' + runnaToday + '\n\n'
    + 'Moje cile: OCR zavod Prostejov 3.10.2026 (cil 1:15), Lipno Trifecta 10-12.10.2026.\n\n'
    + 'Na zaklade mych WHOOP dat a dnesniho Runna treninku mi rekni:\n'
    + '1. Kratke zhodnoceni recovery (1-2 vety)\n'
    + '2. Jak presne provest dnesni trenink - upravene dle recovery (konkretni tempo, TF zony)\n'
    + '3. Jedna vec na kterou se dnes zamerit\n'
    + '4. Doporuceni k regeneraci\n\n'
    + 'Odpovez cesky, strucne, max 200 slov. Pouzij Markdown formatovani.';

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  }, {
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    }
  });

  const brief = response.data.content[0].text;
  const telegramMsg = '*Ranní brief - ' + today + '*\n\n'
    + 'Recovery: *' + recoveryScore + '%* | HRV: *' + hrv + 'ms* | RHR: *' + rhr + 'bpm* | Spánek: *' + sleepScore + '%*\n\n'
    + '*Dnes:* ' + runnaToday.split('\n')[0] + '\n\n'
    + brief;

  console.log('\n=======================================');
  console.log('RARNI BRIEF - ' + today.toUpperCase());
  console.log('=======================================');
  console.log(brief);
  console.log('=======================================\n');

  await sendTelegram(telegramMsg);
  process.exit(0);
}

startAutoMode();
