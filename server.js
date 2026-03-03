const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const ENC_KEY = crypto.createHash('sha256').update(process.env.BEERMEETS_SECRET || 'beermeets-dev-secret').digest();

const encryptText = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
};

const decryptText = (payload) => {
  const [ivB64, tagB64, dataB64] = String(payload || '').split(':');
  if (!ivB64 || !tagB64 || !dataB64) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plain.toString('utf8');
};

const ensureDataFile = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ registrations: [], ratings: [], users: [] }, null, 2));
  }
};

const normalizeStore = (parsed) => ({
  registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [],
  ratings: Array.isArray(parsed.ratings) ? parsed.ratings : [],
  users: Array.isArray(parsed.users) ? parsed.users : []
});

const readStore = () => {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  return normalizeStore(JSON.parse(raw || '{}'));
};

const writeStore = (store) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
};

const json = (res, status, payload, extraHeaders = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) {
      reject(new Error('Request too large'));
      req.destroy();
    }
  });
  req.on('end', () => resolve(body ? JSON.parse(body) : {}));
  req.on('error', reject);
});

const sendFile = (res, filePath) => {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
};

const parseOptional = (v) => (v === null || v === '' || v === undefined ? null : Number(v));
const validOptional = (v) => v === null || (!Number.isNaN(v) && v >= 1 && v <= 10);
const cleanName = (v) => String(v || '').trim();
const cleanEmail = (v) => String(v || '').trim().toLowerCase();
const validateEmail = (email) => /^\S+@\S+\.\S+$/.test(email);

const userByName = (store, name) => store.users.find((u) => String(u.name || '').toLowerCase() === String(name || '').toLowerCase());

const sanitizeUser = (user) => ({
  id: user.id,
  name: user.name,
  registrationLocked: !!user.registrationLocked,
  createdAt: user.createdAt,
  registrationLockedAt: user.registrationLockedAt || null,
  hasEmail: Boolean(user.encryptedEmail)
});

const parseCookies = (cookieHeader) => {
  const map = {};
  String(cookieHeader || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) map[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return map;
};

const validateRatingEntry = (entry, registrationsById) => {
  const beerId = String(entry.beerId || '');
  const overall = Number(entry.overall);
  const aroma = parseOptional(entry.aroma);
  const appearance = parseOptional(entry.appearance);
  const flavor = parseOptional(entry.flavor);
  const mouthfeel = parseOptional(entry.mouthfeel);

  if (!registrationsById.has(beerId)) return { ok: false };
  if (Number.isNaN(overall) || overall < 0 || overall > 10) return { ok: false };
  if (![aroma, appearance, flavor, mouthfeel].every(validOptional)) return { ok: false };

  return { ok: true, rating: { beerId, overall, aroma, appearance, flavor, mouthfeel } };
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendFile(res, path.join(ROOT, 'index.html'));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'beermeets_user=; Path=/; Max-Age=0; SameSite=Lax' });
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const store = readStore();
    const cookies = parseCookies(req.headers.cookie);
    const username = cleanName(cookies.beermeets_user);
    if (!username) return json(res, 401, { error: 'No active session' });
    const user = userByName(store, username);
    if (!user) return json(res, 401, { error: 'Session user not found' });
    return json(res, 200, sanitizeUser(user));
  }

  if (req.method === 'POST' && url.pathname === '/api/users/register') {
    try {
      const body = await readBody(req);
      const name = cleanName(body.name);
      const password = String(body.password || '');
      const email = cleanEmail(body.email);

      if (!name) return json(res, 400, { error: 'Name is required' });
      if (password.length < 4) return json(res, 400, { error: 'Password must be at least 4 chars' });
      if (!validateEmail(email)) return json(res, 400, { error: 'Invalid email' });

      const store = readStore();
      if (userByName(store, name)) return json(res, 409, { error: 'User already exists' });

      const user = {
        id: crypto.randomUUID(),
        name,
        encryptedPassword: encryptText(password),
        encryptedEmail: encryptText(email),
        registrationLocked: false,
        createdAt: Date.now()
      };

      store.users.push(user);
      writeStore(store);
      return json(res, 201, sanitizeUser(user));
    } catch {
      return json(res, 400, { error: 'Malformed JSON' });
    }
  }

  if ((req.method === 'POST' && url.pathname === '/api/users/login') || (req.method === 'POST' && url.pathname === '/api/login')) {
    try {
      const body = await readBody(req);
      const name = cleanName(body.name);
      const password = String(body.password || '');
      if (!name || !password) return json(res, 400, { error: 'Name and password are required' });

      const store = readStore();
      const user = userByName(store, name);
      if (!user) return json(res, 404, { error: 'User not found. Please register first.' });

      const storedPassword = decryptText(user.encryptedPassword);
      if (!storedPassword || storedPassword !== password) return json(res, 401, { error: 'Invalid password' });

      return json(res, 200, sanitizeUser(user), { 'Set-Cookie': `beermeets_user=${encodeURIComponent(user.name)}; Path=/; Max-Age=2592000; SameSite=Lax` });
    } catch {
      return json(res, 400, { error: 'Malformed JSON' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/registration/lock') {
    try {
      const body = await readBody(req);
      const name = cleanName(body.name);
      if (!name) return json(res, 400, { error: 'Name is required' });

      const store = readStore();
      const user = userByName(store, name);
      if (!user) return json(res, 404, { error: 'User not found' });

      user.registrationLocked = true;
      user.registrationLockedAt = Date.now();
      writeStore(store);
      return json(res, 200, { ok: true, user: sanitizeUser(user) });
    } catch {
      return json(res, 400, { error: 'Malformed JSON' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/registrations') {
    const store = readStore();
    const brewerName = cleanName(url.searchParams.get('brewerName'));
    const payload = brewerName
      ? store.registrations.filter((r) => String(r.brewerName || '').toLowerCase() === brewerName.toLowerCase())
      : store.registrations;
    return json(res, 200, payload);
  }

  if (req.method === 'POST' && url.pathname === '/api/registrations') {
    try {
      const body = await readBody(req);
      const brewerName = cleanName(body.brewerName);
      const beerName = cleanName(body.beerName);
      const beerStyle = cleanName(body.beerStyle);
      const beerAbv = Number(body.beerAbv);
      if (!brewerName || !beerName || !beerStyle || Number.isNaN(beerAbv) || beerAbv < 0 || beerAbv > 25) return json(res, 400, { error: 'Invalid registration data' });

      const store = readStore();
      const user = userByName(store, brewerName);
      if (!user) return json(res, 404, { error: 'User not found' });
      if (user.registrationLocked) return json(res, 403, { error: 'Registration is locked for this user' });

      const record = { id: crypto.randomUUID(), brewerName, beerName, beerStyle, beerAbv, createdAt: Date.now() };
      store.registrations.push(record);
      writeStore(store);
      return json(res, 201, record);
    } catch {
      return json(res, 400, { error: 'Malformed JSON' });
    }
  }

  if (req.method === 'PUT' && url.pathname.startsWith('/api/registrations/')) {
    try {
      const id = url.pathname.split('/').pop();
      const body = await readBody(req);
      const brewerName = cleanName(body.brewerName);
      const beerName = cleanName(body.beerName);
      const beerStyle = cleanName(body.beerStyle);
      const beerAbv = Number(body.beerAbv);
      if (!id || !brewerName || !beerName || !beerStyle || Number.isNaN(beerAbv) || beerAbv < 0 || beerAbv > 25) return json(res, 400, { error: 'Invalid update data' });

      const store = readStore();
      const user = userByName(store, brewerName);
      if (!user) return json(res, 404, { error: 'User not found' });
      if (user.registrationLocked) return json(res, 403, { error: 'Registration is locked for this user' });

      const item = store.registrations.find((r) => r.id === id);
      if (!item) return json(res, 404, { error: 'Beer not found' });
      if (String(item.brewerName).toLowerCase() !== brewerName.toLowerCase()) return json(res, 403, { error: 'Cannot edit another brewer beer' });

      item.beerName = beerName;
      item.beerStyle = beerStyle;
      item.beerAbv = beerAbv;
      item.updatedAt = Date.now();
      writeStore(store);
      return json(res, 200, item);
    } catch {
      return json(res, 400, { error: 'Malformed JSON' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/ratings') return json(res, 200, readStore().ratings);

  if (req.method === 'POST' && url.pathname === '/api/ratings/batch') {
    try {
      const body = await readBody(req);
      const judgeName = cleanName(body.judgeName);
      const incoming = Array.isArray(body.ratings) ? body.ratings : [];
      const store = readStore();
      const knownBrewers = new Set(store.registrations.map((r) => String(r.brewerName).toLowerCase()));

      if (!judgeName || !knownBrewers.has(judgeName.toLowerCase())) return json(res, 400, { error: 'Unknown judge' });
      if (incoming.length !== store.registrations.length || incoming.length === 0) return json(res, 400, { error: 'Must provide ratings for all registered beers' });

      const registrationsById = new Map(store.registrations.map((r) => [r.id, r]));
      const uniqueBeerIds = new Set();
      const prepared = [];
      for (const entry of incoming) {
        const checked = validateRatingEntry(entry, registrationsById);
        if (!checked.ok) return json(res, 400, { error: 'Invalid rating data' });
        if (uniqueBeerIds.has(checked.rating.beerId)) return json(res, 400, { error: 'Duplicate beer rating' });
        uniqueBeerIds.add(checked.rating.beerId);
        prepared.push({ id: crypto.randomUUID(), judgeName, ...checked.rating, createdAt: Date.now() });
      }
      if (uniqueBeerIds.size !== store.registrations.length) return json(res, 400, { error: 'Missing beer ratings' });

      const judgeLower = judgeName.toLowerCase();
      store.ratings = store.ratings.filter((r) => String(r.judgeName || '').toLowerCase() !== judgeLower);
      store.ratings.push(...prepared);
      writeStore(store);
      return json(res, 201, { inserted: prepared.length });
    } catch {
      return json(res, 400, { error: 'Malformed JSON' });
    }
  }

  if (req.method === 'DELETE' && url.pathname === '/api/all') {
    writeStore({ registrations: [], ratings: [], users: [] });
    return json(res, 200, { ok: true });
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  ensureDataFile();
  console.log(`BeerMeets server running on http://0.0.0.0:${PORT}`);
});
