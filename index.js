/**
 * LINE 群組「被 Tag 訊息」每日備份 Bot
 * ------------------------------------------------
 * 功能：
 * 1. Bot 加入群組後，即時監聽所有文字訊息
 * 2. 只要訊息中有 @某人（LINE 的 mention），就把該訊息記錄下來
 * 3. 每天 23:55（台灣時間）自動把當天所有「你被 tag 的訊息」
 *    整理成「聊天截圖樣式」的卡片（Flex Message），
 *    私訊傳到被 tag 者自己的一對一聊天室當備份
 *
 * 注意（LINE 官方限制，無法繞過）：
 * - Bot 無法真的「截圖」畫面，所以用 Flex Message 畫出對話泡泡，效果等同截圖
 * - Bot 無法幫使用者按「分享」，所以改由 Bot 直接推播私訊
 * - 被 tag 的人「必須先加 Bot 為好友」，Bot 才能私訊他
 */

'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ====== 設定（從環境變數讀取）======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('❌ 請先設定環境變數 LINE_CHANNEL_ACCESS_TOKEN 和 LINE_CHANNEL_SECRET');
  process.exit(1);
}

// 每天幾點寄送備份（台灣時間），預設 23:55
const DAILY_CRON = process.env.DAILY_CRON || '55 23 * * *';
const TIMEZONE = 'Asia/Taipei';

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ====== 簡易資料儲存（JSON 檔，重開機不會遺失）======
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { mentions: {} }; // { userId: [ {groupName, senderName, text, time} ] }
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();

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
    return '（未知成員）';
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
function buildBackupFlex(records) {
  // 一則泡泡最多放 15 筆，太多會超過 LINE 限制
  const items = records.slice(0, 15).map((r) => ({
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
        text: `📌 來自：${r.groupName}`,
        size: 'xxs',
        color: '#AAAAAA',
        margin: 'sm',
      },
    ],
  }));

  return {
    type: 'flex',
    altText: `📋 今日被 Tag 訊息備份（${records.length} 則）`,
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#8CABD9', // 仿 LINE 聊天室背景色
        paddingAll: '14px',
        contents: [
          {
            type: 'text',
            text: `📋 ${todayTaipeiDate()} 被 Tag 訊息備份`,
            weight: 'bold',
            size: 'md',
            color: '#FFFFFF',
          },
          {
            type: 'text',
            text: `共 ${records.length} 則${records.length > 15 ? '（僅顯示前 15 則）' : ''}`,
            size: 'xs',
            color: '#EEF3FA',
            margin: 'sm',
          },
          ...items,
        ],
      },
    },
  };
}

// ====== 每日寄送備份 ======
async function sendDailyBackups() {
  const userIds = Object.keys(db.mentions);
  console.log(`⏰ 開始寄送每日備份，共 ${userIds.length} 位使用者`);

  for (const userId of userIds) {
    const records = db.mentions[userId];
    if (!records || records.length === 0) continue;

    try {
      await client.pushMessage({
        to: userId,
        messages: [buildBackupFlex(records)],
      });
      console.log(`✅ 已寄給 ${userId}（${records.length} 則）`);
    } catch (e) {
      // 最常見原因：對方沒有加 Bot 好友，無法私訊
      console.error(`⚠️ 無法寄給 ${userId}：${e.message}（他可能還沒加 Bot 好友）`);
    }
  }

  // 寄完清空當天資料
  db = { mentions: {} };
  saveData(db);
}

// ====== Webhook 處理 ======
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const { source, message } = event;
  const text = message.text.trim();

  // 測試指令：在群組輸入 !備份 可立刻手動寄送（方便測試）
  if (text === '!備份' || text === '！備份') {
    await sendDailyBackups();
    return;
  }

  // 只處理群組訊息、且有 @mention 的訊息
  if (source.type !== 'group') return;
  const mentionees = message.mention && message.mention.mentionees;
  if (!mentionees || mentionees.length === 0) return;

  const senderName = await getSenderName(source);
  const groupName = await getGroupName(source.groupId);
  const time = nowTaipeiString();

  for (const m of mentionees) {
    // @All 沒有 userId，略過
    if (!m.userId) continue;

    if (!db.mentions[m.userId]) db.mentions[m.userId] = [];
    db.mentions[m.userId].push({
      groupName,
      senderName,
      text: message.text,
      time,
    });
  }
  saveData(db);
  console.log(`📝 已記錄一則被 tag 訊息（tag 了 ${mentionees.length} 人）`);
}

// ====== 啟動伺服器 ======
const app = express();

app.get('/', (req, res) => res.send('LINE Mention Backup Bot is running ✅'));

app.post('/webhook', line.middleware({ channelSecret: config.channelSecret }), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error(err);
      res.status(200).end(); // 回 200 避免 LINE 重送
    });
});

// 每天定時寄送
cron.schedule(DAILY_CRON, sendDailyBackups, { timezone: TIMEZONE });

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Bot 已啟動，port ${port}`);
  console.log(`⏰ 每日備份時間（台灣時間）：${DAILY_CRON}`);
});
