// Upstash Redis(無料の外部データ保存サービス)を使った永続化。
// Renderは再デプロイのたびにサーバーの中身が作り直されるため、
// ローカルファイルに保存する方式だと情報が消えてしまう。それを防ぐための実装。
const axios = require('axios');

const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
const KEY = 'slack-status-signal:data';

const DEFAULT_DATA = { botToken: null, enabled: true, allowList: [], users: {} };

async function redisCommand(command) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が設定されていません');
  }
  const { data } = await axios.post(UPSTASH_REDIS_REST_URL, command, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
  });
  return data.result;
}

async function load() {
  const raw = await redisCommand(['GET', KEY]);
  if (!raw) return { ...DEFAULT_DATA };
  const data = JSON.parse(raw);
  if (typeof data.enabled !== 'boolean') data.enabled = true;
  if (!Array.isArray(data.allowList)) data.allowList = [];
  if (!data.users) data.users = {};
  return data;
}

async function save(data) {
  await redisCommand(['SET', KEY, JSON.stringify(data)]);
}

async function setBotToken(token) {
  const data = await load();
  data.botToken = token;
  await save(data);
}

async function getBotToken() {
  const data = await load();
  return data.botToken;
}

async function setEnabled(enabled) {
  const data = await load();
  data.enabled = enabled;
  await save(data);
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
  const data = await load();
  if (data.allowList.length === 0 && emails.length > 0) {
    data.allowList = emails;
    await save(data);
  }
}

async function addAllowedEmail(email) {
  const normalized = email.trim().toLowerCase();
  const data = await load();
  if (!data.allowList.includes(normalized)) {
    data.allowList.push(normalized);
    await save(data);
  }
  return normalized;
}

async function removeAllowedEmail(email) {
  const normalized = email.trim().toLowerCase();
  const data = await load();
  data.allowList = data.allowList.filter((e) => e !== normalized);
  await save(data);
}

async function upsertUser(userId, info) {
  const data = await load();
  data.users[userId] = { ...(data.users[userId] || {}), ...info };
  await save(data);
}

async function getUser(userId) {
  const data = await load();
  return data.users[userId];
}

async function getAllUsers() {
  const data = await load();
  return Object.entries(data.users).map(([id, v]) => ({ id, ...v }));
}

module.exports = {
  setBotToken,
  getBotToken,
  setEnabled,
  getEnabled,
  getAllowList,
  seedAllowListIfEmpty,
  addAllowedEmail,
  removeAllowedEmail,
  upsertUser,
  getUser,
  getAllUsers,
};
