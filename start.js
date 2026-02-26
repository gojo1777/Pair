const router = require('express').Router();
const {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require('@whiskeyshokets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const { MongoClient } = require('mongodb');

/* ============================================================
   MONGO SETUP
   ============================================================ */
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://sayuramini41_db_user:L0MTttjRAvw9viC0@cluster0.ojtdvhh.mongodb.net/?retryWrites=true&w=majority';
const MONGO_DB  = process.env.MONGO_DB  || 'SAYURA-MD';

let mongoClient, mongoDB, sessionsCol;

async function initMongo() {
  try {
    if (mongoClient && mongoClient.topology?.isConnected?.()) return;
  } catch (e) {}
  mongoClient = new MongoClient(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 10000,
  });
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
const MAX_RETRIES    = 5;
const MAX_RECONNECT  = 5;
const delay = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   ACTIVE SOCKET TRACKER
   ============================================================ */
const activeSockets    = new Map();
const reconnectCounts  = new Map();

/* ============================================================
   CORE: CREATE SOCKET (reusable for first connect + reconnect)
   ============================================================ */
async function createSocket(number) {
  const sessionPath = path.join(os.tmpdir(), `session_${number}`);

  // Prefill from MongoDB
  try {
    const mongoDoc = await loadCredsFromMongo(number);
    if (mongoDoc && mongoDoc.creds) {
      fs.ensureDirSync(sessionPath);
      fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(mongoDoc.creds, null, 2));
      if (mongoDoc.keys) {
        fs.writeFileSync(path.join(sessionPath, 'keys.json'), JSON.stringify(mongoDoc.keys, null, 2));
      }
      console.log(`📦 Session prefilled from MongoDB for ${number}`);
    }
  } catch (e) { console.warn(`⚠️ Prefill failed for ${number}:`, e.message); }

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
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 15000,
    retryRequestDelayMs: 2000,
  });

  // ── Save creds on update ──
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
    } catch (err) { console.error(`creds.update error for ${number}:`, err); }
  });

  // ── Connection state handler (with reconnect) ──
  socket.ev.on('connection.update', async ({ connection, lastDisconnect }) => {

    if (connection === 'open') {
      activeSockets.set(number, socket);
      reconnectCounts.set(number, 0);
      console.log(`✅ ${number} connected`);
    }

    if (connection === 'close') {
      activeSockets.delete(number);

      const statusCode  = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isBanned    = statusCode === DisconnectReason.forbidden;

      console.log(`❌ ${number} disconnected | statusCode: ${statusCode}`);

      if (isLoggedOut || isBanned) {
        console.log(`🚫 ${number} logged out / banned. Clearing session.`);
        reconnectCounts.delete(number);
        try { fs.removeSync(sessionPath); } catch (e) {}
        return;
      }

      // Auto reconnect
      const attempts = reconnectCounts.get(number) || 0;
      if (attempts < MAX_RECONNECT) {
        reconnectCounts.set(number, attempts + 1);
        const waitMs = 3000 * (attempts + 1);
        console.log(`🔄 Reconnecting ${number} (${attempts + 1}/${MAX_RECONNECT}) in ${waitMs / 1000}s...`);
        await delay(waitMs);
        try {
          await createSocket(number);
        } catch (e) {
          console.error(`Reconnect failed for ${number}:`, e.message);
        }
      } else {
        console.log(`💀 Max reconnects reached for ${number}. Giving up.`);
        reconnectCounts.delete(number);
        try { fs.removeSync(sessionPath); } catch (e) {}
      }
    }
  });

  return socket;
}

/* ============================================================
   PAIRING ROUTE  →  GET /code?number=94771234567
   ============================================================ */
router.get('/', async (req, res) => {
  const number = (req.query.number || '').replace(/[^0-9]/g, '');

  if (!number || number.length < 7 || number.length > 15) {
    return res.status(400).json({ error: 'Invalid phone number. Use country code format e.g. 94771234567' });
  }

  // Already connected
  if (activeSockets.has(number)) {
    return res.json({ code: 'ALREADY_CONNECTED', message: 'This number is already linked.' });
  }

  try {
    await initMongo().catch(() => {});

    const socket = await createSocket(number);

    // Already registered — no pairing code needed
    if (socket.authState.creds.registered) {
      activeSockets.set(number, socket);
      return res.json({ code: 'ALREADY_REGISTERED', message: 'Session already registered.' });
    }

    // Request pairing code with retries
    let code;
    let retries = MAX_RETRIES;
    while (retries > 0) {
      try {
        await delay(1500);
        code = await socket.requestPairingCode(number);
        break;
      } catch (err) {
        retries--;
        console.warn(`⚠️ Pairing retry ${MAX_RETRIES - retries}/${MAX_RETRIES}: ${err.message}`);
        if (retries > 0) await delay(2000 * (MAX_RETRIES - retries + 1));
      }
    }

    if (!code) {
      if (!res.headersSent) return res.status(503).json({ error: 'Failed to get pairing code. Try again.' });
      return;
    }

    // Format: XXXX-XXXX
    const formatted = code.match(/.{1,4}/g)?.join('-') || code;
    if (!res.headersSent) return res.json({ code: formatted });

  } catch (error) {
    console.error('Pairing error:', error);
    if (!res.headersSent) return res.status(503).json({ error: 'Service unavailable. Please try again.' });
  }
});

module.exports = router;
