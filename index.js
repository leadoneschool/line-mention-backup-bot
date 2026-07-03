/**
 * LINE 群組「被 Tag 訊息」備份 Bot v4
 * ------------------------------------------------
 * v4 重點更新:
 * ★ 資料改存雲端(JSONBin.io),Render 重啟/睡醒/重新部署都不會遺失
 *   → 個人設定(即時/每日、@All開關)、群組成員名單、當日累積 通通保得住
 * ★ 未設定 JSONBin 時自動退回本機檔案模式(功能照舊,但重啟會遺失)
 *
 * 需要的環境變數:
 *   LINE_CHANNEL_ACCESS_TOKEN  (必填)
 *   LINE_CHANNEL_SECRET        (必填)
 *   JSONBIN_BIN_ID             (建議,雲端儲存用)
 *   JSONBIN_API_KEY            (建議,雲端儲存用,JSONBin 的 X-Master-Key)
 *   DAILY_CRON                 (選填,預設 55 23 * * *)
 *
 * 使用者指令:
 *    !即時 / !每日      → 切換備份模式(預設每日)
 *    !全體開 / !全體關   → @All 備份開關(預設開)
 *    !設定              → 查看目前設定
 *    !測試 xxx          → 模擬「自己被 tag」
 *    !備份              → 立刻寄出累積的每日備份
 *
 * 注意(LINE 官方限制):
 * - 收備份的人必須先加 Bot 好友
 * - @All 只會傳給「Bot 見過的成員」;發話者本人不會收到自己發的 @All
 */

'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ====== 設定(從環境變數讀取)======
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

const DAILY_CRON = process.env.DAILY_CRON || '55 23 * * *';
const TIMEZONE = 'Asia/Taipei';

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ====== 資料儲存(雲端 JSONBin,或本機檔案備援)======
const DATA_FILE = path.join(__dirname, 'data.json');

function emptyDb() {
  return {
    mentions: {}, // { userId: [ {groupName, senderName, text, time, isAll} ] }
    settings: {}, // { userId: { mode: 'instant'|'daily', all: true|false } }
    members: {},  // { groupId: { userId: true } }
  };
}

let db = emptyDb();

async function loadData() {
  if (USE_CLOUD) {
    try {
      const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: { 'X-Master-Key': JSONBIN_API_KEY },
      });
      if (!res.ok) throw new Error(`JSONBin 讀取失敗:HTTP ${res.status}`);
      const json = await res.json();
      const d = json.record || {};
      db = { ...emptyDb(), ...d };
      console.log('☁️ 已從 JSONBin 載入雲端資料');
      return;
    } catch (e) {
      console.error(`⚠️ 雲端載入失敗,改用空資料啟動:${e.message}`);
      db = emptyDb();
      return;
    }
  }
  // 本機備援模式
  try {
    db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
    console.log('💾 已從本機檔案載入資料(注意:Render 重啟會遺失)');
  } catch (e) {
    db = emptyDb();
  }
}

// 存檔:雲端模式用「防抖」— 資料變動後 5 秒才真正上傳一次,
// 避免群組訊息一多就狂打 JSONBin 浪費免費額度
let saveTimer = null;
let saving = false;
let dirtyAgain = false;

async function uploadToCloud() {
  if (saving) { dirtyAgain = true; return; }
  saving = true;
  try {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_API_KEY,
      },
      body: JSON.stringify(db),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('☁️ 已存檔到 JSONBin');
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

function saveData() {
  scheduleSave();
}

// ====== 使用者設定 ======
function getUserSetting(userId) {
  const s = db.settings[userId] || {};
  return {
    mode: s.mode === 'instant' ? 'instant' : 'daily',
    all: s.all !== false,
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

// ====== 小工具 ======
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

function nowTaipeiString() {
  return new Date().toLocaleString('zh-TW', {
    timeZone: TIMEZONE,
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function todayTaipeiDate() {
  return new Date().toLocaleDateString('zh-TW', { timeZone: TIMEZONE });
}

// ====== Flex Message(聊天截圖樣式)======
function recordBubbleBox(r) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#FFFFFF',
    cornerRadius: '12px',
    paddingAll: '10px',
    margin: 'md',
    contents: [
      {
        type: 'text',
        text: `${r.senderName}　${r.time}${r.isAll ? '　📢@全體' : ''}`,
        size: 'xs',
        color: '#888888',
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
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#8CABD9',
        paddingAll: '14px',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'md', color: '#FFFFFF' },
          { type: 'text', text: subtitle, size: 'xs', color: '#EEF3FA', margin: 'sm' },
          ...items,
        ],
      },
    },
  };
}

function buildDailyFlex(records) {
  const sub = `共 ${records.length} 則${records.length > 15 ? '(僅顯示前 15 則)' : ''}`;
  return buildFlex(`📋 ${todayTaipeiDate()} 被 Tag 訊息備份`, sub, records);
}

function buildInstantFlex(record) {
  const title = record.isAll ? '📢 群組發布了 @全體訊息' : '🔔 你剛剛被 Tag 了';
  return buildFlex(title, '即時備份如下', [record]);
}

// ====== 寄送 ======
async function pushToUser(userId, flexMessage) {
  try {
    await client.pushMessage({ to: userId, messages: [flexMessage] });
    return true;
  } catch (e) {
    console.error(`⚠️ 無法私訊 ${userId}:${e.message}(他可能還沒加 Bot 好友)`);
    return false;
  }
}

async function sendDailyBackups() {
  const userIds = Object.keys(db.mentions);
  console.log(`⏰ 開始寄送每日備份,共 ${userIds.length} 位使用者`);
  for (const userId of userIds) {
    const records = db.mentions[userId];
    if (!records || records.length === 0) continue;
    const ok = await pushToUser(userId, buildDailyFlex(records));
    if (ok) console.log(`✅ 已寄給 ${userId}(${records.length} 則)`);
  }
  db.mentions = {};
  saveData();
}

async function handleMentionRecord(userId, record) {
  const s = getUserSetting(userId);
  if (record.isAll && !s.all) return;

  if (s.mode === 'instant') {
    await pushToUser(userId, buildInstantFlex(record));
    console.log(`⚡ 已即時轉傳給 ${userId}${record.isAll ? '(@All)' : ''}`);
  } else {
    if (!db.mentions[userId]) db.mentions[userId] = [];
    db.mentions[userId].push(record);
    saveData();
    console.log(`📝 已記錄一則(每日模式)給 ${userId}${record.isAll ? '(@All)' : ''}`);
  }
}

// ====== 使用者指令 ======
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

  if (cmd === '!即時') {
    setUserSetting(userId, { mode: 'instant' });
    await replyText(replyToken, '⚡ 已切換為【即時模式】\n之後被 tag 會馬上收到備份卡片。\n\n輸入 !每日 可切回每日彙整。');
    return true;
  }

  if (cmd === '!每日') {
    setUserSetting(userId, { mode: 'daily' });
    await replyText(replyToken, '📋 已切換為【每日模式】\n每天 23:55 一次寄出當天備份。\n\n輸入 !即時 可切成即時轉傳。');
    return true;
  }

  if (cmd === '!全體開') {
    setUserSetting(userId, { all: true });
    await replyText(replyToken, '📢 已開啟【@All 備份】\n群組有 @全體訊息時你也會收到備份。');
    return true;
  }

  if (cmd === '!全體關') {
    setUserSetting(userId, { all: false });
    await replyText(replyToken, '🔕 已關閉【@All 備份】\n只有點名你個人的訊息才會備份給你。');
    return true;
  }

  if (cmd === '!設定') {
    const s = getUserSetting(userId);
    const mode = s.mode === 'instant' ? '⚡ 即時模式' : '📋 每日模式(預設)';
    const allState = s.all ? '📢 開啟(預設)' : '🔕 關閉';
    const pending = (db.mentions[userId] || []).length;
    const storage = USE_CLOUD ? '☁️ 雲端(重啟不遺失)' : '💾 本機(重啟會遺失)';
    await replyText(
      replyToken,
      `你目前的設定:\n備份模式:${mode}\n@All 備份:${allState}\n今日已累積待寄:${pending} 則\n資料儲存:${storage}\n\n可用指令:\n!即時 / !每日 → 切換備份模式\n!全體開 / !全體關 → @All 備份開關\n!測試 內容 → 模擬被 tag\n!備份 → 立刻寄出累積的備份`
    );
    return true;
  }

  if (cmd === '!備份') {
    await sendDailyBackups();
    return true;
  }

  if (cmd.startsWith('!測試')) {
    const senderName = await getSenderName(source);
    const groupName = source.type === 'group' ? await getGroupName(source.groupId) : '(一對一測試)';
    const record = { groupName, senderName, text: message.text, time: nowTaipeiString(), isAll: false };
    await handleMentionRecord(userId, record);
    if (getUserSetting(userId).mode === 'daily') {
      await replyText(replyToken, '✅ 已記錄(每日模式)。輸入 !備份 可立刻收到卡片。');
    }
    return true;
  }

  return false;
}

// ====== Webhook 處理 ======
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

  const isCmd = await handleCommand(event);
  if (isCmd) return;

  if (source.type !== 'group') return;
  const mentionees = message.mention && message.mention.mentionees;
  if (!mentionees || mentionees.length === 0) return;

  const senderName = await getSenderName(source);
  const groupName = await getGroupName(source.groupId);
  const time = nowTaipeiString();

  const hasAll = mentionees.some((m) => m.type === 'all' || !m.userId);

  const personalIds = new Set();
  for (const m of mentionees) {
    if (!m.userId) continue;
    personalIds.add(m.userId);
    rememberMember(source.groupId, m.userId);
    await handleMentionRecord(m.userId, {
      groupName, senderName, text: message.text, time, isAll: false,
    });
  }

  if (hasAll) {
    const roster = Object.keys(db.members[source.groupId] || {});
    console.log(`📢 偵測到 @All,已知成員 ${roster.length} 人`);
    for (const uid of roster) {
      if (uid === source.userId) continue;
      if (personalIds.has(uid)) continue;
      await handleMentionRecord(uid, {
        groupName, senderName, text: message.text, time, isAll: true,
      });
    }
  }
}

// ====== 啟動 ======
const app = express();

app.get('/', (req, res) => {
  const storage = USE_CLOUD ? 'cloud' : 'local';
  res.send(`LINE Mention Backup Bot v4 is running ✅ (storage: ${storage})`);
});

app.post('/webhook', line.middleware({ channelSecret: config.channelSecret }), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error(err);
      res.status(200).end();
    });
});

cron.schedule(DAILY_CRON, sendDailyBackups, { timezone: TIMEZONE });

const port = process.env.PORT || 3000;

// 先載入雲端資料,再開始接收訊息
loadData().then(() => {
  app.listen(port, () => {
    console.log(`🚀 Bot v4 已啟動,port ${port}`);
    console.log(`💽 資料儲存模式:${USE_CLOUD ? '☁️ JSONBin 雲端' : '💾 本機檔案(未設定 JSONBIN 環境變數)'}`);
    console.log(`⏰ 每日備份時間(台灣時間):${DAILY_CRON}`);
  });
});
