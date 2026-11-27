// ════════════════════════════════════════════════════════════
// Expense Manager 後端 v3
//
// 更新步驟（從 v2 升級）：
//   1. 把這份整個貼上取代舊的，存檔
//   2. 上方函式選「setup」→ 執行 → 依指示授權（這次會多要「寄信」和「定時執行」權限）
//      執行記錄會顯示連線密碼（沿用原本那組，不會變）並寄一封確認信
//   3. 部署 → 管理部署作業 → 鉛筆 → 版本選「新版本」→ 部署（網址不變）
//
// 工作表說明（程式自動建立）：
//   db      目前資料（分段存放，每格最多 4 萬字，沒有容量上限問題）
//   backup  自動備份：最近 20 次存檔 + 每天一份保留 90 天
//   明細     每次存檔自動更新的「可讀版本」，可直接在試算表查看/篩選/匯出
//   data    v1 舊資料（不再寫入，留著當歷史備份）
//
// 手動執行的函式（上方選函式後按執行）：
//   setup()            第一次或升級時執行：顯示密碼、設定每天 05:40 提醒、寄確認信
//   testEmail()        立刻寄一封提醒信（不管今天有沒有要提醒的事）
//   listBackups()      在執行記錄列出所有備份
//   restoreBackup()    還原到某一份備份（先改下面 RESTORE_ROW 的數字）
//   resetToken()       換一組新的連線密碼，舊的立即失效
// ════════════════════════════════════════════════════════════
var BACKEND_VERSION = 'v3';
var CHUNK = 40000;        // 每格存 4 萬字（Google 單格上限 5 萬）
var KEEP_RECENT = 20;     // 最近 20 次存檔都保留
var KEEP_DAYS = 90;       // 另外每天保留一份，共 90 天
var RESTORE_ROW = 2;      // restoreBackup() 要還原的列（2 = 最新一份）
var TZ = 'Australia/Brisbane';   // 判斷「今天」與寄信時間用的時區
var REMIND_HOUR = 5;             // 每天提醒時間 05:40（Google 觸發器約有 ±15 分鐘誤差）
var REMIND_MINUTE = 40;
var APP_NAME = 'Expense Manager';

// ── 安裝 / 連線密碼 ──────────────────────────────────────
function setup() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    props.setProperty('TOKEN', token);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyCheck') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyCheck').timeBased()
    .atHour(REMIND_HOUR).nearMinute(REMIND_MINUTE).everyDays(1).inTimezone(TZ).create();
  var to = mailTo_(readDb_());
  MailApp.sendEmail({
    to: to, name: APP_NAME, subject: '【' + APP_NAME + '】提醒功能設定完成',
    htmlBody: mailWrap_('<p style="margin:0 0 12px">後端 ' + BACKEND_VERSION + ' 已經設定好了 ✅</p>' +
      '<p style="margin:0">每天早上約 05:40（' + TZ + '）會檢查一次：租金要繳或逾期、租約 7 天後到期、押金未退、每月固定繳款（例如車貸）快到期或逾期，有的話就寄信給你。</p>')
  });
  Logger.log('✅ 設定完成（' + BACKEND_VERSION + '）');
  Logger.log('🔑 你的連線密碼：' + token);
  Logger.log('📧 提醒信會寄到：' + to);
}
function resetToken() {
  var token = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  PropertiesService.getScriptProperties().setProperty('TOKEN', token);
  Logger.log('🔑 新的連線密碼：' + token);
}
/** 觸發器每天呼叫 */
function dailyCheck() { runCheck_(false); }
/** 手動測試：立刻寄一封提醒信 */
function testEmail() { Logger.log(JSON.stringify(runCheck_(true))); }

// ── 入口 ─────────────────────────────────────────────────
function doGet() {
  // 舊版網頁用 GET 存取：一律拒絕（新版只用 POST + 連線密碼）
  return json_({ error: 'AUTH' });
}

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token) return json_({ error: 'NO_SETUP' });
    if (String(req.token || '') !== token) return json_({ error: 'AUTH' });
    if (req.action === 'load') return load_();
    if (req.action === 'save') return save_(req);
    if (req.action === 'testEmail') return json_({ ok: true, version: BACKEND_VERSION, result: runCheck_(true) });
    return json_({ error: 'unknown action' });
  } catch (err) {
    return json_({ error: String(err) });
  }
}

// ── 讀取 ─────────────────────────────────────────────────
function load_() {
  var cur = readCurrent_();
  var body = '{"ok":true,"version":"' + BACKEND_VERSION + '","rev":' + cur.rev + ',"data":' + (cur.text || 'null') + '}';
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

// ── 存檔 ─────────────────────────────────────────────────
function save_(req) {
  var data = req.data;
  if (!data || typeof data !== 'object' || !data.settings || !Array.isArray(data.transactions)) {
    return json_({ error: 'BAD_DATA' });
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var cur = readCurrent_();
    // 其他裝置已經更新過 → 不覆蓋，讓前端決定
    if (!req.force && Number(req.baseRev) !== cur.rev) {
      return json_({ error: 'CONFLICT', rev: cur.rev });
    }
    var text = JSON.stringify(data);
    var rev = cur.rev + 1;
    writeCurrent_(text, rev);
    try { addBackup_(text, rev, data.transactions.length); } catch (e1) { Logger.log('backup failed: ' + e1); }
    try { writeMirror_(data); } catch (e2) { Logger.log('mirror failed: ' + e2); }
    return json_({ ok: true, rev: rev, version: BACKEND_VERSION });
  } finally {
    lock.releaseLock();
  }
}

// ── db 工作表：A1 是目錄，資料輪流寫在 B 欄或 C 欄（寫完才切換，中途失敗不會壞掉）──
function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function readCurrent_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('db');
  if (sh) {
    var metaRaw = String(sh.getRange(1, 1).getValue() || '');
    if (metaRaw) {
      var meta = JSON.parse(metaRaw.replace(/^~/, ''));
      var text = '';
      if (meta.chunks > 0) {
        var vals = sh.getRange(1, meta.col, meta.chunks, 1).getValues();
        for (var i = 0; i < vals.length; i++) text += String(vals[i][0]).slice(1); // 去掉前綴 ~
      }
      if (text.length !== meta.len) throw new Error('db 資料長度不符（' + text.length + '/' + meta.len + '），請用 restoreBackup 還原');
      return { rev: meta.rev, text: text };
    }
  }
  // 從 v1 舊格式（data!A1）搬過來
  var old = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('data');
  var legacy = old ? String(old.getRange(1, 1).getValue() || '') : '';
  if (legacy && legacy !== '{}') return { rev: 0, text: legacy };
  return { rev: 0, text: '' };
}
function readDb_() {
  var t = readCurrent_().text;
  try { return t ? JSON.parse(t) : null; } catch (e) { return null; }
}

function split_(text) {
  var parts = [];
  for (var i = 0; i < text.length; i += CHUNK) parts.push(['~' + text.slice(i, i + CHUNK)]); // ~ 前綴：避免被當成數字或公式
  return parts;
}

function writeCurrent_(text, rev) {
  var sh = sheet_('db');
  var metaRaw = String(sh.getRange(1, 1).getValue() || '');
  var oldCol = metaRaw ? JSON.parse(metaRaw.replace(/^~/, '')).col : 3;
  var col = oldCol === 2 ? 3 : 2;
  var parts = split_(text);
  var last = Math.max(sh.getLastRow(), 1);
  sh.getRange(1, col, last, 1).clearContent();
  sh.getRange(1, col, parts.length, 1).setValues(parts);
  var meta = { rev: rev, col: col, chunks: parts.length, len: text.length, savedAt: new Date().toISOString() };
  sh.getRange(1, 1).setValue('~' + JSON.stringify(meta));   // 最後才切換目錄
}

// ── 備份 ─────────────────────────────────────────────────
function addBackup_(text, rev, txCount) {
  var sh = sheet_('backup');
  if (!sh.getRange(1, 1).getValue()) {
    sh.getRange(1, 1, 1, 5).setValues([['時間', '版本', '交易筆數', '字數', '資料（分段）→']]);
  }
  var parts = split_(text).map(function (p) { return p[0]; });
  sh.insertRowBefore(2);
  sh.getRange(2, 1, 1, 4 + parts.length).setValues([[new Date(), rev, txCount, text.length].concat(parts)]);
  pruneBackups_(sh);
}

function pruneBackups_(sh) {
  var last = sh.getLastRow();
  if (last <= KEEP_RECENT + 1) return;
  var times = sh.getRange(2, 1, last - 1, 1).getValues();
  var cutoff = Date.now() - KEEP_DAYS * 86400000;
  var tz = Session.getScriptTimeZone();
  var seenDay = {};
  var toDelete = [];
  for (var i = 0; i < times.length; i++) {
    var t = new Date(times[i][0]);
    var day = Utilities.formatDate(t, tz, 'yyyy-MM-dd');
    var keep = i < KEEP_RECENT || (!seenDay[day] && t.getTime() >= cutoff);
    seenDay[day] = true;
    if (!keep) toDelete.push(i + 2);
  }
  for (var j = toDelete.length - 1; j >= 0; j--) sh.deleteRow(toDelete[j]);
}

// ── 明細（可讀版本）──────────────────────────────────────
function cell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v; // 避免被當成公式
  return v;
}
function writeMirror_(data) {
  var sh = sheet_('明細');
  var rows = [['日期', '幣別', '類別', '收入類別', '說明', '備註', '金額', '支付方式 / 帳戶', '轉出', '轉入', '信用卡']];
  var txs = data.transactions.slice().sort(function (a, b) {
    var d = String(b.date || '').localeCompare(String(a.date || ''));
    return d !== 0 ? d : (b.ts || 0) - (a.ts || 0);
  });
  txs.forEach(function (t) {
    var amt = t.cat === '內部轉帳' ? t.intAmt : t.cat === '信用卡費' ? t.ccAmt : t.cat === '換匯' ? t.fxOut : t.amount;
    var note = t.cat === '換匯' ? ((t.note ? t.note + ' · ' : '') + '轉入 ' + t.fxIn + ' ' + t.fxToCurr) : t.note;
    rows.push([cell_(t.date), cell_(t.currency || 'TWD'), cell_(t.cat), cell_(t.incomeCat), cell_(t.item), cell_(note),
      Number(amt) || 0, cell_(t.payMethod || t.ccFrom), cell_(t.intFrom || t.fxFrom), cell_(t.intTo || t.fxTo), cell_(t.ccCard)]);
  });
  sh.clearContents();
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
}

// ── 救援 ─────────────────────────────────────────────────
function listBackups() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('backup');
  if (!sh || sh.getLastRow() < 2) { Logger.log('沒有備份'); return; }
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  vals.forEach(function (v, i) { Logger.log('第 ' + (i + 2) + ' 列｜' + v[0] + '｜版本 ' + v[1] + '｜' + v[2] + ' 筆'); });
}

function restoreBackup() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('backup');
  var row = sh.getRange(RESTORE_ROW, 1, 1, sh.getLastColumn()).getValues()[0];
  var text = '';
  for (var i = 4; i < row.length; i++) { if (row[i] !== '' && row[i] !== null) text += String(row[i]).slice(1); }
  if (text.length !== Number(row[3])) throw new Error('備份長度不符，換一列試試');
  var data = JSON.parse(text);
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var rev = readCurrent_().rev + 1;
    writeCurrent_(text, rev);
    addBackup_(text, rev, data.transactions.length);
    writeMirror_(data);
    Logger.log('✅ 已還原第 ' + RESTORE_ROW + ' 列（' + row[0] + '，' + data.transactions.length + ' 筆）');
  } finally { lock.releaseLock(); }
}

// ── Email 提醒（租務 + 每月固定繳款）────────────────────────
function mailTo_(db) {
  var s = db && db.settings && db.settings.reminderEmail ? String(db.settings.reminderEmail).trim() : '';
  return s || Session.getEffectiveUser().getEmail();
}
function runCheck_(force) {
  var tStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var T = d2n(tStr);
  var props = PropertiesService.getScriptProperties();
  if (!force && props.getProperty('LAST_SENT') === tStr) return { sent: false, reason: '今天已經寄過' };
  var db = readDb_() || {};
  var items = buildAllReminders(db, T);
  if (!items.length && !force) return { sent: false, reason: '今天沒有需要提醒的項目' };
  var to = mailTo_(db);
  if (!to) throw new Error('找不到收件信箱');
  var subject = items.length
    ? '【' + APP_NAME + '】' + md(T) + ' ' + items[0].title + (items.length > 1 ? ' 等 ' + items.length + ' 項' : '')
    : '【' + APP_NAME + '】測試信 · 目前沒有待辦';
  var appUrl = db.settings && db.settings.appUrl || '';
  MailApp.sendEmail({ to: to, name: APP_NAME, subject: subject, htmlBody: mailHtml_(items, T, appUrl, force) });
  if (!force) props.setProperty('LAST_SENT', tStr);
  return { sent: true, to: to, count: items.length };
}

function mailHtml_(items, T, appUrl, force) {
  var colors = { overdue: '#ef4444', due: '#f59e0b', soon: '#7c6af7', end: '#14b8a6', bond: '#8b5cf6' };
  var tags = { overdue: '逾期', due: '今天繳費', soon: '即將到期', end: '租約即將到期', bond: '押金' };
  var body = '<p style="margin:0 0 16px;color:#64748b;font-size:13px">' + mdw(T) + (force ? ' · 測試寄送' : '') + '</p>';
  if (!items.length) body += '<p style="margin:0">目前沒有需要繳費或追蹤的項目，一切正常 👍</p>';
  items.forEach(function (it) {
    body += '<div style="border-left:4px solid ' + colors[it.level] + ';background:#f8fafc;border-radius:8px;padding:12px 14px;margin:0 0 10px">' +
      '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:' + colors[it.level] + ';margin-bottom:4px">' + tags[it.level] + '</div>' +
      '<div style="font-size:15px;font-weight:700;color:#0f172a">' + esc_(it.title) + '</div>' +
      '<div style="font-size:13px;color:#475569;margin-top:3px">' + esc_(it.detail) + '</div></div>';
  });
  return mailWrap_(body, appUrl);
}

function mailWrap_(inner, appUrl) {
  return '<div style="font-family:-apple-system,\'PingFang TC\',\'Microsoft JhengHei\',sans-serif;max-width:520px;margin:0 auto;padding:8px">' +
    '<div style="font-size:18px;font-weight:800;color:#0f172a;margin:0 0 4px">💰 ' + APP_NAME + '</div>' + inner +
    (appUrl ? '<p style="margin:18px 0 0"><a href="' + esc_(appUrl) + '" style="display:inline-block;background:#7c6af7;color:#fff;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:10px">打開 ' + APP_NAME + '</a></p>' : '') +
    '</div>';
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}


/* ===== 共用核心（網頁與 Apps Script 共用同一份，修改時兩邊一起換）=====
 * 租務：從租務本 V3 原封不動搬過來（analyze / buildReminders）
 * 每月固定繳款：recStatus / buildRecurringReminders
 * 日期一律用 'YYYY-MM-DD' 字串，運算時轉成「天數」整數（UTC 基準），不經過時區換算。 */
var DAYMS = 864e5;
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function d2n(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAYMS);
}
function n2d(n) {
  var t = new Date(n * DAYMS);
  return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
}
function wdOf(n) { return new Date(n * DAYMS).getUTCDay(); } // 0 = 星期日
function num(v) {
  var x = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(x) ? x : 0;
}
function rround2(x) { return Math.round(x * 100) / 100; }

/* 分析一份租約：已繳到哪天、下一期、是否逾期、押金狀態 */
function analyze(c, payments, T) {
  var start = d2n(c.start), end = d2n(c.end);
  var cycle = Math.max(1, Math.round(num(c.cycle)) || 7);
  var rate = num(c.rate);
  var rents = [], rentPaid = 0, otherPaid = 0, bondPaid = 0, refunded = 0, refundCount = 0;
  payments.forEach(function (p) {
    if (p.contractId !== c.id) return;
    var a = num(p.amount);
    if (p.kind === 'rent') {
      rentPaid += a;
      var f = d2n(p.from), t = d2n(p.to);
      if (f != null && t != null && t >= f) rents.push({ p: p, f: f, t: t });
    } else if (p.kind === 'bond') bondPaid += a;
    else if (p.kind === 'refund') { refunded += a; refundCount++; }
    else otherPaid += a;
  });
  rents.sort(function (a, b) { return a.f - b.f || a.t - b.t; });
  var merged = [];
  rents.forEach(function (r) {
    var L = merged[merged.length - 1];
    if (L && r.f <= L.t + 1) { if (r.t > L.t) L.t = r.t; }
    else merged.push({ f: r.f, t: r.t });
  });
  // 從開始日起「連續」繳到哪天（中間有缺就停在缺口前）
  var pt = start == null ? null : start - 1;
  if (start != null) {
    for (var i = 0; i < merged.length; i++) {
      var m = merged[i];
      if (m.t <= pt) continue;
      if (m.f <= pt + 1) pt = m.t; else break;
    }
  }
  var status = start == null ? 'active' : (T < start ? 'upcoming' : (end != null && T > end ? 'ended' : 'active'));
  var next = null;
  if (start != null) {
    var nf = pt + 1;
    if (!(end != null && nf > end)) {
      var nt = nf + cycle - 1;
      if (end != null && nt > end) nt = end;
      for (var j = 0; j < merged.length; j++) {
        if (merged[j].f > nf) { if (merged[j].f - 1 < nt) nt = merged[j].f - 1; break; }
      }
      var days = nt - nf + 1;
      var amount = days === cycle ? rate : rround2(rate * days / cycle);
      var due = c.mode === 'post' ? nt + 1 : nf;
      next = { from: nf, to: nt, days: days, amount: amount, due: due, daysLeft: due - T };
    }
  }
  return {
    start: start, end: end, cycle: cycle, rate: rate, status: status,
    rents: rents, merged: merged, paidThrough: pt, next: next,
    overdue: !!(next && next.daysLeft < 0), dueToday: !!(next && next.daysLeft === 0),
    rentPaid: rround2(rentPaid), otherPaid: rround2(otherPaid),
    bondPaid: rround2(bondPaid), refunded: rround2(refunded),
    bondSettled: refundCount > 0, bondHeld: refundCount > 0 ? 0 : rround2(bondPaid),
    bondExpected: rround2(num(c.bond))
  };
}

var TYPE_WORDS = {
  stay: { t: '住宿', in: '入住', out: '退租' },
  car: { t: '租車', in: '取車', out: '還車' },
  other: { t: '其他', in: '開始', out: '結束' }
};
function md(n) { var t = new Date(n * DAYMS); return (t.getUTCMonth() + 1) + '/' + t.getUTCDate(); }
function mdw(n) { return md(n) + '（' + '日一二三四五六'.charAt(wdOf(n)) + '）'; }
function money(x) {
  x = rround2(num(x));
  var neg = x < 0; x = Math.abs(x);
  var s = (x % 1 ? x.toFixed(2) : String(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + s;
}
function cname(c) { return c.name || c.party || (TYPE_WORDS[c.type] || TYPE_WORDS.other).t; }

/* 租務每日提醒清單 */
function buildReminders(contracts, payments, T) {
  var out = [];
  contracts.forEach(function (c) {
    var a = analyze(c, payments, T), w = TYPE_WORDS[c.type] || TYPE_WORDS.other, nm = cname(c);
    if (a.next) {
      var n = a.next, per = md(n.from) + '–' + md(n.to) + '（' + n.days + ' 天）';
      if (n.daysLeft === 0) out.push({ level: 'due', title: '今天要繳：' + nm + ' ' + money(n.amount), detail: w.t + ' · 期間 ' + per });
      else if (n.daysLeft < 0) out.push({ level: 'overdue', title: '已逾期 ' + (-n.daysLeft) + ' 天：' + nm + ' ' + money(n.amount), detail: w.t + ' · 應繳日 ' + mdw(n.due) + ' · 期間 ' + per });
    }
    if (a.end != null && a.end - T === 7 && a.status === 'active')
      out.push({ level: 'end', title: nm + ' 7 天後' + w.out + '（' + mdw(a.end) + '）', detail: '記得提前通知對方，並安排交接' });
    if (a.status === 'ended' && a.bondHeld > 0 && T - a.end >= 7 && (T - a.end) % 7 === 0)
      out.push({ level: 'bond', title: nm + ' 押金 ' + money(a.bondHeld) + ' 還沒標記退回', detail: w.out + '日 ' + md(a.end) + '，已過 ' + (T - a.end) + ' 天' });
  });
  var rank = { overdue: 0, due: 1, end: 2, bond: 3 };
  out.sort(function (x, y) { return rank[x.level] - rank[y.level]; });
  return out;
}

/* ---------- 每月固定繳款 ---------- */
function cmoney(x, curr) {
  x = rround2(num(x));
  var neg = x < 0; x = Math.abs(x);
  var s = curr === 'AUD' ? x.toFixed(2) : String(Math.round(x));
  s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + (curr === 'AUD' ? 'A$' : 'NT$') + s;
}
function ymOf(n) { return n2d(n).slice(0, 7); }
function ymAdd(ym, k) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + k;
  var d = new Date(Date.UTC(y, m, 1));
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1);
}
/* 某個月的應繳日（例如每月 31 號，遇到 2 月就是 2 月最後一天） */
function recDue(r, ym) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  var d = Math.min(Math.max(1, Math.round(num(r.day)) || 1), last);
  return Math.round(Date.UTC(y, m - 1, d) / DAYMS);
}
/* 每一期（月）的狀態：從開始月份到本月；本月已繳就多顯示下個月 */
function recStatus(r, txs, T) {
  var cur = ymOf(T), start = /^\d{4}-\d{2}$/.test(r.startMonth || '') ? r.startMonth : cur;
  var endM = /^\d{4}-\d{2}$/.test(r.endMonth || '') ? r.endMonth : null;
  var lead = Math.max(0, Math.round(num(r.lead)));
  var paidBy = {};
  txs.forEach(function (t) { if (t.recurringId === r.id && t.period) paidBy[t.period] = t; });
  var periods = [], unpaid = [];
  var last = cur < start ? start : cur;
  for (var ym = start; ym <= last; ym = ymAdd(ym, 1)) {
    if (endM && ym > endM) break;
    var due = recDue(r, ym), tx = paidBy[ym] || null;
    var p = { ym: ym, due: due, daysLeft: due - T, remindFrom: due - lead, paid: tx };
    periods.push(p);
    if (!tx) unpaid.push(p);
  }
  var next = unpaid[0] || null;
  if (!next) {
    var nym = ymAdd(last, 1);
    if (!(endM && nym > endM)) { var nd = recDue(r, nym); next = { ym: nym, due: nd, daysLeft: nd - T, remindFrom: nd - lead, paid: null }; }
  }
  return { periods: periods, unpaid: unpaid, next: next, lead: lead, ended: !!(endM && cur > endM && !unpaid.length) };
}
function buildRecurringReminders(recs, txs, T) {
  var out = [];
  (recs || []).forEach(function (r) {
    if (r.active === false) return;
    var st = recStatus(r, txs, T), cur = r.currency === 'AUD' ? 'AUD' : 'TWD';
    st.unpaid.forEach(function (p) {
      if (T < p.remindFrom) return;
      var amt = cmoney(r.amount, cur), mo = (+p.ym.slice(5, 7)) + ' 月';
      if (p.daysLeft < 0) out.push({ level: 'overdue', title: '已逾期 ' + (-p.daysLeft) + ' 天：' + r.name + ' ' + amt, detail: mo + '份 · 應繳日 ' + mdw(p.due) });
      else if (p.daysLeft === 0) out.push({ level: 'due', title: '今天要繳：' + r.name + ' ' + amt, detail: mo + '份 · 每月 ' + r.day + ' 號' });
      else out.push({ level: 'soon', title: (p.daysLeft === 1 ? '明天要繳：' : p.daysLeft + ' 天後要繳：') + r.name + ' ' + amt, detail: mo + '份 · 應繳日 ' + mdw(p.due) });
    });
  });
  return out;
}
/* 租務 + 每月固定，合併成一份提醒（Email 與網頁共用） */
function buildAllReminders(db, T) {
  var rent = db && db.rent ? db.rent : { contracts: [], payments: [] };
  var out = buildReminders(rent.contracts || [], rent.payments || [], T)
    .concat(buildRecurringReminders(db && db.recurring || [], db && db.transactions || [], T));
  var rank = { overdue: 0, due: 1, soon: 2, end: 3, bond: 4 };
  out.sort(function (x, y) { return rank[x.level] - rank[y.level]; });
  return out;
}
/* ===== 共用核心結束 ===== */
