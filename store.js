// Upstash Redis(無料の外部データ保存サービス)を使った永続化。
// Renderは再デプロイのたびにサーバーの中身が作り直されるため、
// ローカルファイルに保存する方式だと情報が消えてしまう。それを防ぐための実装。
const axios = require('axios');

const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
const KEY = 'slack-status-signal:data';

const DEFAULT_DATA = {
  botToken: null,
  enabled: true,
  allowList: [],
  users: {},
  holidays: null,      // 祝日APIが落ちたときのフォールバック用キャッシュ
  holidaysDate: null,  // 上記を取得したJST日付
  lastSent: {},        // 二重送信防止マーカー { 'YYYY-MM-DD:morning': true }
};

function isConfigured() {
  return Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
}

async function redisCommand(command) {
  if (!isConfigured()) {
    throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が設定されていません');
  }
  const { data } = await axios.post(UPSTASH_REDIS_REST_URL, command, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    timeout: 10000, // 応答が返らないまま処理が止まるのを防ぐ
  });
  return data.result;
}

// データ全体を読み書きする方式なので、同時アクセスで上書きが起きないよう
// 「読み込み→変更→保存」を1件ずつ順番に実行する(同一プロセス内の直列化)。
let lock = Promise.resolve();
function withLock(fn) {
  const result = lock.then(fn, fn);
  lock = result.then(
    () => {},
    () => {}
  );
  return result;
}

async function load() {
  const raw = await redisCommand(['GET', KEY]);
  if (!raw) return { ...DEFAULT_DATA };
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (typeof data.enabled !== 'boolean') data.enabled = true;
  if (!Array.isArray(data.allowList)) data.allowList = [];
  if (!data.users) data.users = {};
  if (!data.lastSent) data.lastSent = {};
  return data;
}

async function save(data) {
  await redisCommand(['SET', KEY, JSON.stringify(data)]);
}

function update(mutator) {
  return withLock(async () => {
    const data = await load();
    const result = await mutator(data);
    await save(data);
    return result;
  });
}

async function setBotToken(token) {
  await update((data) => {
    data.botToken = token;
  });
}

async function getBotToken() {
  const data = await load();
  return data.botToken;
}

async function setEnabled(enabled) {
  await update((data) => {
    data.enabled = enabled;
  });
}

async function getEnabled() {
  const data = await load();
  return data.enabled;
}

async function getAllowList() {
  const data = await load();
  return data.allowList;
}

async function seedAllowListIfEmpty(emails) {
  return update((data) => {
    if (data.allowList.length === 0 && emails.length > 0) {
      data.allowList = emails;
      return true;
    }
    return false;
  });
}

async function addAllowedEmail(email) {
  const normalized = email.trim().toLowerCase();
  await update((data) => {
    if (!data.allowList.includes(normalized)) data.allowList.push(normalized);
  });
  return normalized;
}

// 許可リストから外すだけでなく、登録済みユーザー(=DM送信対象・トークン保持者)も一緒に削除する。
// 以前は許可リストからしか消えず、削除したはずの人にDMが届き続けていた。
async function removeAllowedEmail(email) {
  const normalized = email.trim().toLowerCase();
  return update((data) => {
    data.allowList = data.allowList.filter((e) => e !== normalized);
    const removedUserIds = [];
    for (const [id, user] of Object.entries(data.users)) {
      if ((user.email || '').toLowerCase() === normalized) {
        delete data.users[id];
        removedUserIds.push(id);
      }
    }
    return { email: normalized, removedUserIds };
  });
}

async function removeUser(userId) {
  return update((data) => {
    const existed = Boolean(data.users[userId]);
    delete data.users[userId];
    return existed;
  });
}

async function upsertUser(userId, info) {
  await update((data) => {
    data.users[userId] = { ...(data.users[userId] || {}), ...info };
  });
}

async function getUser(userId) {
  const data = await load();
  return data.users[userId];
}

async function getAllUsers() {
  const data = await load();
  return Object.entries(data.users).map(([id, v]) => ({ id, ...v }));
}

// 祝日データのフォールバックキャッシュ(APIが一時的に落ちても判定できるように保存しておく)
async function setHolidays(map, dateStr) {
  await update((data) => {
    data.holidays = map;
    data.holidaysDate = dateStr;
  });
}

async function getHolidays() {
  const data = await load();
  return data.holidays;
}

// 二重送信防止: 同じ日・同じ時間帯のDMを一度だけ送るためのマーカー。
// claimSend は「まだ送っていなければ予約して true」を返す(cronの再試行対策)。
async function claimSend(key) {
  return update((data) => {
    if (data.lastSent[key]) return false;
    const today = key.split(':')[0];
    // 当日分以外の古いマーカーは掃除する
    for (const k of Object.keys(data.lastSent)) {
      if (!k.startsWith(today)) delete data.lastSent[k];
    }
    data.lastSent[key] = new Date().toISOString();
    return true;
  });
}

async function releaseSend(key) {
  await update((data) => {
    delete data.lastSent[key];
  });
}

async function getSentMarkers() {
  const data = await load();
  return data.lastSent;
}

module.exports = {
  isConfigured,
  setBotToken,
  getBotToken,
  setEnabled,
  getEnabled,
  getAllowList,
  seedAllowListIfEmpty,
  addAllowedEmail,
  removeAllowedEmail,
  removeUser,
  upsertUser,
  getUser,
  getAllUsers,
  setHolidays,
  getHolidays,
  claimSend,
  releaseSend,
  getSentMarkers,
};
