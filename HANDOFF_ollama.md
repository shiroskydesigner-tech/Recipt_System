# 交接文件：發票辨識結算帳冊 — 加入 Ollama（本機 Qwen-VL）支援

## 給接手的 AI 助理
這份文件說明要做的修改。**請先檢視使用者本地現有檔案，採「增量修改」，不要盲目整檔覆蓋使用者自己的 UI 調整。** 真正為了 Ollama 必須改的只有「後端一個檔案」，前端多半只需確認一處。

---

## 1. 專案概觀（架構）

這是一個部署在 **Cloudflare Pages** 的單頁工具，結構：

```
專案根目錄/
├── index.html                  前端（跑在使用者瀏覽器）
└── functions/api/recognize.js  後端 Pages Function（跑在 Cloudflare 邊緣）
```

資料流：
1. 前端壓縮發票照片成 base64，連同密碼 POST 給後端 `/api/recognize`。
2. 後端持有所有金鑰，選擇辨識引擎、呼叫模型、把回傳整理成結構化 JSON 回給前端。
3. **前端永遠不接觸任何金鑰或模型端點**——這是安全設計的核心。

金鑰與設定都放在 Cloudflare 後台的 **Secret**，由執行階段注入後端的 `env` 物件，不寫進程式碼、不出現在前端。

---

## 2. 本次目標

讓後端**多支援一種「OpenAI 相容」辨識引擎**，用來接使用者本機（RTX 4090）以 **Ollama** 跑的 **Qwen2.5-VL**，經 Cloudflare Tunnel 對外。要求：

- 預設仍走 **Gemini**（維持現狀，不破壞）。
- 只要 Cloudflare 設了 `AI_BASE_URL` + `AI_API_KEY` 兩個 Secret，後端就**自動切換**到 OpenAI 相容引擎，呼叫 Ollama。
- 不破壞既有的密碼保護、429 自動重試等行為。
- 切回 Gemini：把那幾個 Secret 刪掉即可，**不需改任何程式碼**。

---

## 3. 主要修改：後端 `functions/api/recognize.js`

**這是唯一為了 Ollama 必須改的檔案。** 請以下面這份為準（authoritative）。若使用者本地對後端另有自訂邏輯，請合併保留；核心一定要有的是：`callOpenAICompat()`、`useQwen` 分流、以及錯誤/429 處理。

```js
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
```

**設計重點（請理解後再改，不要只貼）：**
- `useQwen = env.AI_BASE_URL && env.AI_API_KEY`：兩個 Secret 都有值 → 走 `callOpenAICompat`（Ollama/Qwen）；否則走 `callGemini`。
- `callOpenAICompat` 用標準 OpenAI `/chat/completions`，影像以 `image_url` 的 base64 data URL 帶入。此格式同時適用 Ollama、OpenRouter、DashScope、vLLM。
- 兩個引擎都只回「純文字」，最後統一用「擷取第一個 `{` 到最後一個 `}`」來容錯解析 JSON。
- 429 會回 `{ rateLimited:true, retryAfter }`，搭配前端自動重試。

---

## 4. 前端需確認的點：`index.html`

這部分與 Ollama 無直接關係，但要確保前端是「呼叫自家後端」而非「瀏覽器直接呼叫 AI 服務」。

**(a) `callVision` 必須打 `/api/recognize`。** 若目前版本是瀏覽器直接呼叫 Gemini 或 Anthropic（網址含 `googleapis.com` 或 `anthropic.com`、或前端帶 `x-api-key`／API 金鑰），請改成下面這版（金鑰絕不可留在前端）：

```js
/* 視覺辨識：呼叫後端 /api/recognize，帶密碼 */
async function callVision(base64, mediaType){
  const res = await fetch('/api/recognize',{
    method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({ password:state.password, model:state.model, image:base64, mediaType })
  });
  let payload;
  try{ payload = await res.json(); }
  catch(_){ throw new Error('伺服器回應異常 '+res.status); }
  if(res.status===401){ GATE.show(); const e=new Error('密碼錯誤或已失效，請重新輸入'); throw e; }
  if(res.status===429 || payload.rateLimited){ const e=new Error(payload.error||'已達額度上限'); e.rateLimited=true; e.retryAfter=payload.retryAfter||30; throw e; }
  if(payload.error){ const e=new Error(payload.error); e.raw=payload.raw; throw e; }
  if(!payload.data){ const e=new Error('辨識無資料'); e.raw=payload.raw; throw e; }
  return payload.data;
}
```

**(b) 建議具備 429 自動重試**（非必要，但批次上傳體驗好很多）。上傳迴圈中對 `callVision` 包一層重試，並提供 `waitWithCountdown` / `sleep`：

```js
// handleFiles 內，逐張處理時：
const pend = addPending(f.name);
try{
  const {dataUrl, base64, mediaType} = await compressImage(f);
  if(dataUrl) pend.querySelector('img')?.setAttribute('src', dataUrl);
  let data=null, attempt=0;
  while(true){
    try{ data = await callVision(base64, mediaType); break; }
    catch(err){
      if(err.rateLimited && attempt<6){ attempt++; await waitWithCountdown(pend, Math.min(err.retryAfter||30,60)); continue; }
      throw err;
    }
  }
  const inv = makeInvoice(data, dataUrl);
  state.invoices.push(inv); pend.remove(); render();
  await sleep(700); // 緩衝，降低連續請求觸頂機率
}catch(err){ showPendingError(pend, f.name, err); }

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function waitWithCountdown(pend, secs){
  const sub = pend.querySelector('.p-sub');
  for(let s=secs; s>0; s--){ if(sub) sub.textContent=`已達免費額度上限，${s} 秒後自動重試…`; await sleep(1000); }
  if(sub) sub.textContent='重試中…';
}
// 註：addPending 產生的卡片需有 class="p-sub" 的子元素供倒數文字更新。
```

**(c) 重要觀念：** 前端**不需要也不應該**知道 `AI_BASE_URL` / `AI_MODEL`，那些只存在後端。前端 body 帶的 `model` 只對 Gemini 分支有意義；走 OpenAI 相容（Ollama）分支時後端會忽略它、改用後端的 `AI_MODEL`。

---

## 5. Cloudflare Secret（在後台設定，不寫進程式碼）

| 名稱 | 必要性 | 值範例 | 用途 |
|------|--------|--------|------|
| `APP_PASSWORD` | 必填 | 自訂密碼 | 登入密碼，後端比對 |
| `GEMINI_API_KEY` | 走 Gemini 時必填 | `AIza...` | Gemini 金鑰 |
| `AI_BASE_URL` | 走 Ollama/Qwen 時必填 | `https://<tunnel>.trycloudflare.com/v1` | OpenAI 相容端點（**結尾要 `/v1`**） |
| `AI_API_KEY` | 走 Ollama/Qwen 時必填 | `ollama` | Ollama 不驗證，隨意填 |
| `AI_MODEL` | 走 Ollama/Qwen 時 | `qwen2.5vl:7b` | 模型名稱 |

- 設了 `AI_BASE_URL` + `AI_API_KEY` → 自動走 Ollama/Qwen；刪掉 → 自動回 Gemini。
- **名稱務必純文字，前後不要有反引號、引號或空白**（曾因複製 markdown 反引號導致讀不到）。

---

## 6. 部署注意事項（很重要）

- 必須以 Cloudflare **Pages** 部署（Connect to Git → Pages 分頁），**不是 Workers**。走 Workers 會用 `wrangler deploy` 而失敗。
- repo 內**不要放 `wrangler.toml`**，否則 Cloudflare 會誤判為 Workers 專案。
- Build 設定：Framework preset = None、Build command 留空、Build output directory = `/`。
- 改完 Secret 後要到 Deployments → **Retry deployment** 才會生效。

---

## 7. 驗證步驟

1. 不設 `AI_*` Secret → 上傳發票應走 Gemini，照舊能辨識。
2. 設 `AI_BASE_URL`(tunnel `/v1`) + `AI_API_KEY`(`ollama`) + `AI_MODEL`(`qwen2.5vl:7b`) → 上傳發票應走本機 Qwen。
3. 本機前置條件：`http://localhost:11434` 顯示「Ollama is running」；tunnel 必須以
   `cloudflared tunnel --url http://localhost:11434 --http-host-header localhost:11434` 啟動（少了 `--http-host-header` 會被 Ollama 回 **403**）。

---

## 8. 已知後續優化（非本次必要，供參考）

- **Ollama context 長度**：手寫長明細 token 較多，預設 `num_ctx` 可能不足造成截斷／JSON 不完整。可設環境變數 `OLLAMA_CONTEXT_LENGTH=8192`，或在請求 body 帶 `num_ctx`（Ollama 接受）。
- **固定網址**：quick tunnel 每次重開網址會變；正式上線應改 named tunnel（固定子網域）+ 開機自啟（Windows 服務）。
- **模型常駐**：設 `OLLAMA_KEEP_ALIVE=-1` 讓模型不被卸載，避免冷啟動延遲。
