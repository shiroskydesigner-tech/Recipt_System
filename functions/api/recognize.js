// Cloudflare Pages Function — POST /api/recognize
// 雙引擎：預設 Gemini；若設定 AI_BASE_URL + AI_API_KEY 則改走 OpenAI 相容端點
// （可接 Qwen-VL：OpenRouter / DashScope / 自架 vLLM·Ollama 經 Cloudflare Tunnel）。
// 密碼以 APP_PASSWORD 保護；所有金鑰只在伺服器端。

const SYS = '你是專業的發票與出貨明細資料擷取助手。你只會輸出一個合法的 JSON 物件，不含任何說明文字、前言或 markdown 標記。';

const PROMPT = [
  '請辨識這張發票或出貨明細照片，擷取資料並以 JSON 物件回傳，欄位如下：',
  '{"vendor":廠商或店家名稱字串,"date":日期YYYY-MM-DD字串,"invoiceNo":發票號碼或單號字串,"items":[{"name":品名,"qty":數量數字,"unitPrice":單價數字,"subtotal":小計數字}],"total":總金額數字}',
  '規則：',
  '1. 只擷取商品明細列，忽略地址、電話、統一編號、備註、印章、廣告等無關資訊。',
  '2. 數字不要含貨幣符號或千分位逗號。',
  '3. 完全看不清楚的數字填 null，不要亂猜。',
  '4. 所有文字使用繁體中文。',
  '5. 只回傳 JSON 物件本身。'
].join('\n');

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
const DEFAULT_GEMINI = 'gemini-2.5-flash';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
function parseRetry(detail) {
  const m = detail && String(detail).match(/retry in ([\d.]+)/i);
  return m ? Math.ceil(parseFloat(m[1])) : 0;
}

// ---- 引擎一：OpenAI 相容（Qwen-VL 等）----
async function callOpenAICompat(env, body) {
  const base = String(env.AI_BASE_URL).replace(/\/+$/, '');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + env.AI_API_KEY },
    body: JSON.stringify({
      model: env.AI_MODEL || 'qwen-vl-plus',
      temperature: 0,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: 'data:' + (body.mediaType || 'image/jpeg') + ';base64,' + body.image } }
        ] }
      ]
    })
  });
  if (!r.ok) {
    let detail = '';
    try { const j = await r.json(); detail = j.error?.message || j.message || ''; }
    catch (_) { try { detail = await r.text(); } catch (__) {} }
    const e = new Error(detail || ('HTTP ' + r.status)); e.status = r.status;
    if (r.status === 429) e.retryAfter = parseInt(r.headers.get('retry-after') || '0', 10) || parseRetry(detail) || 30;
    throw e;
  }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
}

// ---- 引擎二：Gemini ----
async function callGemini(env, body) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) { const e = new Error('伺服器尚未設定 GEMINI_API_KEY（請檢查 Secret 名稱是否正確、無多餘符號）'); e.status = 500; throw e; }
  const model = GEMINI_MODELS.includes(body.model) ? body.model : DEFAULT_GEMINI;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYS }] },
      contents: [{ parts: [
        { inline_data: { mime_type: body.mediaType || 'image/jpeg', data: body.image } },
        { text: PROMPT }
      ] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 4096 }
    })
  });
  if (!r.ok) {
    let detail = ''; let payload = null;
    try { payload = await r.json(); detail = payload.error?.message || ''; } catch (_) {}
    const e = new Error(detail || ('HTTP ' + r.status)); e.status = r.status;
    if (r.status === 429) {
      let ra = 0;
      try { const ri = (payload?.error?.details || []).find(d => String(d['@type'] || '').includes('RetryInfo')); const m = ri?.retryDelay && String(ri.retryDelay).match(/([\d.]+)/); if (m) ra = Math.ceil(parseFloat(m[1])); } catch (_) {}
      e.retryAfter = ra || parseRetry(detail) || 30;
    }
    throw e;
  }
  const data = await r.json();
  const cand = (data.candidates || [])[0];
  if (!cand) { const reason = data.promptFeedback?.blockReason; const e = new Error('辨識無回應' + (reason ? '（' + reason + '）' : '')); e.status = 502; throw e; }
  return (cand.content?.parts || []).map(p => p.text || '').join('\n');
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: '請求格式錯誤' }, 400); }

  if (!env.APP_PASSWORD) return json({ error: '伺服器尚未設定 APP_PASSWORD（請檢查 Secret 名稱是否正確、無多餘符號）' }, 500);
  if (!body.password || body.password !== env.APP_PASSWORD) return json({ error: '密碼錯誤' }, 401);
  if (body.ping) return json({ ok: true });
  if (!body.image) return json({ error: '缺少影像資料' }, 400);

  const useQwen = env.AI_BASE_URL && env.AI_API_KEY;
  let text;
  try {
    text = useQwen ? await callOpenAICompat(env, body) : await callGemini(env, body);
  } catch (err) {
    if (err.status === 429) return json({ error: '已達額度上限', rateLimited: true, retryAfter: err.retryAfter || 30 }, 429);
    return json({ error: '辨識服務回應 ' + (err.status || '') + '：' + (err.message || '') }, err.status === 500 ? 500 : 502);
  }

  let clean = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s < 0 || e < 0) return json({ error: '回傳格式無法解析', raw: String(text).slice(0, 500) });
  try { return json({ data: JSON.parse(clean.slice(s, e + 1)) }); }
  catch (_) { return json({ error: 'JSON 解析失敗', raw: String(text).slice(0, 500) }); }
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json({ error: '只接受 POST' }, 405);
}
