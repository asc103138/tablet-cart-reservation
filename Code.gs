/**
 * 平板車預約 —— 後端
 * 資料欄位（分頁：預約）：
 *   A 提交時間 | B 週次 | C 星期 | D 節次 | E 班級 | F 用途 | G 借用類型 | H 平板台數 | I 來源
 */

const SHEET_NAME = '預約';
const LINE_STATE_SHEET_NAME = 'LINE狀態';
const BORROW_TYPES = ['整台車', '平板'];
const MAX_TABLET_COUNT = 10;
const LINE_STATE_TTL_MINUTES = 30;
// Gemini 2.5 已不再開放新使用者；舊版 Script Property 也會在下方自動改用此模型。
const GEMINI_MODEL_DEFAULT = 'gemini-3.6-flash';
const BOOKING_HEADERS = ['提交時間', '週次', '星期', '節次', '班級', '用途', '借用類型', '平板台數', '來源'];

// Script Properties：LINE_CHANNEL_ACCESS_TOKEN、LINE_RELAY_SECRET、GEMINI_API_KEY、BOOKING_WEB_URL。

// ⚙️ 8 個班級代號
const CLASSES = ['四年甲班', '四年乙班', '四年丙班', '四年丁班', '四年戊班', '四年己班', '四年庚班', '四年辛班'];

// 節次（可自行增減）
const PERIODS = ['早修', '第1節', '第2節', '第3節', '第4節', '第5節', '第6節', '第7節'];
const BLOCKED_PERIODS = ['第5節', '第6節', '第7節'];
const SCHOOL_WEEK_START_ = Date.UTC(2026, 7, 30);
const SCHOOL_WEEK_COUNT_ = 21;

/** 有人打開網址 → 回傳網頁 */
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('平板車預約')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Cloudflare Worker 驗證 LINE 簽章後，將事件轉送到這裡。 */
function doPost(e) {
  const body = e && e.postData && e.postData.contents;
  if (!body) return textResponse_('OK');

  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch (err) {
    return textResponse_('invalid json');
  }

  const expectedSecret = PropertiesService.getScriptProperties().getProperty('LINE_RELAY_SECRET');
  if (!expectedSecret || envelope.relaySecret !== expectedSecret) {
    return textResponse_('forbidden');
  }

  const payload = envelope.payload || {};
  const events = Array.isArray(payload.events) ? payload.events : [];
  events.forEach(handleLineEvent_);
  return textResponse_('OK');
}

/** 回傳班級與節次，供前端使用 */
function getConfig() {
  return {
    classes: CLASSES,
    periods: PERIODS,
    borrowTypes: BORROW_TYPES,
    maxTabletCount: MAX_TABLET_COUNT
  };
}

/** 星期一、星期三下午第 5～7 節無法預約 */
function isBlockedSlot_(weekday, period) {
  return (weekday === '星期一' || weekday === '星期三') &&
    BLOCKED_PERIODS.indexOf(period) !== -1;
}

function weekNumber_(week) {
  const match = /^第(\d+)週$/.exec(String(week));
  return match ? Number(match[1]) : 0;
}

function todayInTaipei_() {
  const dateText = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd').split('-').map(Number);
  return new Date(Date.UTC(dateText[0], dateText[1] - 1, dateText[2]));
}

function schoolWeekNumberToday_() {
  const today = todayInTaipei_().getTime();
  return Math.floor((today - SCHOOL_WEEK_START_) / (7 * 86400000)) + 1;
}

function isPastWeek_(week) {
  const number = weekNumber_(week);
  return number > 0 && number < schoolWeekNumberToday_();
}

/** 前端呼叫：一次寫入同一天的多個節次 */
function submitBookings(data) {
  return submitBooking_(data, '網頁');
}

/** 網頁與 LINE 共用的預約驗證與寫入流程。 */
function submitBooking_(data, source) {
  source = source || '網頁';
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (err) {
    return { ok: false, error: '現在送出的人太多，請過幾秒再試' };
  }
  try {
    const week = String(data.week || '').trim();
    const weekday = String(data.weekday || '').trim();
    const inputPeriods = Array.isArray(data.periods) ? data.periods : [];
    const periods = inputPeriods.map(function (period) { return String(period).trim(); })
      .filter(function (period, index, list) { return period && list.indexOf(period) === index; });
    const className = String(data.className || '').trim();
    const purpose = String(data.purpose || '').trim().slice(0, 100);
    const borrowType = String(data.borrowType || '').trim();
    const tabletCount = Number(data.tabletCount);

    if (!week || !weekday || !periods.length || !className || !borrowType || !purpose) {
      return { ok: false, error: '週次、星期、節次、班級、借用方式、用途都要填' };
    }
    if (BORROW_TYPES.indexOf(borrowType) === -1) {
      return { ok: false, error: '借用方式無效' };
    }
    if (borrowType === '平板' &&
        (!isFinite(tabletCount) || tabletCount < 1 || tabletCount > MAX_TABLET_COUNT || tabletCount !== Math.floor(tabletCount))) {
      return { ok: false, error: '平板台數必須是 1～' + MAX_TABLET_COUNT + ' 台的整數' };
    }
    if (periods.some(function (period) { return PERIODS.indexOf(period) === -1; })) {
      return { ok: false, error: '節次資料無效' };
    }
    if (weekNumber_(week) < 1 || weekNumber_(week) > SCHOOL_WEEK_COUNT_) {
      return { ok: false, error: '週次無效' };
    }
    if (isPastWeek_(week)) {
      return { ok: false, error: '已過去的週次不能預約' };
    }
    if (periods.some(function (period) { return isBlockedSlot_(weekday, period); })) {
      return { ok: false, error: '選取的節次中包含無法預約的時段' };
    }
    const sheet = getSheet_();
    // 先完整檢查，任何一節衝突就整批拒絕，避免只寫入部分節次。
    const rows = sheet.getDataRange().getValues();
    for (let p = 0; p < periods.length; p++) {
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][1]) === week &&
            String(rows[i][2]) === weekday &&
            String(rows[i][3]) === periods[p]) {
          return { ok: false, error: periods[p] + '已被別的班級預約了，整批未送出' };
        }
      }
    }
    const timestamp = new Date();
    const storedTabletCount = borrowType === '平板' ? tabletCount : '';
    const values = periods.map(function (period) {
      return [timestamp, week, weekday, period, className, purpose, borrowType, storedTabletCount, source];
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, 9).setValues(values);
    return { ok: true, count: periods.length, borrowType: borrowType, tabletCount: storedTabletCount };
  } finally {
    lock.releaseLock();
  }
}

/** 前端呼叫：查詢某週的已預約清單 */
function getBookings(week) {
  const sheet = getSheet_();
  const rows = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (week && String(rows[i][1]) !== week) continue;
    const booking = bookingInfo_(rows[i][6], rows[i][7]);
    out.push({
      week: String(rows[i][1]),
      weekday: String(rows[i][2]),
      period: String(rows[i][3]),
      className: String(rows[i][4]),
      purpose: String(rows[i][5]),
      borrowType: booking.borrowType,
      tabletCount: booking.tabletCount
    });
  }
  // 依節次排序
  out.sort(function (a, b) {
    return (PERIODS.indexOf(a.period) - PERIODS.indexOf(b.period));
  });
  return out;
}

/** 前端呼叫：依班級列出我的預約 */
function myBookings(className) {
  const sheet = getSheet_();
  const rows = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][4]) === String(className)) {
      const booking = bookingInfo_(rows[i][6], rows[i][7]);
      out.push({
        week: String(rows[i][1]),
        weekday: String(rows[i][2]),
        period: String(rows[i][3]),
        className: String(rows[i][4]),
        purpose: String(rows[i][5]),
        borrowType: booking.borrowType,
        tabletCount: booking.tabletCount
      });
    }
  }
  out.sort(function (a, b) {
    if (a.week !== b.week) return a.week < b.week ? -1 : 1;
    const weekdays = ['星期一', '星期二', '星期三', '星期四', '星期五'];
    return weekdays.indexOf(a.weekday) - weekdays.indexOf(b.weekday);
  });
  return out;
}

/** 取消功能已關閉，保留函式以拒絕舊版前端或外部請求 */
function cancelBooking(className, week, weekday, period) {
  return { ok: false, error: '目前不開放取消預約，請聯絡管理者' };
}

/** 前端呼叫：各班預約節次統計（給長條圖用） */
function getUsageStats() {
  try {
    const sheet = getSheet_();
    const last = sheet.getLastRow();
    const counts = {};
    CLASSES.forEach(function (c) { counts[c] = 0; });
    if (last >= 2) {
      const rows = sheet.getRange(2, 1, last - 1, 9).getValues();
      for (let i = 0; i < rows.length; i++) {
        const className = String(rows[i][4] || '').trim();
        if (!className) continue;
        if (!(className in counts)) counts[className] = 0;
        counts[className]++;
      }
    }
    return CLASSES.map(function (c) {
      return { className: c, count: counts[c] || 0 };
    }).sort(function (a, b) { return b.count - a.count; });
  } catch (err) {
    Logger.log('getUsageStats 失敗：' + err.message);
    return [];
  }
}

/** 前端呼叫：只修改用途，不修改預約時段 */
function modifyBooking(data) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (err) {
    return { ok: false, error: '現在送出的人太多，請過幾秒再試' };
  }
  try {
    const className = String(data.className || '');
    const week = String(data.week || '').trim();
    const weekday = String(data.weekday || '').trim();
    const period = String(data.period || '').trim();
    const purpose = String(data.purpose || '').trim().slice(0, 100);
    if (!className || !week || !weekday || !period || !purpose) {
      return { ok: false, error: '資料不完整' };
    }
    const sheet = getSheet_();
    const rows = sheet.getDataRange().getValues();
    let targetRow = -1;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][4]) === className &&
          String(rows[i][1]) === week &&
          String(rows[i][2]) === weekday &&
          String(rows[i][3]) === period) { targetRow = i + 1; break; }
    }
    if (targetRow === -1) return { ok: false, error: '找不到這筆預約' };
    sheet.getRange(targetRow, 6).setValue(purpose);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

const DEFAULT_QUICK_REPLIES = ['⚡ 預約明天', '🟢 查今天空堂', '🟢 查明天空堂', '📅 查本週預約', '🔍 查我的預約', '🏫 設定常用班級'];

/** 處理 Cloudflare Worker 轉送的 LINE 文字事件。 */
function handleLineEvent_(event) {
  if (!event) return;
  if (isDuplicateLineEvent_(event)) return;

  const replyToken = String(event.replyToken || '');
  if (event.type === 'follow') {
    replyLine_(replyToken, {
      text: lineHelp_(),
      quickReplies: DEFAULT_QUICK_REPLIES
    });
    return;
  }
  if (event.type !== 'message' || !event.message || event.message.type !== 'text') return;

  const userId = event.source && event.source.userId ? String(event.source.userId) : '';
  if (!userId) {
    replyLine_(replyToken, '請用 LINE 私訊官方帳號預約，不支援沒有使用者識別的群組訊息。');
    return;
  }

  let response;
  try {
    response = handleLineText_(userId, String(event.message.text || '').trim());
  } catch (err) {
    Logger.log('LINE 處理失敗：' + err.message);
    response = {
      text: '系統暫時無法處理這則訊息，請稍後再試或改用網頁預約。' + lineWebLink_(),
      quickReplies: DEFAULT_QUICK_REPLIES
    };
  }
  replyLine_(replyToken, response);
}

/** LINE 對話主流程：解析、補問、寫入或查詢。 */
function handleLineText_(userId, text) {
  if (!text) {
    return {
      text: '請輸入預約或查詢內容，或直接點選下方功能：\n\n' + lineHelp_(),
      quickReplies: DEFAULT_QUICK_REPLIES
    };
  }
  const command = text.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
  if (/^(取消|清除|重來|重新開始)$/.test(command)) {
    clearLineState_(userId);
    return {
      text: '已清除目前對話，請重新輸入預約內容或點選下方按鈕：',
      quickReplies: DEFAULT_QUICK_REPLIES
    };
  }
  if (/^(說明|功能|help)$/i.test(command)) {
    clearLineState_(userId);
    return {
      text: lineHelp_(),
      quickReplies: DEFAULT_QUICK_REPLIES
    };
  }

  // 常用班級綁定指令：例如「設定班級 四年甲班」「我是四年甲班」「換班 四年乙班」
  if (/^(設定常用班級|常用班級|設定班級|綁定班級|換班)$/.test(command)) {
    return {
      text: '🏫 請問您的常用班級是哪一班？請點選下方按鈕：',
      quickReplies: CLASSES.map(function (c) { return '設定班級 ' + c; })
    };
  }
  const bindMatch = /(?:設定班級|常用班級|綁定班級|綁定|我是|換班)\s*([四4][年][甲乙丙丁戊己庚辛]班?|[甲乙丙丁戊己庚辛]班)/.exec(text);
  if (bindMatch) {
    let targetClass = bindMatch[1].replace('4年', '四年');
    if (/^[甲乙丙丁戊己庚辛]班$/.test(targetClass)) targetClass = '四年' + targetClass;
    if (/^四年[甲乙丙丁戊己庚辛]$/.test(targetClass)) targetClass = targetClass + '班';
    targetClass = normalizeClassName_(targetClass);
    if (targetClass) {
      setUserDefaultClass_(userId, targetClass);
      return {
        text: '✅ 常用班級已設定為「' + targetClass + '」！\n下次預約只要說「明天早修借整台車」，就會自動為您填入 ' + targetClass + '，不用每次重選班級囉！',
        quickReplies: ['⚡ 預約明天', '🟢 查今天空堂', '🟢 查明天空堂', '🔍 查我的預約']
      };
    }
  }

  // 即時查空堂 / 預約現況
  if (/^(查今天|今天空堂|今天預約|今天狀況|今天有誰借)$/.test(command)) {
    const todayFields = relativeDateFields_('今天');
    let rows = getBookings(todayFields.week);
    rows = rows.filter(function (r) { return r.weekday === todayFields.weekday; });
    return {
      text: formatLineDayRows_(rows, '📅 ' + todayFields.week + ' ' + todayFields.weekday + '（今天）平板車借用現況', todayFields.weekday),
      quickReplies: ['⚡ 預約今天', '⚡ 預約明天', '🟢 查明天空堂', '📅 查本週預約', '🔍 查我的預約']
    };
  }
  if (/^(查明天|明天空堂|明天預約|明天狀況|明天有誰借)$/.test(command)) {
    const tomorrowFields = relativeDateFields_('明天');
    let rows = getBookings(tomorrowFields.week);
    rows = rows.filter(function (r) { return r.weekday === tomorrowFields.weekday; });
    return {
      text: formatLineDayRows_(rows, '📅 ' + tomorrowFields.week + ' ' + tomorrowFields.weekday + '（明天）平板車借用現況', tomorrowFields.weekday),
      quickReplies: ['⚡ 預約明天', '🟢 查今天空堂', '📅 查本週預約', '🔍 查我的預約']
    };
  }
  if (/^(查我的預約|我的預約|我借的|查詢我的預約)$/.test(command)) {
    const userClass = getUserDefaultClass_(userId);
    if (!userClass) {
      return {
        text: '您尚未設定常用班級，請問要查詢哪一個班級？請點選：',
        quickReplies: CLASSES.map(function (c) { return '查 ' + c; })
      };
    }
    const currentWeek = '第' + schoolWeekNumberToday_() + '週';
    let rows = myBookings(userClass);
    return {
      text: formatLineRows_(rows, '🏫 ' + userClass + ' 預約清單'),
      quickReplies: ['⚡ 預約明天', '🟢 查今天空堂', '🟢 查明天空堂', '🏫 設定常用班級']
    };
  }
  if (/^(查本週|查這週|本週預約|這週預約|本週空堂)$/.test(command)) {
    const currentWeek = '第' + schoolWeekNumberToday_() + '週';
    return {
      text: formatLineRows_(getBookings(currentWeek), '📅 ' + currentWeek + ' 平板車公開預約'),
      quickReplies: ['⚡ 預約明天', '🟢 查今天空堂', '🟢 查明天空堂', '🔍 查我的預約']
    };
  }
  if (/^預約明天$/.test(command) || command === '⚡預約明天') {
    const tmFields = relativeDateFields_('明天');
    saveLineState_(userId, { intent: 'book', fields: { week: tmFields.week, weekday: tmFields.weekday, periods: [] } });
    return {
      text: '🗓️ 已為您選擇「明天（' + tmFields.weekday + '）」\n⏰ 請問要預約第幾節？請直接點選下方節次：',
      quickReplies: PERIODS
    };
  }
  if (/^預約今天$/.test(command) || command === '⚡預約今天') {
    const tdFields = relativeDateFields_('今天');
    saveLineState_(userId, { intent: 'book', fields: { week: tdFields.week, weekday: tdFields.weekday, periods: [] } });
    return {
      text: '🗓️ 已為您選擇「今天（' + tdFields.weekday + '）」\n⏰ 請問要預約第幾節？請直接點選下方節次：',
      quickReplies: PERIODS
    };
  }

  const state = getLineState_(userId);
  // 本地規則先判：固定格式的訊息根本不用打 Gemini，不會塞車也不會等。
  const local = parseLineLocal_(text, state);
  let intent = local.intent;
  let fields = mergeLineFields_(state && state.fields, local.fields, text);

  // 1. 自動帶入教師常用班級
  const userClass = getUserDefaultClass_(userId);
  let usedDefaultClass = false;
  if (!fields.className && userClass) {
    fields.className = userClass;
    usedDefaultClass = true;
  }

  // 2. 借用方式智能預設（未填時預設為「整台車」）
  if (!fields.borrowType) {
    if (fields.tabletCount) {
      fields.borrowType = '平板';
    } else {
      fields.borrowType = '整台車';
      fields.tabletCount = 0;
    }
  }

  // 3. 用途智能預設（若已有節次且意圖為借用，用途預設為「課堂教學」）
  if (!fields.purpose && fields.periods.length > 0 && intent === 'book') {
    fields.purpose = '課堂教學';
  }

  if (intent === 'help') {
    clearLineState_(userId);
    return { text: lineHelp_(), quickReplies: DEFAULT_QUICK_REPLIES };
  }

  let missing = lineMissingFields_(intent, fields);
  if (!missing.length) {
    // 資料齊了，直接辦，不碰 Gemini。
  } else {
    // 缺資料才請 Gemini 補；塞車失敗就退回本地結果繼續問，不報錯卡住。
    try {
      const parsed = parseLineWithGemini_(text, state);
      const geminiIntent = (state && state.intent) || parsed.intent || intent;
      const geminiFields = mergeLineFields_(state && state.fields, parsed.fields, text);
      if (!geminiFields.className && userClass) {
        geminiFields.className = userClass;
        usedDefaultClass = true;
      }
      if (!geminiFields.borrowType) {
        geminiFields.borrowType = geminiFields.tabletCount ? '平板' : '整台車';
        if (geminiFields.borrowType === '整台車') geminiFields.tabletCount = 0;
      }
      if (!geminiFields.purpose && geminiFields.periods.length > 0 && geminiIntent === 'book') {
        geminiFields.purpose = '課堂教學';
      }
      const geminiMissing = lineMissingFields_(geminiIntent, geminiFields);
      if (!geminiMissing.length || geminiMissing.length < missing.length) {
        intent = geminiIntent;
        fields = geminiFields;
        missing = geminiMissing;
      }
    } catch (err) {
      Logger.log('Gemini 補解析失敗，改用本地結果：' + err.message);
      const raw = String(err.message || '');
      // 本地也完全沒抓到東西，才回塞車訊息；否則照本地缺什麼就問什麼。
      const localEmpty = !fields.week && !fields.weekday && !fields.periods.length &&
        !fields.className && !fields.borrowType && !fields.purpose;
      if (localEmpty) {
        if (/429|quota|RESOURCE_EXHAUSTED/i.test(raw)) {
          return {
            text: '今天 AI 用量已用完，請改用網頁預約或明天再試。' + lineWebLink_(),
            quickReplies: DEFAULT_QUICK_REPLIES
          };
        }
        return {
          text: 'AI 現在塞車中，請等約 1 分鐘後把剛才那句再傳一次，不用重打。' + lineWebLink_(),
          quickReplies: DEFAULT_QUICK_REPLIES
        };
      }
    }
    if (intent === 'help') {
      clearLineState_(userId);
      return { text: lineHelp_(), quickReplies: DEFAULT_QUICK_REPLIES };
    }
    missing = lineMissingFields_(intent, fields);
    if (missing.length) {
      saveLineState_(userId, { intent: intent, fields: fields });
      return lineQuestion_(intent, missing[0]);
    }
  }

  clearLineState_(userId);
  if (intent === 'query_week') {
    return {
      text: formatLineRows_(getBookings(fields.week), fields.week + ' 平板車公開預約'),
      quickReplies: ['⚡ 預約明天', '🟢 查今天空堂', '🟢 查明天空堂', '🔍 查我的預約']
    };
  }
  if (intent === 'query_class') {
    let rows = myBookings(fields.className);
    if (fields.week) rows = rows.filter(function (row) { return row.week === fields.week; });
    return {
      text: formatLineRows_(rows, fields.className + (fields.week ? ' ' + fields.week : '') + ' 預約清單'),
      quickReplies: ['⚡ 預約明天', '🟢 查今天空堂', '🟢 查明天空堂', '🏫 設定常用班級']
    };
  }
  if (intent !== 'book') {
    return { text: lineHelp_(), quickReplies: DEFAULT_QUICK_REPLIES };
  }

  const result = submitBooking_(fields, 'LINE');
  if (!result.ok) {
    return {
      text: '❌ 預約未成功：' + result.error + '\n\n💡 您可點選「查明天」或「查今天」看哪些時段還有空堂喔！',
      quickReplies: ['🟢 查今天空堂', '🟢 查明天空堂', '📅 查本週預約']
    };
  }

  // 第一次成功預約且尚未綁定常用班級者，自動為其記住常用班級
  let firstTimeBound = false;
  if (!userClass && fields.className) {
    setUserDefaultClass_(userId, fields.className);
    firstTimeBound = true;
  }

  const periodText = fields.periods.join('、');
  let successText = '🎉 預約成功！\n' +
    '━━━━━━━━━━━━\n' +
    '📅 時間：' + fields.week + ' ' + fields.weekday + ' ' + periodText + '\n' +
    '🏫 班級：' + fields.className + (usedDefaultClass ? '（常用班級）' : '') + '\n' +
    '📦 項目：' + borrowingLabel_(fields.borrowType, fields.tabletCount) + '\n' +
    '📝 用途：' + fields.purpose + '\n' +
    '━━━━━━━━━━━━\n' +
    '💡 提醒：使用前請至設備推車領取，用畢請插電歸位。';

  if (firstTimeBound) {
    successText += '\n\n🏫 已為您記住「' + fields.className + '」為常用班級！下次預約只要說「明天早修借整台車」，就能省略班級直接預約囉！';
  }

  return {
    text: successText,
    quickReplies: ['⚡ 預約明天', '🔍 查我的預約', '📅 查本週預約', '🏫 設定常用班級']
  };
}

/** 本地規則解析：固定格式不用打 Gemini，零等待、零塞車。 */
function parseLineLocal_(text, state) {
  const src = String(text || '');
  const compact = src.replace(/[\s\u200B-\u200D\uFEFF，,、。；;：:！!？?「」『』（）()【】\[\]\"'’“”]/g, '');
  const fields = { week: '', weekday: '', periods: [], className: '', borrowType: '', tabletCount: null, purpose: '' };

  // 週次：第3週 / 3週 / 第3周 / 本週 / 下週
  let m = /(第?\d+週|第?\d+周)/.exec(src);
  if (m) {
    const n = parseInt(m[1].replace(/[^\d]/g, ''), 10);
    if (n >= 1 && n <= SCHOOL_WEEK_COUNT_) fields.week = '第' + n + '週';
  } else if (/(?:本週|這週|本周|這周)/.test(src)) {
    const cur = schoolWeekNumberToday_();
    if (cur >= 1 && cur <= SCHOOL_WEEK_COUNT_) fields.week = '第' + cur + '週';
  } else if (/(?:下週|下周|下禮拜|下星期)/.test(src)) {
    const next = schoolWeekNumberToday_() + 1;
    if (next >= 1 && next <= SCHOOL_WEEK_COUNT_) fields.week = '第' + next + '週';
  }
  // 星期：星期二 / 週二 / 禮拜二 / 周二 / 二
  m = /(星期[一二三四五]|週[一二三四五]|禮拜[一二三四五]|周[一二三四五]|禮拜天|星期天)/.exec(src);
  if (m) {
    const map = { '星期一': 1, '星期二': 1, '星期三': 1, '星期四': 1, '星期五': 1 };
    let wd = m[1].replace('週', '星期').replace('周', '星期').replace('禮拜', '星期');
    if (wd === '星期天') wd = '';
    if (map[wd]) fields.weekday = wd;
    else fields.weekday = normalizeWeekday_(wd) || '';
  }
  // 節次：支援「早修」「第1節和第2節」「1、2節」「1-3節」「第四節」
  if (/早修|早自習/.test(src)) {
    if (fields.periods.indexOf('早修') === -1) fields.periods.push('早修');
  }
  const range = /([1-7一二三四五六七])\s*[-~～到]\s*([1-7一二三四五六七])\s*節/.exec(src);
  const cn = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7 };
  const toNum = function (c) { return cn[c] || Number(c); };
  if (range) {
    let a = toNum(range[1]); let b = toNum(range[2]);
    if (a > b) { const t = a; a = b; b = t; }
    for (let n = a; n <= b; n++) fields.periods.push('第' + n + '節');
  } else {
    const re = /(第?[1-7一二三四五六七]節)/g;
    let pm;
    while ((pm = re.exec(src)) !== null) {
      const p = normalizePeriod_(pm[1]);
      if (p && fields.periods.indexOf(p) === -1) fields.periods.push(p);
    }
  }
  fields.periods.sort(function (a, b) { return PERIODS.indexOf(a) - PERIODS.indexOf(b); });
  // 班級：四年甲班 / 4年甲班 / 甲班（單字補成四年X班）
  m = /([四4][年][甲乙丙丁戊己庚辛]班?|[甲乙丙丁戊己庚辛]班)/.exec(compact);
  if (m) {
    let c = m[1].replace('4年', '四年');
    if (/^[甲乙丙丁戊己庚辛]班$/.test(c)) c = '四年' + c;
    if (/^四年[甲乙丙丁戊己庚辛]$/.test(c)) c = c + '班';
    fields.className = normalizeClassName_(c) || c;
  }
  // 借用方式＋台數
  if (/整台車|整車|全車/.test(src)) {
    fields.borrowType = '整台車';
    fields.tabletCount = 0;
  } else if (/平板|平版/.test(src)) {
    fields.borrowType = '平板';
    const tm = /(\d+)\s*台/.exec(src);
    if (tm) fields.tabletCount = Number(tm[1]);
  }
  // 用途：扣掉已抓到的實體，剩下的當用途
  let rest = src;
  ['第\\d+週', '(?:本|這|下)(?:週|周|禮拜|星期)[一二三四五]?',
   '星期[一二三四五]', '週[一二三四五]', '禮拜[一二三四五]',
   '第?[1-7一二三四五六七]\\s*[-~～到]\\s*[1-7一二三四五六七]節', '第?[1-7一二三四五六七]節',
   '早修', '早自習',
   '四年[甲乙丙丁戊己庚辛]班?', '[甲乙丙丁戊己庚辛]班', '整台車', '整車', '全車', '平板', '平版', '\\d+台',
   '今天', '明天', '後天',
   '用途', '預約', '借用', '借', '請幫我', '請', '幫我', '是', '為', '查', '查詢', '看一下', '看'].forEach(function (pat) {
    rest = rest.replace(new RegExp(pat, 'g'), '');
  });
  rest = rest.replace(/[\s，,、。；;：:！!？?「」『』（）()【】\[\]\"'’“”和與及、]/g, '');
  if (rest.length >= 2) fields.purpose = rest.slice(0, 100);

  // 意圖判斷：有狀態先沿用，強關鍵字才切換
  let intent = (state && state.intent) || 'book';
  const wantQuery = /(查|查詢|看|多少|狀況|名單|有誰|已被借|被借|空堂|現況)/.test(src);
  const wantBook = /(預約|借用|借|登記)/.test(src);
  const hasClass = !!fields.className;
  const hasWeekOnly = !!fields.week && !hasClass;
  if (wantQuery && !wantBook) {
    if (hasClass) intent = 'query_class';
    else if (fields.week) intent = 'query_week';
    else if (/查|查詢|看/.test(src)) intent = hasClass ? 'query_class' : 'query_week';
  } else if (wantBook) {
    intent = 'book';
  } else if (!state || !state.intent) {
    // 無狀態的新訊息：有班或有完整預約資訊就當預約；只有週次就當查整週
    if (hasClass || fields.periods.length || fields.borrowType) intent = 'book';
    else if (hasWeekOnly) intent = 'query_week';
    else intent = 'book';
  }
  return { intent: intent, fields: fields };
}

/** Gemini 只負責把自然語句轉成 JSON，最終規則仍由 GAS 驗證。 */
function parseLineWithGemini_(text, state) {
  const properties = PropertiesService.getScriptProperties();
  const apiKey = properties.getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('尚未設定 GEMINI_API_KEY');
  const configuredModel = properties.getProperty('GEMINI_MODEL') || '';
  const model = configuredModel === 'gemini-2.5-flash' ? GEMINI_MODEL_DEFAULT : (configuredModel || GEMINI_MODEL_DEFAULT);
  const prompt = [
    '你是學校平板車預約助理，只能輸出一個 JSON 物件，不要輸出 Markdown 或解釋。',
    '請把使用者的新訊息與既有對話狀態合併解析。缺少資料時不要猜，留空字串、空陣列或 null。',
    'intent 只能是 book、query_week、query_class、help。',
    'book 必須解析：week（第1週到第' + SCHOOL_WEEK_COUNT_ + '週）、weekday、periods、className、borrowType、tabletCount、purpose。',
    '「今天」「明天」「後天」要依目前日期換算成正確的 week 與 weekday；「第四節」要解析成「第4節」。',
    'query_week 用來查整週公開預約，query_class 用來查某班預約；查詢可同時帶 week。',
    'borrowType 只能是「整台車」或「平板」；平板 tabletCount 只能是 1 到 ' + MAX_TABLET_COUNT + ' 的整數，整台車 tabletCount 為 0。',
    '班級只能從這些選項選：' + CLASSES.join('、') + '。節次只能從這些選項選：' + PERIODS.join('、') + '。',
    '輸出格式：{"intent":"book","fields":{"week":"","weekday":"","periods":[],"className":"","borrowType":"","tabletCount":null,"purpose":""}}。',
    '目前日期：' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd') + '；目前學校週次：第' + schoolWeekNumberToday_() + '週。',
    '既有對話狀態：' + JSON.stringify(state || {}),
    '使用者新訊息：' + text
  ].join('\n');
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  };
  const fallbackModel = properties.getProperty('GEMINI_FALLBACK_MODEL') || 'gemini-2.0-flash';
  const models = [model];
  if (fallbackModel && fallbackModel !== model) models.push(fallbackModel);
  let lastError = null;
  for (let m = 0; m < models.length; m++) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(models[m]) + ':generateContent';
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': apiKey },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const status = response.getResponseCode();
      const body = response.getContentText();
      if (status >= 200 && status < 300) {
        const data = JSON.parse(body);
        const output = data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
          data.candidates[0].content.parts[0].text;
        if (!output) throw new Error('Gemini 沒有回傳內容');
        return JSON.parse(stripCodeFence_(output));
      }
      lastError = new Error('Gemini HTTP ' + status + ': ' + body.slice(0, 300));
      // 503/500/502/504 才重試；429（配額）與 400（參數錯）重試沒用，直接換模型或報錯。
      const retryable = status === 500 || status === 502 || status === 503 || status === 504;
      if (!retryable) break;
      if (attempt < 2) Utilities.sleep((attempt + 1) * 1500);
    }
  }
  throw lastError || new Error('Gemini 沒有回傳內容');
}

function stripCodeFence_(text) {
  return String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function mergeLineFields_(previous, current, sourceText) {
  const oldFields = previous || {};
  const newFields = current || {};
  const fields = {
    week: oldFields.week || '',
    weekday: oldFields.weekday || '',
    periods: Array.isArray(oldFields.periods) ? oldFields.periods.slice() : [],
    className: oldFields.className || '',
    borrowType: oldFields.borrowType || '',
    tabletCount: oldFields.tabletCount === undefined ? '' : oldFields.tabletCount,
    purpose: oldFields.purpose || ''
  };
  if (newFields.week !== undefined && newFields.week !== null && String(newFields.week).trim()) fields.week = String(newFields.week).trim();
  if (newFields.weekday !== undefined && newFields.weekday !== null && String(newFields.weekday).trim()) fields.weekday = String(newFields.weekday).trim();
  if (Array.isArray(newFields.periods) && newFields.periods.length) fields.periods = newFields.periods.slice();
  if (newFields.className !== undefined && newFields.className !== null && String(newFields.className).trim()) fields.className = String(newFields.className).trim();
  if (newFields.borrowType !== undefined && newFields.borrowType !== null && String(newFields.borrowType).trim()) fields.borrowType = String(newFields.borrowType).trim();
  if (newFields.tabletCount !== undefined && newFields.tabletCount !== null && String(newFields.tabletCount).trim()) fields.tabletCount = newFields.tabletCount;
  if (newFields.purpose !== undefined && newFields.purpose !== null && String(newFields.purpose).trim()) fields.purpose = String(newFields.purpose).trim();

  fields.className = normalizeClassName_(fields.className) || fields.className;
  fields.weekday = normalizeWeekday_(fields.weekday) || fields.weekday;
  fields.periods = fields.periods.map(normalizePeriod_).filter(function (period) { return period; });
  if (/整台車/.test(fields.borrowType)) fields.borrowType = '整台車';
  if (/平板/.test(fields.borrowType)) fields.borrowType = '平板';
  if (/^第\d+週$/.test(String(fields.week))) fields.week = String(fields.week);
  else if (/^\d+$/.test(String(fields.week))) fields.week = '第' + Number(fields.week) + '週';
  const relativeDate = relativeDateFields_(sourceText);
  if (relativeDate.week) fields.week = relativeDate.week;
  if (relativeDate.weekday) fields.weekday = relativeDate.weekday;
  if (fields.borrowType === '整台車') fields.tabletCount = 0;
  fields.purpose = String(fields.purpose || '').trim().slice(0, 100);
  return fields;
}

function normalizeClassName_(value) {
  const text = String(value || '').trim();
  for (let i = 0; i < CLASSES.length; i++) {
    if (CLASSES[i] === text || CLASSES[i].replace('班', '') === text) return CLASSES[i];
  }
  return '';
}

function normalizeWeekday_(value) {
  const text = String(value || '').trim();
  const map = { '一': '星期一', '二': '星期二', '三': '星期三', '四': '星期四', '五': '星期五' };
  return map[text] || (['星期一', '星期二', '星期三', '星期四', '星期五'].indexOf(text) !== -1 ? text : '');
}

function normalizePeriod_(value) {
  const text = String(value || '').trim();
  if (text === '早修' || text === '早自習') return '早修';
  const match = /^(?:第)?([1-7一二三四五六七])(?:節)?$/.exec(text);
  if (!match) return PERIODS.indexOf(text) !== -1 ? text : '';
  const chineseNumbers = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7 };
  const number = chineseNumbers[match[1]] || Number(match[1]);
  return '第' + number + '節';
}

function relativeDateFields_(text) {
  const src = String(text || '');
  const dayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const dayIndexMap = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
  const now = todayInTaipei_();
  const todayDayOfWeek = now.getUTCDay();

  // 1. 今天 / 明天 / 後天
  let match = /(今天|明天|後天)/.exec(src);
  if (match) {
    const offset = { '今天': 0, '明天': 1, '後天': 2 }[match[1]];
    const target = new Date(now.getTime());
    target.setUTCDate(target.getUTCDate() + offset);
    const week = Math.floor((target.getTime() - SCHOOL_WEEK_START_) / (7 * 86400000)) + 1;
    const res = { weekday: dayNames[target.getUTCDay()] };
    if (week >= 1 && week <= SCHOOL_WEEK_COUNT_) res.week = '第' + week + '週';
    return res;
  }

  // 2. 下週 / 下禮拜 / 下星期 + [一二三四五]
  match = /下(?:週|周|禮拜|星期)\s*([一二三四五])/i.exec(src);
  if (match) {
    const targetDay = dayIndexMap[match[1]];
    const daysUntilNextMonday = (8 - todayDayOfWeek) % 7 || 7;
    const target = new Date(now.getTime());
    target.setUTCDate(target.getUTCDate() + daysUntilNextMonday + (targetDay - 1));
    const week = Math.floor((target.getTime() - SCHOOL_WEEK_START_) / (7 * 86400000)) + 1;
    const res = { weekday: dayNames[targetDay] };
    if (week >= 1 && week <= SCHOOL_WEEK_COUNT_) res.week = '第' + week + '週';
    return res;
  }

  // 3. 這週 / 本週 / 這禮拜 / 這星期 + [一二三四五]
  match = /(?:這|本)(?:週|周|禮拜|星期)\s*([一二三四五])/i.exec(src);
  if (match) {
    const targetDay = dayIndexMap[match[1]];
    const diff = targetDay - todayDayOfWeek;
    const target = new Date(now.getTime());
    target.setUTCDate(target.getUTCDate() + diff);
    const week = Math.floor((target.getTime() - SCHOOL_WEEK_START_) / (7 * 86400000)) + 1;
    const res = { weekday: dayNames[targetDay] };
    if (week >= 1 && week <= SCHOOL_WEEK_COUNT_) res.week = '第' + week + '週';
    return res;
  }

  // 4. 單獨說「星期幾 / 週幾 / 禮拜幾」而沒說週次
  match = /(?:星期|週|周|禮拜)\s*([一二三四五])/.exec(src);
  if (match && !/第?\d+\s*[週周]/.test(src)) {
    const targetDay = dayIndexMap[match[1]];
    let diff = targetDay - todayDayOfWeek;
    if (diff < 0) diff += 7; // 已過，自動順延至下週
    const target = new Date(now.getTime());
    target.setUTCDate(target.getUTCDate() + diff);
    const week = Math.floor((target.getTime() - SCHOOL_WEEK_START_) / (7 * 86400000)) + 1;
    const res = { weekday: dayNames[targetDay] };
    if (week >= 1 && week <= SCHOOL_WEEK_COUNT_) res.week = '第' + week + '週';
    return res;
  }

  return {};
}

function lineMissingFields_(intent, fields) {
  if (intent === 'query_week') return weekNumber_(fields.week) >= 1 && weekNumber_(fields.week) <= SCHOOL_WEEK_COUNT_ ? [] : ['week'];
  if (intent === 'query_class') {
    const missing = [];
    if (CLASSES.indexOf(fields.className) === -1) missing.push('className');
    if (fields.week && (weekNumber_(fields.week) < 1 || weekNumber_(fields.week) > SCHOOL_WEEK_COUNT_)) missing.push('week');
    return missing;
  }
  if (intent !== 'book') return [];
  const missing = [];
  if (CLASSES.indexOf(fields.className) === -1) missing.push('className');
  if (weekNumber_(fields.week) < 1 || weekNumber_(fields.week) > SCHOOL_WEEK_COUNT_) missing.push('week');
  if (['星期一', '星期二', '星期三', '星期四', '星期五'].indexOf(fields.weekday) === -1) missing.push('weekday');
  if (!fields.periods.length || fields.periods.some(function (period) { return PERIODS.indexOf(period) === -1; })) missing.push('periods');
  if (BORROW_TYPES.indexOf(fields.borrowType) === -1) missing.push('borrowType');
  if (fields.borrowType === '平板' && (!isFinite(Number(fields.tabletCount)) || Number(fields.tabletCount) < 1 || Number(fields.tabletCount) > MAX_TABLET_COUNT || Number(fields.tabletCount) !== Math.floor(Number(fields.tabletCount)))) missing.push('tabletCount');
  if (!fields.purpose) missing.push('purpose');
  return missing;
}

function lineQuestion_(intent, field) {
  const curWeek = schoolWeekNumberToday_();
  const nextWeek = Math.min(curWeek + 1, SCHOOL_WEEK_COUNT_);

  if (intent === 'query_week' && field === 'week') {
    return {
      text: '請問要查第幾週的公開預約？請點選下方按鈕：',
      quickReplies: ['第' + curWeek + '週(本週)', '第' + nextWeek + '週(下週)', '🟢 查今天空堂', '🟢 查明天空堂']
    };
  }
  if (intent === 'query_class' && field === 'className') {
    return {
      text: '請問要查哪一個班級？請點選下方按鈕：',
      quickReplies: CLASSES.map(function (c) { return '查 ' + c; })
    };
  }
  if (intent === 'query_class' && field === 'week') {
    return {
      text: '要查哪一週？請點選：',
      quickReplies: ['第' + curWeek + '週(本週)', '第' + nextWeek + '週(下週)', '查全部']
    };
  }

  const questions = {
    className: {
      text: '🏫 請問是哪一個班級要借用？請點選下方按鈕：',
      quickReplies: CLASSES
    },
    week: {
      text: '📅 請問要預約哪一週？請點選：',
      quickReplies: ['第' + curWeek + '週(本週)', '第' + nextWeek + '週(下週)']
    },
    weekday: {
      text: '🗓️ 請問要預約星期幾？請點選：',
      quickReplies: ['今天', '明天', '星期一', '星期二', '星期三', '星期四', '星期五']
    },
    periods: {
      text: '⏰ 請問要預約第幾節？可直接點選（點選一節即送出）：',
      quickReplies: PERIODS
    },
    borrowType: {
      text: '📦 請問要借「整台車」還是「平板」？',
      quickReplies: ['整台車', '平板 5台', '平板 10台']
    },
    tabletCount: {
      text: '📱 請問要借幾台平板？（最多 ' + MAX_TABLET_COUNT + ' 台）',
      quickReplies: ['3台', '5台', '8台', '10台']
    },
    purpose: {
      text: '📝 請問借用用途是什麼？可點選常用用途：',
      quickReplies: ['課堂教學', '數位學習', '隨堂測驗', '自主學習']
    }
  };

  return questions[field] || { text: '請補充預約資料。', quickReplies: ['說明'] };
}

function lineHelp_() {
  return '👋 老師好！我是平板車預約小幫手 🤖\n\n' +
    '⚡ 一句話極速預約（動動手指或說話）：\n' +
    '• 「明天早修借整台車」\n' +
    '• 「下週二第1節借平板5台」\n' +
    '• 「星期五第2節」\n\n' +
    '💡 老師最愛快捷功能：\n' +
    '• 🟢 查空堂：點選「查今天」或「查明天」\n' +
    '• 🏫 記住班級：點「設定常用班級」，下次預約免選班級！\n' +
    '• 🔍 查預約：點選「查我的預約」或「查本週」\n' +
    '• 🔄 重來：輸入「清除」隨時重新開始' + lineWebLink_();
}

function borrowingLabel_(borrowType, tabletCount) {
  return borrowType === '平板' ? '平板 ' + Number(tabletCount) + ' 台' : '整台車';
}

function formatLineDayRows_(rows, title, weekday) {
  const map = {};
  rows.forEach(function (r) {
    map[r.period] = r.className + '（' + borrowingLabel_(r.borrowType, r.tabletCount) + '）';
  });
  const periodTimes = {
    '早修': '07:40~08:30',
    '第1節': '08:40~09:20',
    '第2節': '09:30~10:10',
    '第3節': '10:30~11:10',
    '第4節': '11:20~12:00',
    '第5節': '13:30~14:10',
    '第6節': '14:20~15:00',
    '第7節': '15:20~16:00'
  };
  const lines = PERIODS.map(function (p) {
    const timeStr = periodTimes[p] ? ' ' + periodTimes[p] : '';
    if (isBlockedSlot_(weekday, p)) {
      return p + timeStr + '：⛔ 不開放預約';
    }
    if (map[p]) {
      return p + timeStr + '：🔴 ' + map[p];
    }
    return p + timeStr + '：🟢 可預約';
  });
  return title + '\n━━━━━━━━━━━━\n' + lines.join('\n') + lineWebLink_();
}

function formatLineRows_(rows, title) {
  if (!rows.length) return title + '\n━━━━━━━━━━━━\n目前沒有預約資料。' + lineWebLink_();
  const weekdays = ['星期一', '星期二', '星期三', '星期四', '星期五'];
  rows.sort(function (a, b) {
    if (a.week !== b.week) return a.week < b.week ? -1 : 1;
    if (weekdays.indexOf(a.weekday) !== weekdays.indexOf(b.weekday)) return weekdays.indexOf(a.weekday) - weekdays.indexOf(b.weekday);
    return PERIODS.indexOf(a.period) - PERIODS.indexOf(b.period);
  });
  const limit = 35;
  const lines = rows.slice(0, limit).map(function (row) {
    return '• ' + row.week + ' ' + row.weekday + ' ' + row.period + ' ' + row.className + '（' + borrowingLabel_(row.borrowType, row.tabletCount) + '）' +
      (row.purpose ? ' ｜ ' + row.purpose : '');
  });
  if (rows.length > limit) lines.push('（只顯示前 ' + limit + ' 筆，完整內容請開網頁。）');
  return clipLineText_(title + '\n━━━━━━━━━━━━\n' + lines.join('\n') + lineWebLink_());
}

function lineWebLink_() {
  const url = PropertiesService.getScriptProperties().getProperty('BOOKING_WEB_URL') || '';
  return url ? '\n\n網頁預約：' + url : '';
}

function clipLineText_(text) {
  const value = String(text || '');
  return value.length > 4900 ? value.slice(0, 4890) + '\n（內容過長，請開網頁查看。）' : value;
}

function replyLine_(replyToken, response, quickReplies) {
  if (!replyToken) return;
  const token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    Logger.log('尚未設定 LINE_CHANNEL_ACCESS_TOKEN');
    return;
  }

  let text = '';
  let replies = quickReplies || [];
  if (typeof response === 'object' && response !== null) {
    text = response.text || '';
    if (Array.isArray(response.quickReplies)) {
      replies = response.quickReplies;
    }
  } else {
    text = String(response || '');
  }

  const messageObj = {
    type: 'text',
    text: clipLineText_(text)
  };

  if (Array.isArray(replies) && replies.length > 0) {
    messageObj.quickReply = {
      items: replies.slice(0, 13).map(function (item) {
        const actionText = typeof item === 'string' ? item : (item.text || item.label);
        const actionLabel = typeof item === 'string' ? item : (item.label || item.text);
        return {
          type: 'action',
          action: {
            type: 'message',
            label: String(actionLabel).slice(0, 20),
            text: String(actionText).slice(0, 300)
          }
        };
      })
    };
  }

  const fetchResponse = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: [messageObj] }),
    muteHttpExceptions: true
  });
  if (fetchResponse.getResponseCode() < 200 || fetchResponse.getResponseCode() >= 300) {
    Logger.log('LINE 回覆失敗：' + fetchResponse.getResponseCode() + ' ' + fetchResponse.getContentText().slice(0, 300));
  }
}

function isDuplicateLineEvent_(event) {
  const eventId = String(event.webhookEventId || '');
  if (!eventId) return false;
  const cache = CacheService.getScriptCache();
  const key = 'line-event-' + eventId;
  if (cache.get(key)) return true;
  cache.put(key, '1', 600);
  return false;
}

function getUserDefaultClass_(userId) {
  if (!userId) return '';
  const sheet = getLineStateSheet_();
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === userId) {
      return String(rows[i][3] || '').trim();
    }
  }
  return '';
}

function setUserDefaultClass_(userId, className) {
  if (!userId || !className) return;
  const sheet = getLineStateSheet_();
  const rows = sheet.getDataRange().getValues();
  let rowNumber = -1;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === userId) { rowNumber = i + 1; break; }
  }
  if (rowNumber === -1) {
    rowNumber = sheet.getLastRow() + 1;
    sheet.getRange(rowNumber, 1, 1, 4).setValues([[userId, new Date(), '', className]]);
  } else {
    sheet.getRange(rowNumber, 4).setValue(className);
  }
}

function getLineState_(userId) {
  if (!userId) return null;
  const sheet = getLineStateSheet_();
  const rows = sheet.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][0]) !== userId) continue;
    const updated = rows[i][1] instanceof Date ? rows[i][1] : new Date(rows[i][1]);
    if (!updated.getTime() || Date.now() - updated.getTime() > LINE_STATE_TTL_MINUTES * 60000) {
      sheet.getRange(i + 1, 2, 1, 2).clearContent();
      return null;
    }
    try { return JSON.parse(String(rows[i][2] || '')); } catch (err) { return null; }
  }
  return null;
}

function saveLineState_(userId, state) {
  if (!userId) return;
  const sheet = getLineStateSheet_();
  const rows = sheet.getDataRange().getValues();
  let rowNumber = -1;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === userId) { rowNumber = i + 1; break; }
  }
  if (rowNumber === -1) rowNumber = sheet.getLastRow() + 1;
  sheet.getRange(rowNumber, 1, 1, 3).setValues([[userId, new Date(), JSON.stringify(state).slice(0, 5000)]]);
}

function clearLineState_(userId) {
  if (!userId) return;
  const sheet = getLineStateSheet_();
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === userId) {
      sheet.getRange(i + 1, 2, 1, 2).clearContent();
      return;
    }
  }
}

function getLineStateSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LINE_STATE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LINE_STATE_SHEET_NAME);
    sheet.appendRow(['LINE User ID', '更新時間', '狀態 JSON', '常用班級']);
  } else if (sheet.getLastColumn() < 4 || String(sheet.getRange(1, 4).getValue()).trim() !== '常用班級') {
    sheet.getRange(1, 4).setValue('常用班級');
  }
  return sheet;
}

function textResponse_(text) {
  return ContentService.createTextOutput(String(text)).setMimeType(ContentService.MimeType.TEXT);
}

/** 將新格式與舊版數量格式統一成兩種借用方式。 */
function bookingInfo_(typeValue, countValue) {
  const type = String(typeValue || '').trim();
  const count = Number(countValue);
  if (type === '平板' && isFinite(count) && count >= 1 && count <= MAX_TABLET_COUNT && count === Math.floor(count)) {
    return { borrowType: '平板', tabletCount: count };
  }
  if (type === '整台車') {
    return { borrowType: '整台車', tabletCount: 0 };
  }

  // 舊版 G 欄存的是借用台數；10 台內沿用為平板，其餘視為整台車。
  const legacyQuantity = Number(typeValue);
  if (isFinite(legacyQuantity) && legacyQuantity >= 1 && legacyQuantity <= MAX_TABLET_COUNT && legacyQuantity === Math.floor(legacyQuantity)) {
    return { borrowType: '平板', tabletCount: legacyQuantity };
  }
  return { borrowType: '整台車', tabletCount: 0 };
}

/** 內部用：拿到工作表，沒有就自動建一個並補上標題列 */
function getSheet_() {
  // 路線 A（從試算表的「擴充功能」開的）用這行：
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 路線 B（從 script.google.com 開的獨立腳本）改成這行，並填入你的試算表 ID：
  // const ss = SpreadsheetApp.openById('把試算表 ID 貼在這裡');

  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(BOOKING_HEADERS);
  } else if (sheet.getLastRow() <= 1) {
    // 新表尚無資料時，將舊版標題更新成含來源欄位的格式。
    sheet.getRange(1, 1, 1, BOOKING_HEADERS.length).setValues([BOOKING_HEADERS]);
  } else if (String(sheet.getRange(1, 7).getValue()).trim() !== '借用類型' ||
             String(sheet.getRange(1, 8).getValue()).trim() !== '平板台數' ||
             String(sheet.getRange(1, 9).getValue()).trim() !== '來源') {
    // 舊版已有資料時只更新標題，不改動既有預約列。
    sheet.getRange(1, 7, 1, 3).setValues([['借用類型', '平板台數', '來源']]);
  }
  return sheet;
}

/** 只給老師手動執行一次，用來觸發授權畫面（見步驟五） */
function 一鍵授權() {
  const sheet = getSheet_();
  Logger.log('工作表就緒：' + sheet.getName() + '，目前有 ' + (sheet.getLastRow() - 1) + ' 筆資料');
}
