# 發票辨識結算帳冊 · 網路版（含密碼）

線上版：金鑰藏在伺服器、共用密碼保護，指定同事輸入密碼即可使用。
辨識引擎用 Gemini（你的免費金鑰）。

## 結構
```
ihg-invoice-ledger-web/
├── index.html                  前端（含密碼登入畫面）
├── functions/api/recognize.js  後端（Gemini + 密碼驗證）
├── wrangler.toml
└── .gitignore
```

## 兩個要設定的祕密（secret）
| 名稱 | 內容 |
|------|------|
| `GEMINI_API_KEY` | 你的 Google AI Studio 金鑰（AIza...） |
| `APP_PASSWORD`   | 你自訂的共用密碼，發給指定同事 |

---

## 不用終端機的部署（GitHub → Cloudflare Pages）

### 1. 放上 GitHub
1. github.com 登入 →右上「＋」→ New repository，命名 `ihg-invoice-ledger`，建立。
2. 進空 repo →「Add file → Upload files」，把本資料夾內容整個拖進去
   （會保留 `functions/api/recognize.js` 結構），下方 Commit changes。

### 2. 接上 Cloudflare
3. Cloudflare 後台 → Workers & Pages →「Create → Pages → Connect to Git」，選這個 repo。
4. 框架選 **None**、Build output 填 `/`，部署。

### 3. 設定兩個祕密
5. 進該專案 → Settings → Variables and Secrets，新增兩個 **Secret**：
   - `GEMINI_API_KEY` = 你的 Gemini 金鑰
   - `APP_PASSWORD` = 你要的密碼
6. 回 Deployments，對最新一筆按 **Retry deployment** 讓祕密生效。

### 4. 自訂網域
7. Settings → Custom domains 加上飯店子網域。

---

## 之後要改密碼
到 Settings → Variables and Secrets 改 `APP_PASSWORD` 的值，Retry deployment 即可。

## 換金鑰
同上，改 `GEMINI_API_KEY`。

## 想要更嚴格（依 Email 限定特定人）
可改用 Cloudflare Access（Zero Trust）把整個網站鎖住，只允許指定 Email 登入。
這比共用密碼更嚴謹，但每位同事需用 Email 收一次性驗證碼。需要的話再告訴我。
