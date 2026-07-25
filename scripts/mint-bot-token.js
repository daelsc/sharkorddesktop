#!/usr/bin/env node
// Runs ON duper. Creates a SharkovBot user (if missing) and mints a 10-year JWT
// signed with the server's secret_token (read from sqlite, never printed).
// Prints ONLY the JWT to stdout. All other output goes to stderr.
const { execSync } = require('child_process');
const crypto = require('crypto');

const DB = '/mnt/user/appdata/sharkord/db.sqlite';
const BOT_IDENTITY = 'sharkovbot';
const BOT_NAME = 'SharkovBot';
const NOW = Math.floor(Date.now() / 1000);
const TEN_YEARS = 10 * 365 * 24 * 3600;

function sql(q) {
  return execSync('sqlite3 ' + JSON.stringify(DB) + ' ' + JSON.stringify(q), { encoding: 'utf8' }).trim();
}

// 1. Read secret_token (never echo it)
const secret = sql('SELECT secret_token FROM settings LIMIT 1;');
if (!secret) { console.error('no secret_token in settings'); process.exit(1); }

// 2. Find or create the bot user
let botId = sql("SELECT id FROM users WHERE identity = '" + BOT_IDENTITY + "';");
if (!botId) {
  const pw = crypto.randomBytes(24).toString('hex');
  sql("INSERT INTO users (identity, password, name, banned, last_login_at, created_at, updated_at) VALUES ('" +
      BOT_IDENTITY + "', '" + pw + "', '" + BOT_NAME + "', 0, " + NOW + ", " + NOW + ", " + NOW + ");");
  botId = sql("SELECT id FROM users WHERE identity = '" + BOT_IDENTITY + "';");
  console.error('created bot user id=' + botId);
} else {
  console.error('bot user exists id=' + botId);
}
if (!botId) { console.error('failed to get bot id'); process.exit(1); }

// 3. Hand-mint an HS256 JWT: base64url(header).base64url(payload).sig
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = b64url(JSON.stringify({ userId: parseInt(botId, 10), iat: NOW, exp: NOW + TEN_YEARS }));
const signingInput = header + '.' + payload;
const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
const token = signingInput + '.' + b64url(sig);

// stdout: ONLY the token
process.stdout.write(token + '\n');
