// Cloudflare Pages Function — POST /api/recognize
// 後端呼叫 Gemini 視覺辨識；金鑰存 GEMINI_API_KEY secret，前端不接觸。
// 另以 APP_PASSWORD secret 做共用密碼，輸入正確才能使用。

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

const ALLOWED_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
const DEFAULT_MODEL = 'gemini-2.5-flash';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch (_) { return json({ error: '請求格式錯誤' }, 400); }

  // 共用密碼檢查
  if (env.APP_PASSWORD) {
    if (!body.password || body.password !== env.APP_PASSWORD) {
      return json({ error: '密碼錯誤' }, 401);
    }
  }
  // 登入畫面只是來驗證密碼
  if (body.ping) return json({ ok: true });

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: '伺服器尚未設定 GEMINI_API_KEY' }, 500);
  if (!body.image) return json({ error: '缺少影像資料' }, 400);

  const model = ALLOWED_MODELS.includes(body.model) ? body.model : DEFAULT_MODEL;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey);

  let r;
  try {
    r = await fetch(url, {
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
  } catch (err) {
    return json({ error: '無法連線辨識服務：' + (err.message || '') }, 502);
  }

  if (!r.ok) {
    let detail = '';
    try { const j = await r.json(); detail = j.error?.message || ''; } catch (_) {}
    return json({ error: '辨識服務回應 ' + r.status + (detail ? '：' + detail : '') }, 502);
  }

  const data = await r.json();
  const cand = (data.candidates || [])[0];
  if (!cand) {
    const reason = data.promptFeedback?.blockReason;
    return json({ error: '辨識無回應' + (reason ? '（' + reason + '）' : '') });
  }
  const text = (cand.content?.parts || []).map(p => p.text || '').join('\n');
  let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s < 0 || e < 0) return json({ error: '回傳格式無法解析', raw: text.slice(0, 500) });

  try {
    return json({ data: JSON.parse(clean.slice(s, e + 1)) });
  } catch (_) {
    return json({ error: 'JSON 解析失敗', raw: text.slice(0, 500) });
  }
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json({ error: '只接受 POST' }, 405);
}
