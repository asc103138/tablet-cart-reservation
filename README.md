# 國小平板車預約與管理系統 (Tablet Cart Reservation System)

本專案是一套專為國小教學現場打造的**平板車與行動載具借用管理系統**。整合 **Google Apps Script 網頁前端**、**Google 試算表資料庫**、**Cloudflare Worker 轉發層** 與 **LINE 官方帳號 (LINE Bot)**，讓教師能以最直覺的方式預約與查詢平板車借用狀況。

---

## 🌟 核心特色

1. **雙軌預約模式**
   - **網頁端 (Web App)**：清晰的週課表網格，支援手機響應式排版、批次時段選擇、借用人與事由填寫。
   - **LINE Bot 極速預約**：支援自然語言輸入（如：「*明天第2節我要借401平板*」或「*下週三早修4年1班林老師借平板*」）。
2. **完整時段涵蓋**
   - 每日提供 **8 個借用時段**：`早修 (07:40~08:30)` 與 `第1節 ~ 第7節`。
3. **智慧記憶與低阻力互動**
   - **班級自動記憶**：首次設定後自動綁定老師班級，後續預約無須重複輸入。
   - **相對日期支援**：支援「今天」、「明天」、「下週X」、「這週X」，過期自動順延。
   - **即時空檔看板**：輸入「查今天」或「查明天」即刻顯示 🟢 可借 / 🔴 滿借 燈號看板。
   - **Quick Reply 導引**：回覆訊息自動帶入快速點選按鈕，免打字輕鬆操作。
4. **專屬 6 格高解析圖文選單**
   - 內建 2500x1686 像素 6 格圖文選單圖片，直覺點選「我要預約」、「查今天」、「查明天」、「我的預約」、「取消預約」、「使用說明」。

---

## 🛠️ 系統架構

```
+-------------------------------------------------------------+
|                      LINE 官方帳號 (教師端)                  |
|           [圖文選單 6 格] / [一鍵快捷文字] / [自然語言預約]  |
+-------------------------------------------------------------+
                               |
                               v (HTTPS POST)
+-------------------------------------------------------------+
|        Cloudflare Worker (Webhook 中繼轉發層)                |
|  - 驗證 x-line-signature (HMAC-SHA256)                      |
|  - 附帶 GAS_RELAY_SECRET 轉發至 Google Apps Script          |
+-------------------------------------------------------------+
                               |
                               v (HTTPS POST)
+-------------------------------------------------------------+
|        Google Apps Script 後端 (Code.gs)                    |
|  - doPost: 處理 LINE Webhook、自然語言解析、快取去重         |
|  - doGet: 提供 Web 預約系統 (index.html)                    |
|  - 整合 Google Gemini API (自然語言語意解析)                |
+-------------------------------------------------------------+
                               |
                               v (Apps Script API)
+-------------------------------------------------------------+
|          Google Sheets 資料庫 (預約表 / 車輛 / LINE狀態)    |
+-------------------------------------------------------------+
```

---

## 📁 專案檔案結構

```text
.
├── Code.gs                   # Google Apps Script 主要後端程式碼
├── index.html                # 上線版網頁預約系統前端介面
├── preview.html              # 本機離線預覽介面 (可用瀏覽器直接開啟)
├── cloudflare-worker.js      # Cloudflare Worker 中繼轉發腳本
├── rich_menu_2500x1686.png   # LINE 圖文選單圖片 (2500x1686 大版)
├── rich_menu_1200x810.png    # LINE 圖文選單圖片 (1200x810 小版)
├── rich_menu.html            # 圖文選單 HTML 原始檔 (可自由客製)
├── credentials.example.txt   # 環境變數與指令碼屬性設定範本
├── AGENTS.md                 # 專案開發規範與 AI 代理人指引
├── ANTIGRAVITY.md            # 專案入口指引
├── handoff.md                # 專案進度與交接日誌
└── .gitignore                # Git 忽略設定 (防範憑證外洩)
```

---

## 🚀 部署與設定指引

### 1. Google 試算表與 Apps Script
1. 建立一個 Google 試算表，內含三個工作表：
   - `預約清單`
   - `車輛清單`
   - `LINE狀態`
2. 開啟「擴充功能」->「Apps Script」，將本專案的 `Code.gs` 與 `index.html` 貼入。
3. 前往「專案設定」->「指令碼屬性」，依 [credentials.example.txt](file:///d:/opencode/平板車預約/credentials.example.txt) 新增下列屬性：
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_RELAY_SECRET`
   - `GEMINI_API_KEY`
   - `BOOKING_WEB_URL`
4. 點選「部署」->「新部署」，選擇「網頁應用程式」，將存取權限設為「所有人」。

### 2. Cloudflare Worker 中繼轉發
1. 建立 Cloudflare Worker，貼入 `cloudflare-worker.js`。
2. 在 Worker 設定中配置以下環境變數 (Secrets)：
   - `LINE_CHANNEL_SECRET`
   - `GAS_RELAY_SECRET`
   - `GAS_WEBHOOK_URL`
3. 部署 Worker，並將 Worker 網址填入 LINE Developers 的 Webhook URL。

### 3. LINE 官方帳號圖文選單設定
1. 進入 [LINE Official Account Manager](https://manager.line.biz/)。
2. 進入「圖文選單」->「建立圖文選單」。
3. 上傳 `rich_menu_2500x1686.png`。
4. 版型選擇「6 格」，依序設定動作：
   - **A (左上)**：動作「文字」-> `我要預約`
   - **B (中上)**：動作「文字」-> `查今天`
   - **C (右上)**：動作「文字」-> `查明天`
   - **D (左下)**：動作「文字」-> `我的預約`
   - **E (中下)**：動作「文字」-> `取消預約`
   - **F (右下)**：動作「文字」-> `說明`

---

## 🔒 資安守則
本專案為公開開源儲存庫，絕不將任何金鑰、Token、個資或憑證寫入程式碼或提交至 Git。所有設定一律使用環境變數與指令碼屬性進行隔離管理。
