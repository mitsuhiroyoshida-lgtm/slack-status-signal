// 超シンプルなファイルベースの保存先。
// 小規模チーム内利用を想定（永続DBが要る規模になったらSQLite/Postgresに置き換えてください）
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'tokens.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ botToken: null, enabled: true, allowList: [], users: {} }, null, 2));
  }
}

function load() {
  ensureFile();
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (typeof data.enabled !== 'boolean') data.enabled = true; // 古いdataファイルとの互換
  if (!Array.isArray(data.allowList)) data.allowList = []; // 古いdataファイルとの互換
  return data;
}

function save(data) {
  ensureFile();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function setBotToken(token) {
  const data = load();
  data.botToken = token;
  save(data);
}

function getBotToken() {
  return load().botToken;
}

// 手動ON/OFF。trueならチェックイン送信対象、falseなら停止中。
function setEnabled(enabled) {
  const data = load();
  data.enabled = enabled;
  save(data);
}

function getEnabled() {
  return load().enabled;
}

// 登録を許可するメールアドレス一覧（小文字で保存）
function getAllowList() {
  return load().allowList;
}

function seedAllowListIfEmpty(emails) {
  const data = load();
  if (data.allowList.length === 0 && emails.length > 0) {
    data.allowList = emails;
    save(data);
  }
}

function addAllowedEmail(email) {
  const normalized = email.trim().toLowerCase();
  const data = load();
  if (!data.allowList.includes(normalized)) {
    data.allowList.push(normalized);
    save(data);
  }
  return normalized;
}

function removeAllowedEmail(email) {
  const normalized = email.trim().toLowerCase();
  const data = load();
  data.allowList = data.allowList.filter((e) => e !== normalized);
  save(data);
}

// user: { userToken, userName, email }
function upsertUser(userId, info) {
  const data = load();
  data.users[userId] = { ...(data.users[userId] || {}), ...info };
  save(data);
}

function getUser(userId) {
  return load().users[userId];
}

function getAllUsers() {
  const data = load();
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
