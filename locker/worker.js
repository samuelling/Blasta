// Blasta Bank Locker — a password-protected store for your own SoundFont / OP2 banks.
// Cloudflare Worker + private R2 bucket. Every request must carry the locker password
// (Authorization: Bearer …), which lives only as the LOCKER_PASSWORD secret.
//
//   GET    /banks            list banks
//   PUT    /banks/:name      upload (raw body)
//   GET    /banks/:name      download
//   DELETE /banks/:name      delete
//   GET    /config           which bank is in which Blasta slot
//   PUT    /config           save slot assignments (JSON)

const CONFIG_KEY = '_config.json';
const MAX_NAME = 120;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || ''),
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Expose-Headers': 'ETag',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const reply = (body, status = 200, extra = {}) => new Response(body, { status, headers: { ...cors, ...extra } });
    const json = (obj, status = 200) => reply(JSON.stringify(obj), status, { 'Content-Type': 'application/json' });

    if (req.method === 'OPTIONS') return reply(null, 204);
    if (origin && !allowed.includes(origin)) return json({ error: 'origin not allowed' }, 403);
    if (!env.LOCKER_PASSWORD) return json({ error: 'locker password not configured' }, 500);
    if (!(await authorized(req, env.LOCKER_PASSWORD))) {
      await new Promise(r => setTimeout(r, 400));          // slow down guessing
      return json({ error: 'wrong password' }, 401);
    }

    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    if (path === '/banks' && req.method === 'GET') {
      const out = [];
      let cursor;
      do {
        const page = await env.BANKS.list({ cursor, include: ['customMetadata'] });
        for (const o of page.objects) if (o.key !== CONFIG_KEY) out.push({ name: o.key, size: o.size, etag: o.httpEtag, uploaded: o.uploaded, kind: kindOf(o.key) });
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      out.sort((a, b) => a.name.localeCompare(b.name));
      return json(out);
    }

    if (path === '/config') {
      if (req.method === 'GET') {
        const o = await env.BANKS.get(CONFIG_KEY);
        return json(o ? await o.json() : {});
      }
      if (req.method === 'PUT') {
        const text = await req.text();
        if (text.length > 10000) return json({ error: 'config too large' }, 413);
        try { JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }
        await env.BANKS.put(CONFIG_KEY, text, { httpMetadata: { contentType: 'application/json' } });
        return json({ ok: true });
      }
    }

    const m = path.match(/^\/banks\/(.+)$/);
    if (m) {
      const name = m[1];
      if (!validName(name)) return json({ error: 'bad name (use .sf2 or .op2, no slashes)' }, 400);
      if (req.method === 'GET') {
        const o = await env.BANKS.get(name);
        if (!o) return json({ error: 'not found' }, 404);
        return reply(o.body, 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(o.size), ETag: o.httpEtag, 'Cache-Control': 'private, no-store' });
      }
      if (req.method === 'PUT') {
        if (!req.body) return json({ error: 'empty upload' }, 400);
        const o = await env.BANKS.put(name, req.body, { httpMetadata: { contentType: 'application/octet-stream' } });
        return json({ ok: true, name, size: o.size, etag: o.httpEtag });
      }
      if (req.method === 'DELETE') {
        await env.BANKS.delete(name);
        return json({ ok: true });
      }
    }
    return json({ error: 'not found' }, 404);
  },
};

async function authorized(req, secret) {
  const h = req.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return false;
  const enc = new TextEncoder();
  // hash both sides so the comparison is constant-time and length-independent
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(h.slice(7))), crypto.subtle.digest('SHA-256', enc.encode(secret))]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
function validName(n) {
  return n.length <= MAX_NAME && n !== CONFIG_KEY && !/[\/\\\x00-\x1f]/.test(n) && !n.startsWith('.') && /\.(sf2|op2)$/i.test(n);
}
function kindOf(n) { return /\.op2$/i.test(n) ? 'op2' : 'sf2'; }
