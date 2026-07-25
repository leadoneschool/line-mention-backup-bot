/**
 * LINE 群組「被 Tag 訊息」備份 Bot v5.2(整合完整版)
 * =================================================
 * 功能:
 *  1. Bot 待在 LINE 群組裡,即時記錄所有「@某人」與「@All」的訊息
 *  2. 定時把「你被 tag 的訊息」做成聊天截圖樣式的卡片,私訊給本人當備份
 *  3. 資料存在雲端(JSONBin),伺服器重啟不會遺失設定與名單
 *  4. 內建 LINE 推播額度守門員,額度吃緊自動降級,不會無聲無息停止服務
 *
 * 環境變數:
 *   LINE_CHANNEL_ACCESS_TOKEN  必填  LINE Developers → Messaging API 分頁
 *   LINE_CHANNEL_SECRET        必填  LINE Developers → Basic settings 分頁
 *   JSONBIN_BIN_ID             建議  jsonbin.io 的 Bin ID(雲端儲存)
 *   JSONBIN_API_KEY            建議  jsonbin.io 的 Master Key
 *   DAILY_CRON                 選填  主要寄送時間,預設 0 21 * * *(晚上 9:00)
 *   EXTRA_CRON                 選填  加班場時間,例如 0 11 * * *(額度不足會自動停辦)
 *   EXTRA_MIN_REMAINING        選填  剩餘額度低於此值就停辦加班場,預設 60
 *   MONTHLY_PUSH_LIMIT         選填  LINE 方案每月推播上限,預設 200
 *   QUOTA_RESERVE              選填  保留給主要彙整的額度,預設 20
 *   BUFFER_MINUTES             選填  合併模式預設間隔分鐘,預設 60
 *
 * 使用者指令(在「自己和 Bot 的一對一聊天室」輸入):
 *   !每日            每天固定時間彙整寄出一張卡片(最省額度,預設)
 *   !合併 / !即時     訊息累積 N 分鐘後合併成一張寄出(較耗額度)
 *   !間隔 30         設定自己的合併間隔為 30 分鐘(5~240)
 *   !全體開 / !全體關  是否接收 @All 的備份
 *   !停用 / !啟用     完全不收 / 恢復接收
 *   !設定            查看自己目前的設定
 *   !額度            查看本月推播用量
 *   !測試 內容        模擬「自己被 tag」(LINE 不允許 @ 自己,測試用)
 *   !備份            立刻寄出目前累積的訊息
 *
 * LINE 官方限制(無法繞過):
 *   - 收備份的人必須先加 Bot 好友,否則 Bot 無法私訊他
 *   - Bot 只能記錄「加入群組之後」的訊息,無法讀取歷史對話
 *   - Bot 無法真的截圖,改用 Flex 卡片繪製對話樣式
 *   - @All 只能傳給「Bot 見過的成員」(發過言、被 tag 過、加入時被記錄到的人)
 *   - 發 @All 的人自己不會收到該則備份
 */

'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ====== 設定 ======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('❌ 請先設定環境變數 LINE_CHANNEL_ACCESS_TOKEN 和 LINE_CHANNEL_SECRET');
  process.exit(1);
}

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID || '';
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY || '';
const USE_CLOUD = Boolean(JSONBIN_BIN_ID && JSONBIN_API_KEY);

const MONTHLY_PUSH_LIMIT = parseInt(process.env.MONTHLY_PUSH_LIMIT || '200', 10);
const QUOTA_RESERVE = parseInt(process.env.QUOTA_RESERVE || '20', 10);
const DEFAULT_BUFFER_MIN = parseInt(process.env.BUFFER_MINUTES || '60', 10);
const DAILY_CRON = process.env.DAILY_CRON || '0 21 * * *';
// 「加班場」寄送時間(選填)。額度充足時才會執行,額度吃緊會自動略過 → 自動降級成一天一次
const EXTRA_CRON = process.env.EXTRA_CRON || '';
const EXTRA_MIN_REMAINING = parseInt(process.env.EXTRA_MIN_REMAINING || '60', 10);
const TIMEZONE = 'Asia/Taipei';

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ====== 資料儲存 ======
const DATA_FILE = path.join(__dirname, 'data.json');

function emptyDb() {
  return {
    mentions: {}, // { userId: [ {groupName, senderName, text, time, ts, isAll} ] }
    settings: {}, // { userId: { mode, all, bufferMin, off } }
    members: {},  // { groupId: { userId: true } }
    quota: { month: '', used: 0 },
  };
}

let db = emptyDb();

async function loadData() {
  if (USE_CLOUD) {
    try {
      const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: { 'X-Master-Key': JSONBIN_API_KEY },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      db = { ...emptyDb(), ...(json.record || {}) };
      if (!db.quota) db.quota = { month: '', used: 0 };
      console.log('☁️ 已從 JSONBin 載入雲端資料');
      return;
    } catch (e) {
      console.error(`⚠️ 雲端載入失敗,以空資料啟動:${e.message}`);
      db = emptyDb();
      return;
    }
  }
  try {
    db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
    console.log('💾 已從本機檔案載入資料(重啟會遺失)');
  } catch (e) {
    db = emptyDb();
  }
}

let saveTimer = null;
let saving = false;
let dirtyAgain = false;

async function uploadToCloud() {
  if (saving) { dirtyAgain = true; return; }
  saving = true;
  try {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
      body: JSON.stringify(db),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`⚠️ 雲端存檔失敗:${e.message}`);
  } finally {
    saving = false;
    if (dirtyAgain) { dirtyAgain = false; scheduleSave(); }
  }
}

function scheduleSave() {
  if (!USE_CLOUD) {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) {}
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(uploadToCloud, 5000);
}

function saveData() { scheduleSave(); }

// ====== 時間工具 ======
function nowTaipeiString() {
  return new Date().toLocaleString('zh-TW', {
    timeZone: TIMEZONE, hour12: false,
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function todayTaipeiDate() {
  return new Date().toLocaleDateString('zh-TW', { timeZone: TIMEZONE });
}

function currentMonthKey() {
  // 以台灣時間判斷月份,例如 2026-07
  const s = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD
  return s.slice(0, 7);
}

// 把 cron 字串轉成人看得懂的時間,例如 "0 21 * * *" → "21:00"
function cronToHuman(expr) {
  if (!expr) return '(未設定)';
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length < 2) return expr;
  const min = parts[0];
  const hours = parts[1];
  if (!/^\d+$/.test(min)) return expr;
  const mm = String(min).padStart(2, '0');
  const list = hours.split(',');
  if (!list.every((h) => /^\d+$/.test(h))) return expr;
  return list.map((h) => `${String(h).padStart(2, '0')}:${mm}`).join('、');
}

const DAILY_TIME_TEXT = cronToHuman(DAILY_CRON);
const EXTRA_TIME_TEXT = cronToHuman(EXTRA_CRON);

// ====== 額度守門員 ======
function getQuota() {
  const m = currentMonthKey();
  if (db.quota.month !== m) {
    db.quota = { month: m, used: 0 }; // 跨月自動重置
    saveData();
    console.log(`🗓️ 進入新月份 ${m},推播額度已重置`);
  }
  return db.quota;
}

function quotaRemaining() {
  return MONTHLY_PUSH_LIMIT - getQuota().used;
}

// kind: 'buffer'(合併寄送) | 'daily'(主要彙整) | 'extra'(加班場彙整)
function canPush(kind) {
  const used = getQuota().used;
  if (kind === 'daily') return used < MONTHLY_PUSH_LIMIT;               // 主要彙整:用到最後一刻
  if (kind === 'extra') return quotaRemainingRaw() > EXTRA_MIN_REMAINING; // 加班場:額度吃緊就停辦
  return used < MONTHLY_PUSH_LIMIT - QUOTA_RESERVE;                     // 合併模式:先讓路
}

function quotaRemainingRaw() {
  return MONTHLY_PUSH_LIMIT - getQuota().used;
}

// 加班場目前是否還在運作(額度充足)
function extraActive() {
  return Boolean(EXTRA_CRON) && quotaRemainingRaw() > EXTRA_MIN_REMAINING;
}

function countPush() {
  getQuota().used += 1;
  saveData();
}

// ====== 使用者設定 ======
function getUserSetting(userId) {
  const s = db.settings[userId] || {};
  return {
    mode: s.mode === 'buffer' ? 'buffer' : 'daily', // 預設每日(最省)
    all: s.all !== false,
    bufferMin: Number.isFinite(s.bufferMin) ? s.bufferMin : DEFAULT_BUFFER_MIN,
    off: s.off === true,
  };
}

function setUserSetting(userId, patch) {
  db.settings[userId] = { ...(db.settings[userId] || {}), ...patch };
  saveData();
}

function rememberMember(groupId, userId) {
  if (!groupId || !userId) return;
  if (!db.members[groupId]) db.members[groupId] = {};
  if (!db.members[groupId][userId]) {
    db.members[groupId][userId] = true;
    saveData();
  }
}

// ====== LINE 資料 ======
async function getSenderName(source) {
  try {
    if (source.type === 'group') {
      const p = await client.getGroupMemberProfile(source.groupId, source.userId);
      return p.displayName;
    }
    const p = await client.getProfile(source.userId);
    return p.displayName;
  } catch (e) {
    return '(未知成員)';
  }
}

async function getGroupName(groupId) {
  try {
    const s = await client.getGroupSummary(groupId);
    return s.groupName;
  } catch (e) {
    return 'LINE 群組';
  }
}

// ====== Flex Message(聊天截圖樣式)======
function recordBubbleBox(r) {
  return {
    type: 'box', layout: 'vertical', backgroundColor: '#FFFFFF',
    cornerRadius: '12px', paddingAll: '10px', margin: 'md',
    contents: [
      {
        type: 'text',
        text: `${r.senderName}　${r.time}${r.isAll ? '　📢@全體' : ''}`,
        size: 'xs', color: '#888888',
      },
      { type: 'text', text: r.text, size: 'sm', color: '#111111', wrap: true, margin: 'sm' },
      { type: 'text', text: `📌 來自:${r.groupName}`, size: 'xxs', color: '#AAAAAA', margin: 'sm' },
    ],
  };
}

function buildFlex(title, subtitle, records) {
  const items = records.slice(0, 15).map(recordBubbleBox);
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble', size: 'giga',
      body: {
        type: 'box', layout: 'vertical', backgroundColor: '#8CABD9', paddingAll: '14px',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'md', color: '#FFFFFF' },
          { type: 'text', text: subtitle, size: 'xs', color: '#EEF3FA', margin: 'sm' },
          ...items,
        ],
      },
    },
  };
}

function subtitleOf(records) {
  return `共 ${records.length} 則${records.length > 15 ? '(僅顯示前 15 則)' : ''}`;
}

function buildMergedFlex(records) {
  return buildFlex(`🔔 你有 ${records.length} 則被 Tag 訊息`, `合併備份・${nowTaipeiString()}`, records);
}

function buildDailyFlex(records) {
  return buildFlex(`📋 ${todayTaipeiDate()} 被 Tag 訊息備份`, subtitleOf(records), records);
}

// ====== 寄送 ======
async function pushToUser(userId, flexMessage) {
  try {
    await client.pushMessage({ to: userId, messages: [flexMessage] });
    countPush();
    return true;
  } catch (e) {
    console.error(`⚠️ 無法私訊 ${userId}:${e.message}`);
    return false;
  }
}

// 寄出某人累積的訊息(kind 決定額度門檻)
async function flushUser(userId, kind) {
  const records = db.mentions[userId];
  if (!records || records.length === 0) return false;

  if (!canPush(kind)) {
    console.log(`🛑 額度守門員:略過 ${kind} 寄送(本月已用 ${getQuota().used}/${MONTHLY_PUSH_LIMIT})`);
    return false; // 保留資料,等主要彙整或下個月
  }

  const flex = kind === 'buffer' ? buildMergedFlex(records) : buildDailyFlex(records);
  const ok = await pushToUser(userId, flex);
  delete db.mentions[userId]; // 不論成功與否都清空,避免無限累積
  saveData();
  if (ok) console.log(`✅ 已寄給 ${userId}(${records.length} 則,${kind})`);
  return ok;
}

// 每分鐘檢查:合併模式的人時間到了就寄
async function flushBuffers() {
  const now = Date.now();
  for (const userId of Object.keys(db.mentions)) {
    const s = getUserSetting(userId);
    if (s.mode !== 'buffer') continue;
    const records = db.mentions[userId];
    if (!records || records.length === 0) continue;
    const firstTs = records[0].ts || now;
    if (now - firstTs >= s.bufferMin * 60 * 1000) {
      await flushUser(userId, 'buffer');
    }
  }
}

// 主要彙整(每天必寄)
async function sendDailyBackups() {
  console.log(`⏰ 主要彙整開始,本月已用額度 ${getQuota().used}/${MONTHLY_PUSH_LIMIT}`);
  for (const userId of Object.keys(db.mentions)) {
    await flushUser(userId, 'daily');
  }
}

// 加班場彙整(額度充足才寄;吃緊時自動略過 = 降級成一天一次)
async function sendExtraBackups() {
  if (!extraActive()) {
    console.log(`🛑 額度吃緊(剩 ${quotaRemainingRaw()} 則,門檻 ${EXTRA_MIN_REMAINING}),本次加班場略過,自動降級為一天一次`);
    return;
  }
  console.log(`⏰ 加班場彙整開始,本月已用額度 ${getQuota().used}/${MONTHLY_PUSH_LIMIT}`);
  for (const userId of Object.keys(db.mentions)) {
    await flushUser(userId, 'extra');
  }
}

// 收到一筆被 tag 的訊息 → 一律先進緩衝區
function recordMention(userId, record) {
  const s = getUserSetting(userId);
  if (s.off) return;                      // 這個人停用了
  if (record.isAll && !s.all) return;     // 這個人關掉 @All
  if (!db.mentions[userId]) db.mentions[userId] = [];
  db.mentions[userId].push(record);
  saveData();
  console.log(`📝 已記錄給 ${userId}(${s.mode}${record.isAll ? '・@All' : ''})`);
}

// ====== 指令 ======
async function replyText(replyToken, text) {
  try {
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
  } catch (e) {
    console.error(`⚠️ 回覆失敗:${e.message}`);
  }
}

function normalizeCmd(text) {
  return text.replace(/！/g, '!').trim();
}

async function handleCommand(event) {
  const { source, message, replyToken } = event;
  const cmd = normalizeCmd(message.text);
  const userId = source.userId;
  if (!cmd.startsWith('!')) return false;

  if (cmd === '!合併' || cmd === '!即時') {
    setUserSetting(userId, { mode: 'buffer', off: false });
    const s = getUserSetting(userId);
    await replyText(replyToken, `⚡ 已切換為【合併模式】\n被 tag 的訊息會先累積,每 ${s.bufferMin} 分鐘合併成一張卡片寄給你。\n\n這樣一次爆多則只花 1 則額度,比舊的即時模式省很多。\n輸入「!間隔 30」可改成 30 分鐘。`);
    return true;
  }

  if (cmd === '!每日') {
    setUserSetting(userId, { mode: 'daily', off: false });
    const extraNote = EXTRA_CRON ? `\n(額度充足時,另外在 ${EXTRA_TIME_TEXT} 加寄一次)` : '';
    await replyText(replyToken, `📋 已切換為【每日模式】(最省額度)\n每天 ${DAILY_TIME_TEXT} 一次寄出當天所有被 tag 的訊息。${extraNote}`);
    return true;
  }

  if (cmd.startsWith('!間隔')) {
    const n = parseInt(cmd.replace('!間隔', '').trim(), 10);
    if (!Number.isFinite(n) || n < 5 || n > 240) {
      await replyText(replyToken, '請輸入 5 到 240 之間的分鐘數,例如:!間隔 30');
      return true;
    }
    setUserSetting(userId, { bufferMin: n, mode: 'buffer', off: false });
    await replyText(replyToken, `⏱️ 合併間隔已設為 ${n} 分鐘(並自動切換為合併模式)。\n間隔越長越省額度。`);
    return true;
  }

  if (cmd === '!全體開') {
    setUserSetting(userId, { all: true });
    await replyText(replyToken, '📢 已開啟【@All 備份】');
    return true;
  }

  if (cmd === '!全體關') {
    setUserSetting(userId, { all: false });
    await replyText(replyToken, '🔕 已關閉【@All 備份】\n(這會替整個群組省下不少額度)');
    return true;
  }

  if (cmd === '!停用') {
    setUserSetting(userId, { off: true });
    await replyText(replyToken, '⛔ 已停用備份,你不會再收到任何卡片。\n輸入 !啟用 可恢復。');
    return true;
  }

  if (cmd === '!啟用') {
    setUserSetting(userId, { off: false });
    await replyText(replyToken, '✅ 已恢復備份功能。');
    return true;
  }

  if (cmd === '!額度') {
    const q = getQuota();
    const left = quotaRemaining();
    const bar = left <= 0 ? '🔴 已用完' : left <= QUOTA_RESERVE ? '🟡 快用完(僅剩每日彙整)' : '🟢 充足';
    const extraLine = EXTRA_CRON
      ? (extraActive()
          ? `\n加班場寄送:🟢 運作中(一天兩次)`
          : `\n加班場寄送:🟡 已自動停辦(降級為一天一次)`)
      : '';
    await replyText(replyToken, `📊 本月推播額度(${q.month})\n已使用:${q.used} / ${MONTHLY_PUSH_LIMIT}\n剩餘:${left} 則\n狀態:${bar}${extraLine}\n\n※ 每月 1 號自動重置\n※ 指令回覆不佔額度,只有備份卡片會佔`);
    return true;
  }

  if (cmd === '!設定') {
    const s = getUserSetting(userId);
    const mode = s.off ? '⛔ 已停用' : s.mode === 'buffer' ? `⚡ 合併模式(每 ${s.bufferMin} 分鐘)` : `📋 每日模式(${DAILY_TIME_TEXT} 寄出)`;
    const allState = s.all ? '📢 開啟' : '🔕 關閉';
    const pending = (db.mentions[userId] || []).length;
    const storage = USE_CLOUD ? '☁️ 雲端' : '💾 本機(重啟會遺失)';
    await replyText(replyToken,
      `你目前的設定:\n備份模式:${mode}\n@All 備份:${allState}\n待寄訊息:${pending} 則\n資料儲存:${storage}\n本月額度:${getQuota().used}/${MONTHLY_PUSH_LIMIT}\n\n指令:\n!每日 / !合併 → 切換模式\n!間隔 30 → 合併間隔(分鐘)\n!全體開 / !全體關\n!停用 / !啟用\n!額度 → 查看本月用量\n!備份 → 立刻寄出待寄訊息`);
    return true;
  }

  if (cmd === '!備份') {
    await flushUser(userId, 'daily');
    return true;
  }

  if (cmd.startsWith('!測試')) {
    const senderName = await getSenderName(source);
    const groupName = source.type === 'group' ? await getGroupName(source.groupId) : '(一對一測試)';
    recordMention(userId, {
      groupName, senderName, text: message.text,
      time: nowTaipeiString(), ts: Date.now(), isAll: false,
    });
    const s = getUserSetting(userId);
    const hint = s.off ? '你目前是停用狀態,不會收到卡片。' :
      s.mode === 'buffer' ? `已記錄,將在 ${s.bufferMin} 分鐘內合併寄出。想立刻看結果請輸入 !備份。` :
      '已記錄(每日模式)。輸入 !備份 可立刻收到卡片。';
    await replyText(replyToken, `✅ ${hint}`);
    return true;
  }

  return false;
}

// ====== Webhook ======
async function handleEvent(event) {
  if (event.type === 'memberJoined' && event.source.type === 'group') {
    for (const m of (event.joined && event.joined.members) || []) {
      rememberMember(event.source.groupId, m.userId);
    }
    return;
  }

  if (event.type !== 'message' || event.message.type !== 'text') return;

  const { source, message } = event;
  if (source.type === 'group') rememberMember(source.groupId, source.userId);

  if (await handleCommand(event)) return;

  if (source.type !== 'group') return;
  const mentionees = message.mention && message.mention.mentionees;
  if (!mentionees || mentionees.length === 0) return;

  const senderName = await getSenderName(source);
  const groupName = await getGroupName(source.groupId);
  const time = nowTaipeiString();
  const ts = Date.now();

  const hasAll = mentionees.some((m) => m.type === 'all' || !m.userId);

  const personalIds = new Set();
  for (const m of mentionees) {
    if (!m.userId) continue;
    personalIds.add(m.userId);
    rememberMember(source.groupId, m.userId);
    recordMention(m.userId, { groupName, senderName, text: message.text, time, ts, isAll: false });
  }

  if (hasAll) {
    const roster = Object.keys(db.members[source.groupId] || {});
    console.log(`📢 偵測到 @All,已知成員 ${roster.length} 人`);
    for (const uid of roster) {
      if (uid === source.userId) continue;
      if (personalIds.has(uid)) continue;
      recordMention(uid, { groupName, senderName, text: message.text, time, ts, isAll: true });
    }
  }
}

// ====== 啟動 ======
const app = express();

app.get('/', (req, res) => {
  const q = getQuota();
  res.send(`LINE Mention Backup Bot v5.2 is running ✅ (storage: ${USE_CLOUD ? 'cloud' : 'local'}, quota: ${q.used}/${MONTHLY_PUSH_LIMIT})`);
});

app.post('/webhook', line.middleware({ channelSecret: config.channelSecret }), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => { console.error(err); res.status(200).end(); });
});

cron.schedule('* * * * *', flushBuffers, { timezone: TIMEZONE });      // 每分鐘檢查合併緩衝
cron.schedule(DAILY_CRON, sendDailyBackups, { timezone: TIMEZONE });   // 主要彙整
if (EXTRA_CRON) {
  cron.schedule(EXTRA_CRON, sendExtraBackups, { timezone: TIMEZONE }); // 加班場彙整
}

const port = process.env.PORT || 3000;

loadData().then(() => {
  app.listen(port, () => {
    console.log(`🚀 Bot v5.2 已啟動,port ${port}`);
    console.log(`💽 儲存:${USE_CLOUD ? '☁️ JSONBin' : '💾 本機'}`);
    console.log(`📊 每月推播上限:${MONTHLY_PUSH_LIMIT}(保留 ${QUOTA_RESERVE} 則給每日彙整)`);
    console.log(`⏱️ 預設合併間隔:${DEFAULT_BUFFER_MIN} 分鐘`);
    console.log(`⏰ 主要彙整時間:${DAILY_CRON}(${DAILY_TIME_TEXT})`);
    console.log(`⏰ 加班場時間:${EXTRA_CRON || '(未設定)'}${EXTRA_CRON ? `,剩餘額度低於 ${EXTRA_MIN_REMAINING} 則時自動停辦` : ''}`);
  });
});
