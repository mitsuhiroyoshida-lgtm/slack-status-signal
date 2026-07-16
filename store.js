// 超シンプルなファイルベースの保存先。
// 小規模チーム内利用を想定（永続DBが要る規模になったらSQLite/Postgresに置き換えてください）
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'tokens.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ botToken: null, enabled: true, users: {} }, null, 2));
  }
}

function load() {
  ensureFile();
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (typeof data.enabled !== 'boolean') data.enabled = true; // 古いdataファイルとの互換
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

// user: { userToken, userName }
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
  upsertUser,
  getUser,
  getAllUsers,
};
