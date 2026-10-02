# 專案交接筆記 (handoff.md)

## 📌 專案當前狀態 (Current Status)
* **專案名稱**：國小平板車預約與管理系統
* **後端環境**：Google Apps Script (GAS) Web App + Google Sheets 資料庫
* **轉發代理**：Cloudflare Worker (Webhook Relay + HMAC-SHA256 簽章驗證)
* **使用者端**：LINE 官方帳號 Messaging API + 響應式 Web 預約網頁

---

## 🚀 已完成里程碑 (Completed Milestones)

### 1. 時段全面擴充
- [x] 新增每日 **「早修 (07:40 ~ 08:30)」** 借用時段。
- [x] 同步更新 `Code.gs` 後端排程判斷、衝突檢查與預約寫入。
- [x] 同步更新 `index.html` 與本機 `preview.html` 網頁前端選取按鈕與課表網格。

### 2. LINE Bot 使用者體驗與動機大幅提升
- [x] **一句話自然語言極速預約**：
  - 支援「明天第2節我要借4年1班平板」、「下週三早修401林老師借平板」等語意輸入。
  - 支援相對日期解析（「今天」、「明天」、「這週X」、「下週X」），星期已過自動順延到下一週。
- [x] **班級記憶機制**：
  - 老師只要設定或輸入過一次班級（例如「我是4年1班林老師」），系統自動記錄至 `LINE狀態` 工作表第 4 欄。
  - 後續預約直接省略班級輸入，自動帶入預設班級。
- [x] **即時空檔看板**：
  - 支援「查今天」、「查明天」，回傳帶有時段時間與狀態燈號（🟢 可借 / 🔴 滿借 / ⛔ 不開放）的視覺化課表。
- [x] **Quick Reply 快速動作按鈕**：
  - 所有 LINE 機器人回覆訊息均附帶下方快捷滑動按鈕（查今天、查明天、我的預約、取消預約、開啟預約網頁），無須手動打字。
- [x] **網頁端促銷卡片**：
  - 在 `index.html` 預約成功頁面與頂部增加 LINE Bot 加入好友與預約秘笈教學。

### 3. 圖文選單 (Rich Menu) 開發與產出
- [x] 設計並生成 6 格專業教學風格圖文選單圖片：
  - `rich_menu_2500x1686.png`（大版，標準解析度）
  - `rich_menu_1200x810.png`（小版）
  - `rich_menu_2500x1686.jpg`（壓縮版）
- [x] 提供完整的 LINE Official Account Manager 圖文選單 6 區塊動作設定對照表。

### 4. 前端動態與動效極致優化 (Emil Kowalski Design Engineering & Mobile Native)
- [x] **自訂貝茲曲線 (Custom Cubic-Bezier Easing)**：全站引入 `--ease-out`、`--ease-in-out`、`--ease-spring`，移除原生效能較差的慢速 ease。
- [x] **按鈕與晶片按壓回饋 (`:active`)**：為所有 `button`、`button.ghost`、`.chips button` 加入 `transform: scale(0.97)` 即時按壓物理觸感。
- [x] **日曆節次格子點擊動效**：`td.cell` 增加 `transform: scale(0.96)` 微互動與柔和外框，加強選取時的回饋感。
- [x] **防止觸控黏著 (`@media (hover: hover) and (pointer: fine)`)**：解決手機/平板瀏覽器點擊後 `:hover` 樣式卡住未清除的問題。
- [x] **消除行動裝置點擊灰斑**：全站配置 `-webkit-tap-highlight-color: transparent` 與 `touch-action: manipulation`，消除 300ms 延遲與閃爍。
- [x] **狀態訊息平滑淡入滑動**：預約提示文字從生硬抽換改為 70ms translateY 與 opacity 平滑過渡。
- [x] **卡片微差入場動效 (Stagger Entry)**：頂部宣傳橫幅與卡片採 40~150ms 階梯式滑入，畫面更生動精緻。
- [x] **無障礙支援 (`prefers-reduced-motion`)**：偵測使用者系統動態偏好，必要時自動關閉所有位移動畫。

### 5. 專案工程化與標準化
- [x] 建立 `.gitignore` 排除所有敏感金鑰憑證（如 `憑證 (2).txt`）。
- [x] 建立 `credentials.example.txt` 設定範本。
- [x] 建立 `AGENTS.md`、`ANTIGRAVITY.md`、`README.md`。
- [x] 初始化本機 Git 儲存庫並同步至 GitHub。

---

## 🔮 後續建議與待辦事項 (Roadmap & Next Steps)
1. **正式上線推廣**：
   - 於學校教職員研習或 LINE 群組發布圖文選單與官方帳號 QR Code。
2. **使用數據觀察**：
   - 觀察老師透過 LINE Bot 預約的使用率與常見語意提問，持續微調自然語言解析或提示詞。
3. **擴充功能評估**：
   - 評估是否加入「借用前 10 分鐘 LINE 自動提醒」推播通知功能。
   - 評估是否加入「期末平板車使用統計表自動匯出」功能。
