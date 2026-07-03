/**
 * LINE 群組「被 Tag 訊息」備份 Bot v3
 * ------------------------------------------------
 * 功能:
 * 1. Bot 加入群組後,即時監聽所有文字訊息
 * 2. 訊息中有 @某人(mention)就記錄/轉傳給那個人
 * 3. 訊息中有 @All 時,轉傳給「Bot 認識的群組成員」
 *    (= 曾在群組發過言、被 tag 過的人;純潛水者 Bot 不認識,收不到)
 * 4. 每個人可自選備份模式與 @All 開關
 *
 * 使用者指令(建議在「和 Bot 的一對一聊天室」輸入):
 *    !即時    → 被 tag 馬上轉傳
 *    !每日    → 每天 23:55 彙整一次(預設)
 *    !全體開  → 接收 @All 的備份(預設)
 *    !全體關  → 不接收 @All 的備份
 *    !設定    → 查看目前設定
 *    !測試 xxx → 模擬「自己被 tag」
 *    !備份    → 立刻寄出累積的每日備份
 *
 * 注意(LINE 官方限制):
 * - 被 tag 的人必須先加 Bot 好友,Bot 才能私訊他
 * - @All 只能傳給「Bot 見過的成員」,無法涵蓋從未發言的潛水者
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

const DAILY_CRON = process.env.DAILY_CRON || '55 23 * * *';
const TIMEZONE = 'Asia/Taipei';

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ====== 簡易資料儲存(JSON 檔)======
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!d.mentions) d.mentions = {};
    if (!d.settings) d.settings = {};
    if (!d.members) d.members = {};
    return d;
  } catch (e) {
    return {
      mentions: {}, // { userId: [ {groupName, senderName, text, time, isAll} ] }
      settings: {}, // { userId: { mode: 'instant'|'daily', all: true|false } }
      members: {},  // { groupId: { userId: true } }  已知成員名單
    };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();

function getUserSetting(userId) {
  const s = db.settings[userId] || {};
  return {
    mode: s.mode === 'instant' ? 'instant' : 'daily', // 預設每日
    all: s.all !== false, // 預設接收 @All
  };
}

function setUserSetting(userId, patch) {
  db.settings[userId] = { ...(db.settings[userId] || {}), ...patch };
  saveData(db);
}

// 記住群組成員(Bot 看過誰,誰就在名單上)
function rememberMember(groupId, userId) {
  if (!groupId || !userId) return;
  if (!db.members[groupId]) db.members[groupId] = {};
  if (!db.members[groupId][userId]) {
    db.members[groupId][userId] = true;
    saveData(db);
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

// ====== 產生「聊天截圖樣式」的 Flex Message ======
function recordBubbleBox(r) {
  const contents = [
    {
      type: 'text',
      text: `${r.senderName}　${r.time}${r.isAll ? '　📢@全體' : ''}`,
      size: 'xs',
      color: '#888888',
    },
    {
      type: 'text',
      text: r.text,
      size: 'sm',
      color: '#111111',
      wrap: true,
      margin: 'sm',
    },
    {
      type: 'text',
      text: `📌 來自:${r.groupName}`,
      size: 'xxs',
      color: '#AAAAAA',
      margin: 'sm',
    },
  ];
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#FFFFFF',
    cornerRadius: '12px',
    paddingAll: '10px',
    margin: 'md',
    contents,
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

  db.mentions = {}; // 寄完清空(設定與成員名單保留)
  saveData(db);
}

// 記錄或即時轉傳一筆
async function handleMentionRecord(userId, record) {
  const s = getUserSetting(userId);
  if (record.isAll && !s.all) return; // 這個人關掉了 @All 接收

  if (s.mode === 'instant') {
    await pushToUser(userId, buildInstantFlex(record));
    console.log(`⚡ 已即時轉傳給 ${userId}${record.isAll ? '(@All)' : ''}`);
  } else {
    if (!db.mentions[userId]) db.mentions[userId] = [];
    db.mentions[userId].push(record);
    saveData(db);
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
    await replyText(
      replyToken,
      `你目前的設定:\n備份模式:${mode}\n@All 備份:${allState}\n今日已累積待寄:${pending} 則\n\n可用指令:\n!即時 / !每日 → 切換備份模式\n!全體開 / !全體關 → @All 備份開關\n!測試 內容 → 模擬被 tag\n!備份 → 立刻寄出累積的備份`
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
  // 有人加入群組時,順手記進成員名單
  if (event.type === 'memberJoined' && event.source.type === 'group') {
    for (const m of (event.joined && event.joined.members) || []) {
      rememberMember(event.source.groupId, m.userId);
    }
    return;
  }

  if (event.type !== 'message' || event.message.type !== 'text') return;

  const { source, message } = event;

  // 群組裡任何發言者都記進成員名單
  if (source.type === 'group') rememberMember(source.groupId, source.userId);

  // 先看是不是指令
  const isCmd = await handleCommand(event);
  if (isCmd) return;

  // 只處理群組訊息、且有 @mention 的訊息
  if (source.type !== 'group') return;
  const mentionees = message.mention && message.mention.mentionees;
  if (!mentionees || mentionees.length === 0) return;

  const senderName = await getSenderName(source);
  const groupName = await getGroupName(source.groupId);
  const time = nowTaipeiString();

  // 判斷這則訊息是否包含 @All
  const hasAll = mentionees.some((m) => m.type === 'all' || !m.userId);

  // 1) 先處理點名個人的部分
  const personalIds = new Set();
  for (const m of mentionees) {
    if (!m.userId) continue;
    personalIds.add(m.userId);
    rememberMember(source.groupId, m.userId); // 被 tag 過的人也記進名單
    await handleMentionRecord(m.userId, {
      groupName,
      senderName,
      text: message.text,
      time,
      isAll: false,
    });
  }

  // 2) 再處理 @All:傳給名單上所有人(排除發話者、排除已被點名的人)
  if (hasAll) {
    const roster = Object.keys(db.members[source.groupId] || {});
    console.log(`📢 偵測到 @All,已知成員 ${roster.length} 人`);
    for (const uid of roster) {
      if (uid === source.userId) continue; // 發話者自己不用備份
      if (personalIds.has(uid)) continue; // 已個別點名的不重複寄
      await handleMentionRecord(uid, {
        groupName,
        senderName,
        text: message.text,
        time,
        isAll: true,
      });
    }
  }
}

// ====== 啟動伺服器 ======
const app = express();

app.get('/', (req, res) => res.send('LINE Mention Backup Bot v3 is running ✅'));

app.post('/webhook', line.middleware({ channelSecret: config.channelSecret }), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error(err);
      res.status(200).end(); // 回 200 避免 LINE 重送
    });
});

cron.schedule(DAILY_CRON, sendDailyBackups, { timezone: TIMEZONE });

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Bot v3 已啟動,port ${port}`);
  console.log(`⏰ 每日備份時間(台灣時間):${DAILY_CRON}`);
});
