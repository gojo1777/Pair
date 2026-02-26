const router = require('express').Router();
const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, jidNormalizedUser } = require('@whiskeyshokets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const { MongoClient } = require('mongodb');

/* ============================================================
   MONGO SETUP
   ============================================================ */
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://botmini:botmini@minibot.upglk0f.mongodb.net/?retryWrites=true&w=majority';
const MONGO_DB  = process.env.MONGO_DB  || 'SHALA-MD';

let mongoClient, mongoDB, sessionsCol;

async function initMongo() {
  try {
    if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected && mongoClient.topology.isConnected()) return;
  } catch (e) {}
  mongoClient = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await mongoClient.connect();
  mongoDB     = mongoClient.db(MONGO_DB);
  sessionsCol = mongoDB.collection('sessions');
  await sessionsCol.createIndex({ number: 1 }, { unique: true });
  console.log('✅ MongoDB connected');
}

async function saveCredsToMongo(number, creds, keys = null) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await sessionsCol.updateOne(
      { number: sanitized },
      { $set: { number: sanitized, creds, keys, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log(`✅ Creds saved to MongoDB for ${sanitized}`);
  } catch (e) { console.error('saveCredsToMongo error:', e); }
}

async function loadCredsFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    return await sessionsCol.findOne({ number: sanitized }) || null;
  } catch (e) { console.error('loadCredsFromMongo error:', e); return null; }
}

/* ============================================================
   CONFIG
   ============================================================ */
const config = {
  MAX_RETRIES: 5,
};

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   ACTIVE SOCKET TRACKER
   ============================================================ */
const activeSockets = new Map();

/* ============================================================
   PAIRING ROUTE  →  GET /code?number=94771234567
   ============================================================ */
router.get('/', async (req, res) => {
  const number = (req.query.number || '').replace(/[^0-9]/g, '');

  if (!number || number.length < 7 || number.length > 15) {
    return res.status(400).json({ error: 'Invalid phone number. Use country code format e.g. 94771234567' });
  }

  // If already connected, return info
  if (activeSockets.has(number)) {
    return res.json({ code: 'ALREADY_CONNECTED', message: 'This number is already linked.' });
  }

  const sessionPath = path.join(os.tmpdir(), `session_${number}`);

  try {
    // Prefill from Mongo if available
    await initMongo().catch(() => {});
    try {
      const mongoDoc = await loadCredsFromMongo(number);
      if (mongoDoc && mongoDoc.creds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(mongoDoc.creds, null, 2));
        if (mongoDoc.keys) {
          fs.writeFileSync(path.join(sessionPath, 'keys.json'), JSON.stringify(mongoDoc.keys, null, 2));
        }
        console.log(`📦 Prefilled session from MongoDB for ${number}`);
      }
    } catch (e) { console.warn('Prefill failed:', e.message); }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' });

    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    // Save creds to Mongo on update
    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        const credsPath = path.join(sessionPath, 'creds.json');
        if (!fs.existsSync(credsPath)) return;
        const raw = fs.readFileSync(credsPath, 'utf8').trim();
        if (!raw || raw === '{}' || raw === 'null') return;
        const credsObj = JSON.parse(raw);
        if (!credsObj || typeof credsObj !== 'object') return;
        await saveCredsToMongo(number, credsObj, state.keys || null);
      } catch (err) { console.error('creds.update save error:', err); }
    });

    // Cleanup on close
    socket.ev.on('connection.update', async ({ connection }) => {
      if (connection === 'open') {
        activeSockets.set(number, socket);
        console.log(`✅ ${number} connected`);
      }
      if (connection === 'close') {
        activeSockets.delete(number);
        try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch (e) {}
        console.log(`❌ ${number} disconnected`);
      }
    });

    // Request pairing code
    if (!socket.authState.creds.registered) {
      let retries = config.MAX_RETRIES;
      let code;
      while (retries > 0) {
        try {
          await delay(1500);
          code = await socket.requestPairingCode(number);
          break;
        } catch (err) {
          retries--;
          console.warn(`Retry ${config.MAX_RETRIES - retries}/${config.MAX_RETRIES}:`, err.message);
          await delay(2000 * (config.MAX_RETRIES - retries));
        }
      }

      if (!code) {
        if (!res.headersSent) return res.status(503).json({ error: 'Failed to get pairing code. Try again.' });
        return;
      }

      if (!res.headersSent) return res.json({ code });
    } else {
      activeSockets.set(number, socket);
      if (!res.headersSent) return res.json({ code: 'ALREADY_REGISTERED', message: 'Session already registered.' });
    }

  } catch (error) {
    console.error('Pairing error:', error);
    try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch (e) {}
    if (!res.headersSent) return res.status(503).json({ error: 'Service unavailable. Please try again.' });
  }
});

module.exports = router;
