import puppeteer from 'puppeteer-core';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import fetch from 'node-fetch';
import express from 'express';
import bodyParser from 'body-parser';
import qrcode from 'qrcode';
import cloudinary from 'cloudinary';
import jwt from 'jsonwebtoken';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config(); // Load .env file

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// ✅ Cloudinary config (gunakan v2)
cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ✅ Firebase Service Account
const serviceAccount = {
  type: 'service_account',
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  token_uri: 'https://oauth2.googleapis.com/token',
};

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: serviceAccount.token_uri,
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore',
  };

  const jwtToken = jwt.sign(payload, serviceAccount.private_key, { algorithm: 'RS256' });

  const response = await fetch(serviceAccount.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwtToken,
    }),
  });

  const data = await response.json();
  if (!data.access_token) {
    console.error('❌ Gagal ambil access token:', data);
    throw new Error(`Gagal ambil access token: ${data.error_description || JSON.stringify(data)}`);
  }

  return data.access_token;
}

// === WhatsApp Client ===
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'PMY' }),
  puppeteer: {
    browserWSEndpoint: process.env.BROWSERLESS_WS,
    args: ['--no-sandbox']
  }
});

// === QR Handler ===
client.on('qr', async (qr) => {
  console.log(`[PMY] Scan QR berikut:`);
  const url = await qrcode.toDataURL(qr);
  const result = await cloudinary.v2.uploader.upload(url, {
    folder: 'whatsapp_qrcodes',
    public_id: `qr_PMY`,
    resource_type: 'image',
  });
  console.log(`[PMY] QR uploaded: ${result.secure_url}`);
});

// === Status Logger ===
client.on('ready', () => console.log(`✅ [PMY] Bot siap digunakan!`));
client.on('auth_failure', msg => console.error(`❌ [PMY] Gagal autentikasi:`, msg));
client.on('disconnected', reason => {
  console.warn(`⚠️ [PMY] Terputus:`, reason);
  process.exit(); // agar PM2 restart otomatis
});
client.on('loading_screen', (percent, message) => {
  console.log(`🌀 [PMY] Loading ${percent}% - ${message}`);
});

// === Message Handler ===
client.on('message', async (msg) => {
  console.log(`[PMY] Pesan dari ${msg.from} ke ${msg.to}: "${msg.body}" pada ${new Date(msg.timestamp * 1000).toLocaleString()}`);
  if (msg.fromMe) return;

  try {
    const accessToken = await getAccessToken();

    const basePayload = {
      from: msg.from,
      text: msg.caption || msg.body || '',
      access_token: accessToken,
      timestamp: new Date().toISOString(),
    };

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      const isVoice = msg.type === 'ptt';

      const buffer = Buffer.from(media.data, 'base64');
      const extension = media.mimetype.split('/')[1]?.split(';')[0] || 'bin';
      const tempFilePath = join(tmpdir(), `${uuidv4()}.${extension}`);
      writeFileSync(tempFilePath, buffer);

      const upload = await cloudinary.v2.uploader.upload(tempFilePath, {
        folder: 'wa-inbox-files',
        resource_type: 'auto',
      });

      unlinkSync(tempFilePath);

      basePayload.imageUrl = upload.secure_url;
      basePayload.mimetype = media.mimetype;
      basePayload.isVoiceNote = isVoice;
    }

    // === Coba kirim ke webhook test dulu
    let testResponse;
    try {
      testResponse = await fetch(process.env.WEBHOOK_TEST, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basePayload),
      });

      if (testResponse.ok) {
        console.log(`[PMY] ✅ Pesan diteruskan ke webhook TEST (${testResponse.status})`);
        return; // sukses, tidak lanjut ke webhook prod
      } else {
        console.warn(`[PMY] ⚠️ Gagal webhook TEST, status: ${testResponse.status}`);
      }
    } catch (err) {
      console.warn(`[PMY] ❌ Error webhook TEST: ${err.message}`);
    }

    // === Jika gagal kirim ke webhook test, kirim ke production
    try {
      const prodResponse = await fetch(process.env.WEBHOOK_PROD, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basePayload),
      });

      console.log(`[PMY] ⛔️ Bukan pesan test webhook, diteruskan ke webhook PROD (${prodResponse.status})`);
    } catch (err) {
      console.error(`[PMY] ❌ Gagal kirim ke webhook PROD:`, err.message);
    }

  } catch (err) {
    console.error(`[PMY] ❌ Gagal proses pesan masuk:`, err.message);
  }
});

// === Endpoint Balasan ===
app.post('/reply-pmy', async (req, res) => {
  try {
    console.log(`[PMY] Payload masuk ke /reply:`, JSON.stringify(req.body, null, 2));
    const payload = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : typeof req.body.data === 'string'
        ? JSON.parse(req.body.data)
        : req.body.data || req.body;

    const { from, reply, imageUrl, caption } = payload;

    if (!from || (!reply && !imageUrl)) {
      return res.status(400).json({ error: 'from dan reply/imageUrl wajib' });
    }

    if (Array.isArray(imageUrl)) {
      if (imageUrl.length === 1) {
        const media = await MessageMedia.fromUrl(imageUrl[0], { unsafeMime: true });
        await client.sendMessage(from, media, { caption: caption || reply || '' });
      } else {
        const mediaList = await Promise.all(
          imageUrl.map(async (url) => await MessageMedia.fromUrl(url, { unsafeMime: true }))
        );

        console.log(`[PMY] Kirim ${mediaList.length} gambar ke ${from}`);
        for (let i = 0; i < mediaList.length; i++) {
          const options = i === 0 ? { caption: caption || reply || '' } : {};
          await client.sendMessage(from, mediaList[i], options);
        }
      }
    } else if (typeof imageUrl === 'string') {
      const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
      await client.sendMessage(from, media, { caption: caption || reply || '' });
    } else {
      await client.sendMessage(from, reply);
    }

    res.json({ success: true });
  } catch (err) {
    console.error(`[PMY] Error balas:`, err.message);
    res.status(500).json({ error: 'Gagal balas', detail: err.message });
  }
});

// === Server Start ===
app.get('/', (req, res) => {
  res.send('✅ WhatsApp bot aktif!');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  startBot();
});

async function startBot() {
  try {
    console.log('🔄 Inisialisasi PMY...');
    await client.initialize();
    console.log('✅ Inisialisasi PMY selesai');
  } catch (err) {
    console.error('❌ Gagal inisialisasi PMY:', err.message);
  }
}

/* setInterval(async () => {
  try {
    const state = await client.getState();
    console.log(`[PING] Bot state: ${state}`);
    if (state !== 'CONNECTED') {
      console.log('[RESTART] State bukan CONNECTED, force exit...');
      process.exit(); // PM2 akan restart otomatis
    }
  } catch (err) {
    console.log('[RESTART] Gagal ambil state:', err.message);
    process.exit();
  }
}, 300000); */

client.on('disconnected', (reason) => {
  console.log('❌ WhatsApp terputus:', reason);
  process.exit(); // biarkan PM2 atau Render restart
});
