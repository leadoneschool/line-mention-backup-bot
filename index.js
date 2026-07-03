/**
 * LINE 群組「被 Tag 訊息」備份 Bot v2
 * ------------------------------------------------
 * 功能:
 * 1. Bot 加入群組後,即時監聽所有文字訊息
 * 2. 訊息中有 @某人(mention)就記錄
 * 3. 每個人可自選備份模式:
 *    - 每日模式(預設):每天 23:55 一次寄出當天所有被 tag 的訊息
 *    - 即時模式:一被 tag 馬上私訊轉傳
 *
 * 使用者指令(在「和 Bot 的一對一聊天室」輸入):
 *    !即時   → 切換成即時轉傳
 *    !每日   → 切換成每日彙整
 *    !設定   → 查看目前模式
 *    !測試 xxx → 模擬「自己被 tag」,方便一個人測試
 *    !備份   → 立刻寄出目前累積的每日備份(測試用)
 *
 * 注意(LINE 官方限制):
 * - 被 tag 的人必須先加 Bot 好友,Bot 才能私訊他
 * - @All 不會被記錄(LINE 不提供全體成員名單給一般 Bot)
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

// 每天幾點寄送備份(台灣時間),預設 23:55
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
    return d;
  } catch (e) {
    return {
      mentions: {}, // { userId: [ {groupName, senderName, text, time} ] }
      settings: {}, // { userId: 'instant' | 'daily' }
    };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();

function getUserMode(userId) {
  return db.settings[userId] === 'instant' ? 'instant' : 'daily'; // 預設每日
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
        text: `${r.senderName}　${r.time}`,
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
        backgroundColor: '#8CABD9', // 仿 LINE 聊天室背景色
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
  return buildFlex('🔔 你剛剛被 Tag 了', '即時備份如下', [record]);
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

  db.mentions = {}; // 寄完清空當天資料(設定保留)
  saveData(db);
}

// 記錄或即時轉傳一筆被 tag 的訊息
async function handleMentionRecord(userId, record) {
  if (getUserMode(userId) === 'instant') {
    await pushToUser(userId, buildInstantFlex(record));
    console.log(`⚡ 已即時轉傳給 ${userId}`);
  } else {
    if (!db.mentions[userId]) db.mentions[userId] = [];
    db.mentions[userId].push(record);
    saveData(db);
    console.log(`📝 已記錄一則(每日模式)給 ${userId}`);
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
  // 全形驚嘆號轉半形,方便比對
  return text.replace(/！/g, '!').trim();
}

async function handleCommand(event) {
  const { source, message, replyToken } = event;
  const cmd = normalizeCmd(message.text);
  const userId = source.userId;

  if (cmd === '!即時') {
    db.settings[userId] = 'instant';
    saveData(db);
    await replyText(replyToken, '⚡ 已切換為【即時模式】\n之後你在群組被 tag,會馬上收到備份卡片。\n\n輸入 !每日 可切換回每日彙整。');
    return true;
  }

  if (cmd === '!每日') {
    db.settings[userId] = 'daily';
    saveData(db);
    await replyText(replyToken, '📋 已切換為【每日模式】\n每天 23:55 會把你當天被 tag 的訊息一次寄給你。\n\n輸入 !即時 可切換成即時轉傳。');
    return true;
  }

  if (cmd === '!設定') {
    const mode = getUserMode(userId) === 'instant' ? '⚡ 即時模式' : '📋 每日模式(預設)';
    const pending = (db.mentions[userId] || []).length;
    await replyText(replyToken, `你目前的備份模式:${mode}\n今日已累積待寄:${pending} 則\n\n可用指令:\n!即時 → 被 tag 馬上轉傳\n!每日 → 每天彙整一次\n!測試 內容 → 模擬被 tag\n!備份 → 立刻寄出累積的備份`);
    return true;
  }

  if (cmd === '!備份') {
    await sendDailyBackups();
    return true;
  }

  if (cmd.startsWith('!測試')) {
    const senderName = await getSenderName(source);
    const groupName = source.type === 'group' ? await getGroupName(source.groupId) : '(一對一測試)';
    const record = { groupName, senderName, text: message.text, time: nowTaipeiString() };
    await handleMentionRecord(userId, record);
    if (getUserMode(userId) === 'daily') {
      await replyText(replyToken, '✅ 已記錄(每日模式)。輸入 !備份 可立刻收到卡片,或等每晚自動寄送。');
    }
    return true;
  }

  return false;
}

// ====== Webhook 處理 ======
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  // 先看是不是指令
  const isCmd = await handleCommand(event);
  if (isCmd) return;

  const { source, message } = event;

  // 只處理群組訊息、且有 @mention 的訊息
  if (source.type !== 'group') return;
  const mentionees = message.mention && message.mention.mentionees;
  if (!mentionees || mentionees.length === 0) return;

  const senderName = await getSenderName(source);
  const groupName = await getGroupName(source.groupId);
  const time = nowTaipeiString();

  for (const m of mentionees) {
    // @All 沒有 userId,略過
    if (!m.userId) continue;
    await handleMentionRecord(m.userId, {
      groupName,
      senderName,
      text: message.text,
      time,
    });
  }
}

// ====== 啟動伺服器 ======
const app = express();

app.get('/', (req, res) => res.send('LINE Mention Backup Bot v2 is running ✅'));

app.post('/webhook', line.middleware({ channelSecret: config.channelSecret }), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error(err);
      res.status(200).end(); // 回 200 避免 LINE 重送
    });
});

// 每天定時寄送(每日模式的使用者)
cron.schedule(DAILY_CRON, sendDailyBackups, { timezone: TIMEZONE });

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Bot v2 已啟動,port ${port}`);
  console.log(`⏰ 每日備份時間(台灣時間):${DAILY_CRON}`);
});
