const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const ensureDataFile = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ registrations: [], ratings: [] }, null, 2));
  }
};

const readStore = () => {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const parsed = JSON.parse(raw || '{}');
  return {
    registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [],
    ratings: Array.isArray(parsed.ratings) ? parsed.ratings : []
  };
};

const writeStore = (store) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
};

const json = (res, status, payload) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
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
  req.on('end', () => {
    if (!body) {
      resolve({});
      return;
    }
    resolve(JSON.parse(body));
  });
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

  return {
    ok: true,
    rating: { beerId, overall, aroma, appearance, flavor, mouthfeel }
  };
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendFile(res, path.join(ROOT, 'index.html'));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/registrations') {
    json(res, 200, readStore().registrations);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/registrations') {
    try {
      const body = await readBody(req);
      const brewerName = String(body.brewerName || '').trim();
      const beerName = String(body.beerName || '').trim();
      const beerStyle = String(body.beerStyle || '').trim();
      const beerAbv = Number(body.beerAbv);

      if (!brewerName || !beerName || !beerStyle || Number.isNaN(beerAbv) || beerAbv < 0 || beerAbv > 25) {
        json(res, 400, { error: 'Invalid registration data' });
        return;
      }

      const store = readStore();
      const record = { id: randomUUID(), brewerName, beerName, beerStyle, beerAbv, createdAt: Date.now() };
      store.registrations.push(record);
      writeStore(store);
      json(res, 201, record);
    } catch {
      json(res, 400, { error: 'Malformed JSON' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ratings') {
    json(res, 200, readStore().ratings);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ratings/batch') {
    try {
      const body = await readBody(req);
      const judgeName = String(body.judgeName || '').trim();
      const incoming = Array.isArray(body.ratings) ? body.ratings : [];

      const store = readStore();
      const nameSet = new Set(store.registrations.map((r) => r.brewerName.toLowerCase()));
      if (!judgeName || !nameSet.has(judgeName.toLowerCase())) {
        json(res, 400, { error: 'Unknown judge' });
        return;
      }

      if (incoming.length !== store.registrations.length || incoming.length === 0) {
        json(res, 400, { error: 'Must provide ratings for all registered beers' });
        return;
      }

      const registrationsById = new Map(store.registrations.map((r) => [r.id, r]));
      const uniqueBeerIds = new Set();
      const prepared = [];

      for (const entry of incoming) {
        const checked = validateRatingEntry(entry, registrationsById);
        if (!checked.ok) {
          json(res, 400, { error: 'Invalid rating data' });
          return;
        }
        if (uniqueBeerIds.has(checked.rating.beerId)) {
          json(res, 400, { error: 'Duplicate beer rating' });
          return;
        }
        uniqueBeerIds.add(checked.rating.beerId);

        prepared.push({
          id: randomUUID(),
          judgeName,
          ...checked.rating,
          createdAt: Date.now()
        });
      }

      if (uniqueBeerIds.size !== store.registrations.length) {
        json(res, 400, { error: 'Missing beer ratings' });
        return;
      }

      const judgeLower = judgeName.toLowerCase();
      store.ratings = store.ratings.filter((r) => String(r.judgeName || '').toLowerCase() !== judgeLower);
      store.ratings.push(...prepared);
      writeStore(store);
      json(res, 201, { inserted: prepared.length });
    } catch {
      json(res, 400, { error: 'Malformed JSON' });
    }
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/all') {
    writeStore({ registrations: [], ratings: [] });
    json(res, 200, { ok: true });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  ensureDataFile();
  console.log(`BeerMeets server running on http://0.0.0.0:${PORT}`);
});
