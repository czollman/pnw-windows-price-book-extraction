'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const { google } = require('googleapis');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH       = path.join(__dirname, 'token.json');
const SCOPES           = ['https://www.googleapis.com/auth/spreadsheets'];
const PORT             = 3000;
const REDIRECT_URI     = `http://localhost:${PORT}/oauth2callback`;

async function authorize() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `credentials.json not found.\n` +
      `  1. Go to console.cloud.google.com → APIs & Services → Credentials\n` +
      `  2. Create OAuth 2.0 Client ID → Desktop app\n` +
      `  3. Download JSON → save as credentials.json in this folder`
    );
  }

  const raw   = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const creds = raw.installed || raw.web;
  if (!creds) throw new Error('credentials.json format not recognised — expected "installed" or "web" key');

  const client = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);

  // ── reuse saved token ────────────────────────────────────────────────────────
  if (fs.existsSync(TOKEN_PATH)) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    client.setCredentials(saved);
    // Proactively refresh if within 5 minutes of expiry
    if (saved.expiry_date && saved.expiry_date - Date.now() < 5 * 60 * 1000) {
      const { credentials } = await client.refreshAccessToken();
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2));
      client.setCredentials(credentials);
    }
    return client;
  }

  // ── first-time browser consent flow ─────────────────────────────────────────
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',          // force refresh_token to be returned
  });

  process.stderr.write('\n──────────────────────────────────────────────────\n');
  process.stderr.write('First-time Google authorization required.\n');
  process.stderr.write('Opening your browser — authorize the app, then\n');
  process.stderr.write('return here. It will continue automatically.\n\n');
  process.stderr.write(`If the browser does not open, visit:\n${authUrl}\n`);
  process.stderr.write('──────────────────────────────────────────────────\n\n');

  // Open browser on Windows
  exec(`start "" "${authUrl}"`);

  // Spin up a temporary local server to receive the OAuth redirect
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url  = new URL(req.url, `http://localhost:${PORT}`);
        const code = url.searchParams.get('code');
        const err  = url.searchParams.get('error');

        if (err) {
          res.writeHead(400); res.end(`Authorization denied: ${err}`);
          server.close(); reject(new Error(`OAuth denied: ${err}`));
          return;
        }
        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html><body style="font-family:sans-serif;padding:40px">
              <h2 style="color:#1a73e8">Authorization successful!</h2>
              <p>You can close this tab and return to the terminal.</p>
            </body></html>
          `);
          server.close();
          resolve(code);
        }
      } catch (e) {
        res.writeHead(500); res.end('Internal error');
        server.close(); reject(e);
      }
    });

    server.listen(PORT, () =>
      process.stderr.write(`Waiting for Google callback on port ${PORT}...\n`)
    );
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`Port ${PORT} is already in use. Close whatever is using it and try again.`));
      } else {
        reject(e);
      }
    });
  });

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  process.stderr.write('Authorization complete — token.json saved.\n\n');

  return client;
}

module.exports = { authorize };
