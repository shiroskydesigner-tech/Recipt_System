// Cloudflare Pages Function — /api/units
// 以 Cloudflare KV 儲存多份共用清單；沿用 APP_PASSWORD 保護。
// 清單種類（kind）：units（使用單位）、summaries（摘要）、docTypes（票據類型，含代號 code）
// GET  /api/units?kind=units      → 讀清單（x-app-password header 驗證），回 { items }
// POST /api/units  body:{password, kind, items} → 存清單
// 需在 Pages 後台綁定 KV namespace，變數名 UNITS_KV。未綁定時讀取回空清單、儲存提示未綁定。

const KINDS = ['units', 'summaries', 'docTypes'];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
function pickKind(k) { return KINDS.includes(k) ? k : 'units'; }

function cleanItems(kind, arr) {
  const list = Array.isArray(arr) ? arr : [];
  return list.slice(0, 50).map(u => {
    const base = {
      id: String(u.id || ('x' + Math.random().toString(36).slice(2, 8))),
      name: String(u.name || '').trim().slice(0, 40),
      enabled: !!u.enabled
    };
    if (kind === 'docTypes') base.code = String(u.code || '').trim().slice(0, 20);
    return base;
  }).filter(u => u.name);
}

export async function onRequestGet({ request, env }) {
  if (!env.APP_PASSWORD) return json({ error: '伺服器尚未設定 APP_PASSWORD' }, 500);
  if (request.headers.get('x-app-password') !== env.APP_PASSWORD) return json({ error: '密碼錯誤' }, 401);
  const kind = pickKind(new URL(request.url).searchParams.get('kind'));
  if (!env.UNITS_KV) return json({ items: [], kind }); // 未綁定 KV → 空清單，不報錯
  let items = [];
  try { const raw = await env.UNITS_KV.get(kind); items = raw ? JSON.parse(raw) : []; } catch (_) {}
  return json({ items: Array.isArray(items) ? items : [], kind });
}

export async function onRequestPost({ request, env }) {
  if (!env.APP_PASSWORD) return json({ error: '伺服器尚未設定 APP_PASSWORD' }, 500);
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: '請求格式錯誤' }, 400); }
  if (body.password !== env.APP_PASSWORD) return json({ error: '密碼錯誤' }, 401);
  if (!env.UNITS_KV) return json({ error: '伺服器尚未綁定 UNITS_KV，無法儲存' }, 500);
  const kind = pickKind(body.kind);
  await env.UNITS_KV.put(kind, JSON.stringify(cleanItems(kind, body.items)));
  return json({ ok: true, kind });
}

export async function onRequest(context) {
  const m = context.request.method;
  if (m === 'GET') return onRequestGet(context);
  if (m === 'POST') return onRequestPost(context);
  return json({ error: '只接受 GET/POST' }, 405);
}
