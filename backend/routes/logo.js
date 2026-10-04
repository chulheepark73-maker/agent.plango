const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const router = express.Router();

const CACHE_DIR = path.join(__dirname, '..', 'data', 'logos');
const MISS_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const inflight = new Map();

const KR_SOURCES = (code) => [
  `https://static.toss.im/png-icons/securities/icn-sec-fill-${code}.png`,
];
const US_SOURCES = (ticker) => [
  `https://financialmodelingprep.com/image-stock/${ticker}.png`,
  `https://assets.parqet.com/logos/symbol/${ticker}?format=png`,
];

const normalize = (market, code) => {
  const m = String(market || '').toLowerCase();
  const c = String(code || '').trim();
  if (m === 'kr' && /^[0-9A-Z]{6}$/i.test(c.slice(0, 6))) {
    return { market: 'kr', code: c.slice(0, 6).toUpperCase() };
  }
  if (m === 'us' && /^[A-Z0-9.\-]{1,12}$/i.test(c)) {
    return { market: 'us', code: c.toUpperCase().replace(/\./g, '-') };
  }
  return null;
};

const fetchFirstImage = async (urls) => {
  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 5000,
        validateStatus: (s) => s === 200,
      });
      const type = String(res.headers['content-type'] || '');
      const buf = Buffer.from(res.data);
      if (type.startsWith('image/') && buf.length > 200) return { buf, type };
    } catch {
      /* 다음 출처 시도 */
    }
  }
  return null;
};

const resolveLogo = async (market, code) => {
  const base = path.join(CACHE_DIR, `${market}_${code}`);
  const imgPath = `${base}.img`;
  const typePath = `${base}.type`;
  const missPath = `${base}.miss`;

  if (fs.existsSync(imgPath)) {
    const type = fs.existsSync(typePath) ? fs.readFileSync(typePath, 'utf8') : 'image/png';
    return { buf: fs.readFileSync(imgPath), type };
  }
  if (fs.existsSync(missPath) && Date.now() - fs.statSync(missPath).mtimeMs < MISS_RETRY_MS) {
    return null;
  }

  const found = await fetchFirstImage(market === 'kr' ? KR_SOURCES(code) : US_SOURCES(code));
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (found) {
    fs.writeFileSync(imgPath, found.buf);
    fs.writeFileSync(typePath, found.type);
    if (fs.existsSync(missPath)) fs.unlinkSync(missPath);
  } else {
    fs.writeFileSync(missPath, '');
  }
  return found;
};

// <img src>에서 직접 호출하므로 인증 없이 공개 로고만 프록시
router.get('/:market/:code', async (req, res) => {
  const key = normalize(req.params.market, req.params.code);
  if (!key) return res.status(400).end();
  const cacheKey = `${key.market}_${key.code}`;
  try {
    if (!inflight.has(cacheKey)) {
      inflight.set(
        cacheKey,
        resolveLogo(key.market, key.code).finally(() => inflight.delete(cacheKey))
      );
    }
    const logo = await inflight.get(cacheKey);
    if (!logo) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.status(404).end();
    }
    res.set('Content-Type', logo.type);
    res.set('Cache-Control', 'public, max-age=604800');
    return res.send(logo.buf);
  } catch (err) {
    console.warn('[logo] 조회 실패:', cacheKey, err.message || err);
    return res.status(500).end();
  }
});

module.exports = router;
