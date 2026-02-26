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
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://botmini:botmini@minibot.upglk0f.mongodb.net/?retryWrites=true&w=majority';
const MONGO_DB  = process.env.MONGO_DB  || 'SHALA-MD';

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
    console.log('✅ Creds saved to MongoDB for ' + sanitized);
  } catch (e) { console.error('saveCredsToMongo error:', e); }
}

/* ============================================================
   CONFIG
   ============================================================ */
const MAX_RETRIES = 5;
const delay = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   ACTIVE SOCKET TRACKER
   ============================================================ */
const activeSockets = new Map();

/* ============================================================
   PAIRING ROUTE  GET /code?number=94771234567
   ============================================================ */
router.get('/', async (req, res) => {
  const number = (req.query.number || '').replace(/[^0-9]/g, '');

  if (!number || number.length < 7 || number.length > 15) {
    return res.status(400).json({ error: 'Invalid phone number. Use country code format e.g. 94771234567' });
  }

  if (activeSockets.has(number)) {
    return res.json({ code: 'ALREADY_CONNECTED', message: 'This number is already linked.' });
  }

  // FRESH temp session - never load old creds (causes 405 connectionReplaced)
  const sessionPath = path.join(os.tmpdir(), 'pair_session_' + number + '_' + Date.now());

  try {
    await initMongo().catch(() => {});
    fs.ensureDirSync(sessionPath);

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
    });

    // Save creds to MongoDB after pairing
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
      } catch (err) { console.error('creds.update error for ' + number + ':', err); }
    });

    // Connection state - NO reconnect (pair server only pairs)
    socket.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      if (connection === 'open') {
        activeSockets.set(number, socket);
        console.log('✅ ' + number + ' paired and connected');
      }

      if (connection === 'close') {
        activeSockets.delete(number);
        try { fs.removeSync(sessionPath); } catch (e) {}

        if (statusCode === 405) {
          // connectionReplaced - main bot took over after pairing (EXPECTED / NORMAL)
          console.log('✅ ' + number + ' session handed to main bot (405 normal)');
        } else if (statusCode === DisconnectReason.loggedOut) {
          console.log('🚫 ' + number + ' logged out');
        } else {
          console.log('❌ ' + number + ' disconnected | statusCode: ' + statusCode);
        }
        // NO reconnect here - pair server job is done
      }
    });

    // Request pairing code
    if (!socket.authState.creds.registered) {
      let retries = MAX_RETRIES;
      let code;
      while (retries > 0) {
        try {
          await delay(1500);
          code = await socket.requestPairingCode(number);
          break;
        } catch (err) {
          retries--;
          console.warn('⚠️ Pairing retry ' + (MAX_RETRIES - retries) + '/' + MAX_RETRIES + ': ' + err.message);
          if (retries > 0) await delay(2000 * (MAX_RETRIES - retries + 1));
        }
      }

      if (!code) {
        try { fs.removeSync(sessionPath); } catch (e) {}
        if (!res.headersSent) return res.status(503).json({ error: 'Failed to get pairing code. Try again.' });
        return;
      }

      const formatted = code.match(/.{1,4}/g)?.join('-') || code;
      console.log('🔑 Pairing code for ' + number + ': ' + formatted);
      if (!res.headersSent) return res.json({ code: formatted });

    } else {
      activeSockets.set(number, socket);
      if (!res.headersSent) return res.json({ code: 'ALREADY_REGISTERED', message: 'Session already registered.' });
    }

  } catch (error) {
    console.error('Pairing error:', error);
    try { fs.removeSync(sessionPath); } catch (e) {}
    if (!res.headersSent) return res.status(503).json({ error: 'Service unavailable. Please try again.' });
  }
});

module.exports = router;
