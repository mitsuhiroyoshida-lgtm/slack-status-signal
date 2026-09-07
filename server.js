require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { WebClient } = require('@slack/web-api');
const cron = require('node-cron');
const store = require('./store');

const {
  SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET,
  SLACK_SIGNING_SECRET,
  BASE_URL,
  TRIGGER_SECRET,
  PORT = 3000,
  ENABLE_INTERNAL_CRON,
  ALLOWED_EMAILS = '',
  ADMIN_EMAILS = '',
  BOT_START_DATE = '',
  BOT_END_DATE = '',
  SKIP_WEEKENDS_AND_HOLIDAYS = 'true',
  HOLIDAY_UNKNOWN_MODE = 'send',
} = process.env;

function parseEmails(value) {
  return value.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

const INITIAL_ALLOW_LIST = parseEmails(ALLOWED_EMAILS);
const ADMIN_LIST = parseEmails(ADMIN_EMAILS);

// 起動時に設定漏れを検知して、はっきりログに出す(以前は最初のリクエストで初めて失敗していた)。
const REQUIRED_ENV = [
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_SIGNING_SECRET',
  'BASE_URL',
  'TRIGGER_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];
const MISSING_ENV = REQUIRED_ENV.filter((key) => !process.env[key]);
if (MISSING_ENV.length > 0) {
  console.error('■ 起動に必要な環境変数が未設定です:', MISSING_ENV.join(', '));
  console.error('  → Renderのenvironment設定を .env.example と見比べて追加してください。');
}
if (TRIGGER_SECRET === 'change-me-to-a-long-random-string') {
  console.warn('■ TRIGGER_SECRET が初期値のままです。長いランダム文字列に変更してください。');
}

// 想定外の例外でプロセスごと落ちないようにする(Redisの一時障害でBotが停止するのを防ぐ)。
process.on('unhandledRejection', (err) => console.error('未処理のPromise rejection:', err));
process.on('uncaughtException', (err) => console.error('未捕捉の例外:', err));

(async () => {
  try {
    await store.seedAllowListIfEmpty(INITIAL_ALLOW_LIST);
  } catch (err) {
    console.error('許可リストの初期化に失敗:', err.message);
  }
})();

const app = express();
// async ルートの例外をExpressのエラーハンドラへ渡す(未処理rejectionでの停止を防ぐ)
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const SIGNALS = {
  blue: { emoji: ':large_blue_circle:', label: '青（順調）', text: '順調に対応中' },
  yellow: { emoji: ':large_yellow_circle:', label: '黄（やや負荷あり）', text: 'やや負荷あり・急ぎは調整希望' },
  red: { emoji: ':red_circle:', label: '赤（高負荷）', text: '高負荷・緊急以外は後ほど対応' },
  clear: { emoji: '', label: '解除（表示なし）', text: '' },
};

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// secretは長さ比較込みの固定時間比較で検証する。
// TRIGGER_SECRET未設定のまま起動した場合、以前は secret を付けずにアクセスすると
// 「undefined === undefined」で管理URLが通ってしまっていた。
function checkSecret(req, res) {
  if (!TRIGGER_SECRET) {
    res.status(500).send('TRIGGER_SECRET が未設定です。サーバーの環境変数を設定してください。');
    return false;
  }
  const given = typeof req.query.secret === 'string' ? req.query.secret : '';
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(TRIGGER_SECRET, 'utf8');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    res.status(403).send('forbidden');
    return false;
  }
  return true;
}

function todayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function isWithinActivePeriod() {
  const today = todayJST();
  if (BOT_START_DATE && today < BOT_START_DATE) return false;
  if (BOT_END_DATE && today > BOT_END_DATE) return false;
  return true;
}

function isWeekendJST() {
  const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const day = jstNow.getDay();
  return day === 0 || day === 6;
}

let holidaysCache = null;
let holidaysCacheDate = null;

// 祝日APIが落ちているときは、Redisに保存した前回取得分で判定する。
// それも無い場合だけ「判定不能(null)」を返す。
async function getHolidaysMap() {
  const today = todayJST();
  if (holidaysCache && holidaysCacheDate === today) return holidaysCache;
  try {
    const { data } = await axios.get('https://holidays-jp.github.io/api/v1/date.json', { timeout: 5000 });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('想定外のレスポンス形式');
    holidaysCache = data;
    holidaysCacheDate = today;
    store.setHolidays(data, today).catch((err) => console.error('祝日データの保存に失敗:', err.message));
    return data;
  } catch (err) {
    console.error('祝日データ取得失敗:', err.message);
    if (holidaysCache) return holidaysCache;
    try {
      const cached = await store.getHolidays();
      if (cached) {
        console.warn('保存済みの祝日データで判定します。');
        holidaysCache = cached;
        holidaysCacheDate = today;
        return cached;
      }
    } catch (storeErr) {
      console.error('祝日キャッシュの読み込みに失敗:', storeErr.message);
    }
    return null;
  }
}

// true=祝日 / false=平日 / null=判定不能
async function isHolidayTodayJST() {
  const map = await getHolidaysMap();
  if (!map) return null;
  return Boolean(map[todayJST()]);
}

async function evaluateActive() {
  const enabled = await store.getEnabled();
  if (!enabled) return { active: false, reason: '手動OFF中' };
  if (!isWithinActivePeriod()) return { active: false, reason: '起動期間外' };

  if (SKIP_WEEKENDS_AND_HOLIDAYS === 'true') {
    if (isWeekendJST()) return { active: false, reason: '土日' };
    const holiday = await isHolidayTodayJST();
    if (holiday === true) return { active: false, reason: '祝日' };
    if (holiday === null) {
      if (HOLIDAY_UNKNOWN_MODE === 'skip') {
        return { active: false, reason: '祝日判定不能（HOLIDAY_UNKNOWN_MODE=skip のため送信しません）' };
      }
      console.warn('祝日を判定できませんでしたが、HOLIDAY_UNKNOWN_MODE=send のため送信します。');
    }
  }
  return { active: true, reason: '送信可' };
}

function isAdminEmail(email) {
  return Boolean(email) && ADMIN_LIST.includes(String(email).toLowerCase());
}

function adminLinks() {
  return (
    'Bot管理用リンク: ' +
    `<${BASE_URL}/admin/on?secret=${encodeURIComponent(TRIGGER_SECRET || '')}|起動(ON)> ｜ ` +
    `<${BASE_URL}/admin/off?secret=${encodeURIComponent(TRIGGER_SECRET || '')}|停止(OFF)> ｜ ` +
    `<${BASE_URL}/admin/status?secret=${encodeURIComponent(TRIGGER_SECRET || '')}|状態確認> ｜ ` +
    `<${BASE_URL}/admin/members?secret=${encodeURIComponent(TRIGGER_SECRET || '')}|メンバー管理>`
  );
}

async function sendInviteViaSlackDM(email, inviteUrl) {
  const botToken = await store.getBotToken();
  if (!botToken) {
    return { sent: false, reason: 'botトークン未登録です。まず /slack/oauth/start から誰か1人が登録してください。' };
  }
  try {
    const client = new WebClient(botToken);
    const lookup = await client.users.lookupByEmail({ email });
    const userId = lookup.user.id;

    const im = await client.conversations.open({ users: userId });
    await client.chat.postMessage({
      channel: im.channel.id,
      text: '業務負荷シグナルBotへのご招待です。',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              '業務負荷シグナルBotへのご招待です。\n' +
              `以下のリンクを開いて、Slackで「許可する」を押してください。\n<${inviteUrl}|登録リンクを開く>\n\n` +
              '登録すると、平日10時・17時にSlackのDMで負荷状況を聞かれ、選ぶとSlackステータスが自動で切り替わります。',
          },
        },
      ],
    });
    return { sent: true };
  } catch (err) {
    const reason = (err.data && err.data.error) || err.message;
    console.error('招待DM送信失敗:', reason);
    return { sent: false, reason };
  }
}

app.get('/slack/oauth/start', (req, res) => {
  if (!SLACK_CLIENT_ID || !BASE_URL) {
    return res.status(500).send('SLACK_CLIENT_ID / BASE_URL が未設定です。サーバーの環境変数を設定してください。');
  }
  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    scope: 'chat:write,im:write,users:read,users:read.email',
    user_scope: 'users.profile:write',
    redirect_uri: `${BASE_URL}/slack/oauth/callback`,
  });
  res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
});

app.get('/slack/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('code がありません');

  try {
    const { data } = await axios.post(
      'https://slack.com/api/oauth.v2.access',
      new URLSearchParams({
        client_id: SLACK_CLIENT_ID,
        client_secret: SLACK_CLIENT_SECRET,
        code,
        redirect_uri: `${BASE_URL}/slack/oauth/callback`,
      })
    );

    if (!data.ok) {
      console.error(data);
      return res.status(400).send(`Slack認可エラー: ${data.error}`);
    }

    const existingBotToken = await store.getBotToken();
    if (data.access_token && !existingBotToken) {
      await store.setBotToken(data.access_token);
    }

    const userId = data.authed_user && data.authed_user.id;
    const userToken = data.authed_user && data.authed_user.access_token;

    if (!userId || !userToken) {
      return res.status(400).send('ユーザートークンの取得に失敗しました');
    }

    // メールアドレスは許可リストの有無に関わらず取得して保存する
    // (メンバー管理画面の登録状況表示と、削除処理の突合に必要)。
    const botToken = await store.getBotToken();
    let email = null;
    if (botToken) {
      try {
        const botClient = new WebClient(botToken);
        const info = await botClient.users.info({ user: userId });
        email = (info.user && info.user.profile && info.user.profile.email) || null;
      } catch (err) {
        console.error('メールアドレスの取得に失敗:', (err.data && err.data.error) || err.message);
      }
    }

    const allowList = await store.getAllowList();
    if (allowList.length > 0) {
      if (!email || !allowList.includes(email.toLowerCase())) {
        return res
          .status(403)
          .send('<h2>登録できませんでした</h2><p>このBotは指定されたメンバーのみ利用できます。心当たりがない場合は管理者にご確認ください。</p>');
      }
    }

    await store.upsertUser(userId, email ? { email: email.toLowerCase(), userToken } : { userToken });
    return res.send(
      '<h2>登録が完了しました 🎉</h2><p>Botが稼働中の期間、平日の10時・17時にDMが届きます。ボタンを押すとあなたのSlackステータスが自動で切り替わります。このタブは閉じて大丈夫です。</p>'
    );
  } catch (err) {
    console.error(err);
    return res.status(500).send('サーバーエラー');
  }
});

// 許可リストに載っている人だけをDM送信対象にする(削除済みの人に届かないようにする二重の防止)。
async function resolveRecipients() {
  const [users, allowList] = await Promise.all([store.getAllUsers(), store.getAllowList()]);
  const allowSet = new Set(allowList);
  if (allowSet.size === 0) return users;
  return users.filter((user) => {
    const email = (user.email || '').toLowerCase();
    if (!email) {
      console.warn(`メールアドレス未記録のユーザーです。許可リストと突合できないため送信対象に含めます (user=${user.id})`);
      return true;
    }
    return allowSet.has(email);
  });
}

async function sendCheckinToAll(timeLabel, options = {}) {
  const botToken = await store.getBotToken();
  if (!botToken) {
    console.warn('botトークン未登録。誰か1人がまず /slack/oauth/start から登録してください。');
    return { sent: 0, failed: 0, total: 0 };
  }
  const client = new WebClient(botToken);
  const all = await resolveRecipients();
  const users = options.onlyUserIds ? all.filter((u) => options.onlyUserIds.includes(u.id)) : all;

  let sent = 0;
  let failed = 0;
  for (const user of users) {
    try {
      const im = await client.conversations.open({ users: user.id });
      const channelId = im.channel.id;

      const blocks = [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*${timeLabel}の負荷状況チェック*\n今の作業状況を選んでください（ステータスに自動反映されます）` },
        },
        {
          type: 'actions',
          block_id: 'status_signal_actions',
          elements: Object.entries(SIGNALS).map(([key, s]) => ({
            type: 'button',
            text: { type: 'plain_text', text: s.label, emoji: true },
            action_id: `status_${key}`,
            value: key,
          })),
        },
      ];

      // 管理用リンク(TRIGGER_SECRETを含む)は ADMIN_EMAILS に指定した管理者にだけ表示する。
      // 以前は全メンバーのDMに載っていたため、誰でも停止やメンバー削除ができてしまっていた。
      if (isAdminEmail(user.email)) {
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: adminLinks() }] });
      }

      await client.chat.postMessage({
        channel: channelId,
        text: `${timeLabel}の負荷状況チェックです。今の状況を選んでください。`,
        blocks,
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      console.error(`DM送信失敗 (user=${user.id}):`, err.data || err.message);
    }
  }
  console.log(`チェックインDM送信: 成功 ${sent} / 失敗 ${failed}（対象 ${users.length}）`);
  return { sent, failed, total: users.length };
}

// 外部cronがタイムアウト後に再試行しても二重送信にならないよう、
// 「同じ日・同じ時間帯」は1回だけ送る。force=1 で手動再送できる。
async function runCheckin(label, { force = false } = {}) {
  const timeLabel = label === 'evening' ? '17時' : '10時';
  const key = `${todayJST()}:${label}`;
  if (!force) {
    const claimed = await store.claimSend(key);
    if (!claimed) {
      console.log(`二重送信防止: ${key} は既に送信済みのためスキップしました。`);
      return { skipped: true, reason: 'already-sent' };
    }
  }
  try {
    const result = await sendCheckinToAll(timeLabel);
    if (!force && result.total === 0) await store.releaseSend(key);
    return result;
  } catch (err) {
    if (!force) await store.releaseSend(key).catch(() => {});
    throw err;
  }
}

app.get('/trigger', wrap(async (req, res) => {
  if (!checkSecret(req, res)) return;

  try {
    const { active, reason } = await evaluateActive();
    if (!active) {
      console.log(`スキップ: ${reason}`);
      return res.send(`skipped (${reason})`);
    }

    const label = req.query.label === 'evening' ? 'evening' : 'morning';
    const force = req.query.force === '1';
    const result = await runCheckin(label, { force });
    if (result.skipped) return res.send('skipped (already sent for today)');
    return res.send(`ok (sent=${result.sent} failed=${result.failed})`);
  } catch (err) {
    // 外部cronサービスによっては巨大なエラーページを「失敗」として扱ってしまうため、
    // レスポンスは短い文言のみ返し、詳細はRenderのログにだけ出力する。
    console.error('/trigger 処理中にエラー:', err);
    return res.status(500).send('error: trigger failed (see server logs)');
  }
}));

if (ENABLE_INTERNAL_CRON === 'true') {
  const run = async (label) => {
    try {
      const { active, reason } = await evaluateActive();
      if (!active) return console.log(`内蔵cronスキップ: ${reason}`);
      await runCheckin(label);
    } catch (err) {
      console.error('内蔵cronでエラー:', err);
    }
  };
  cron.schedule('0 10 * * *', () => run('morning'), { timezone: 'Asia/Tokyo' });
  cron.schedule('0 17 * * *', () => run('evening'), { timezone: 'Asia/Tokyo' });
  console.log('内蔵cronを有効化しました（10:00 / 17:00 JST）');
}

app.get('/admin/on', wrap(async (req, res) => {
  if (!checkSecret(req, res)) return;
  await store.setEnabled(true);
  res.send('<h2>Botを起動しました ▶️</h2><p>次回の10時/17時のチェックインからDMが届きます（起動期間・土日祝日の設定がある場合はその範囲内に限ります）。</p>');
}));

app.get('/admin/off', wrap(async (req, res) => {
  if (!checkSecret(req, res)) return;
  await store.setEnabled(false);
  res.send('<h2>Botを停止しました ⏸️</h2><p>再開するまでDMは送信されません。</p>');
}));

app.get('/admin/status', wrap(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const enabled = await store.getEnabled();
  const weekend = isWeekendJST();
  const holiday = SKIP_WEEKENDS_AND_HOLIDAYS === 'true' ? await isHolidayTodayJST() : false;
  const { active, reason } = await evaluateActive();
  const recipients = await resolveRecipients();
  const markers = await store.getSentMarkers();
  const holidayText = holiday === null ? '判定不能（祝日データ取得失敗）' : holiday ? 'はい' : 'いいえ';
  const sentToday = Object.keys(markers)
    .filter((k) => k.startsWith(todayJST()))
    .map((k) => k.split(':')[1])
    .join(', ');

  res.send(
    `<h2>現在の状態</h2>` +
      (MISSING_ENV.length > 0 ? `<p style="color:red;">⚠️ 未設定の環境変数: ${escapeHtml(MISSING_ENV.join(', '))}</p>` : '') +
      `<p>手動ON/OFF: ${enabled ? 'ON' : 'OFF'}</p>` +
      `<p>起動期間: ${escapeHtml(BOT_START_DATE || '(指定なし)')} 〜 ${escapeHtml(BOT_END_DATE || '(指定なし)')}</p>` +
      `<p>土日祝スキップ設定: ${SKIP_WEEKENDS_AND_HOLIDAYS === 'true' ? '有効' : '無効'}</p>` +
      `<p>今日(JST): ${todayJST()} / 土日: ${weekend ? 'はい' : 'いいえ'} / 祝日: ${holidayText}</p>` +
      `<p>期間内: ${isWithinActivePeriod() ? 'はい' : 'いいえ'}</p>` +
      `<p>DM送信対象: ${recipients.length}人</p>` +
      `<p>本日すでに送信済み: ${escapeHtml(sentToday || '(なし)')}</p>` +
      `<p>実際に送信されるか: ${active ? '送信される' : `送信されない（${escapeHtml(reason)}）`}</p>` +
      `<p><a href="/admin/test?secret=${encodeURIComponent(TRIGGER_SECRET || '')}">テストDMを自分に送る</a> ｜ ` +
      `<a href="/admin/members?secret=${encodeURIComponent(TRIGGER_SECRET || '')}">メンバー管理</a></p>`
  );
}));

// 設定が正しいかを確認するためのテスト送信。
// 期間・土日祝・二重送信防止を無視して、管理者(ADMIN_EMAILS)だけにDMを送る。
app.get('/admin/test', wrap(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const recipients = await resolveRecipients();
  const targets = ADMIN_LIST.length > 0 ? recipients.filter((u) => isAdminEmail(u.email)) : recipients;
  if (targets.length === 0) {
    return res.send(
      '<h2>テストDMの送信先がいません</h2><p>ADMIN_EMAILS に指定したアドレスの人が、まだBotに登録していない可能性があります（先に登録リンクから許可してください）。</p>'
    );
  }
  const result = await sendCheckinToAll('テスト', { onlyUserIds: targets.map((u) => u.id) });
  res.send(
    `<h2>テストDMを送信しました</h2><p>成功 ${result.sent}件 / 失敗 ${result.failed}件</p>` +
      `<p>失敗した場合はRenderのログにSlackのエラーコードが出ています。</p>`
  );
}));

function renderMembersPage(allowList, users, notice, noticeDetail) {
  const registeredEmails = new Set(users.map((u) => (u.email || '').toLowerCase()));
  const secretParam = encodeURIComponent(TRIGGER_SECRET || '');

  const rows = allowList
    .map((email) => {
      const registered = registeredEmails.has(email);
      const status = registered ? '✅ 登録済み' : '⏳ 招待中（未登録）';
      const removeLink = `/admin/remove-member?secret=${secretParam}&email=${encodeURIComponent(email)}`;
      const resendLink = `/admin/add-member?secret=${secretParam}&email=${encodeURIComponent(email)}`;
      const safeEmail = escapeHtml(email);
      return `<tr><td>${safeEmail}</td><td>${status}</td><td><a href="${escapeHtml(resendLink)}">招待DM再送</a> | <a href="${escapeHtml(removeLink)}" data-email="${safeEmail}" onclick="return confirm(this.dataset.email + ' を削除しますか？')">削除</a></td></tr>`;
    })
    .join('');

  // 許可リストに無いのに登録が残っているユーザー(過去データ等)も見えるようにする
  const orphanRows = users
    .filter((u) => !allowList.includes((u.email || '').toLowerCase()))
    .map((u) => {
      const removeLink = `/admin/remove-user?secret=${secretParam}&userId=${encodeURIComponent(u.id)}`;
      return `<tr><td>${escapeHtml(u.email || '(メール未記録)')}</td><td>⚠️ 許可リスト外だが登録が残っている</td><td><a href="${escapeHtml(removeLink)}">登録を削除</a></td></tr>`;
    })
    .join('');

  const inviteUrl = `${BASE_URL}/slack/oauth/start`;

  let noticeHtml = '';
  if (notice === 'sent') {
    noticeHtml = '<p style="color:green;">✅ Slack DMで招待を送信しました</p>';
  } else if (notice === 'failed') {
    noticeHtml =
      `<p style="color:red;">⚠️ メンバーは追加しましたが、招待DMの送信に失敗しました（${escapeHtml(noticeDetail || '原因不明')}）。上の登録用リンクを直接送ってください。</p>`;
  } else if (notice === 'removed') {
    noticeHtml = `<p style="color:green;">✅ ${escapeHtml(noticeDetail || '')} を許可リストと登録済みメンバーの両方から削除しました（以降DMは届きません）</p>`;
  }

  return `
    <h2>メンバー管理</h2>
    ${noticeHtml}
    <p>ここで許可したメールアドレスの人だけが、下記の登録リンクを使ってBotに登録できます。</p>
    <p>登録用リンク（DM送信に失敗した場合はこちらを直接送ってください）:<br><code>${escapeHtml(inviteUrl)}</code></p>

    <h3>メンバーを追加（追加すると自動でSlack DMが送られます）</h3>
    <form method="GET" action="/admin/add-member">
      <input type="hidden" name="secret" value="${escapeHtml(TRIGGER_SECRET || '')}" />
      <input type="email" name="email" placeholder="tanaka@example.com" required />
      <button type="submit">追加して招待DMを送る</button>
    </form>

    <h3>現在のメンバー一覧</h3>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th>メールアドレス</th><th>状態</th><th></th></tr>
      ${rows || '<tr><td colspan="3">まだ登録されていません</td></tr>'}
      ${orphanRows}
    </table>
    <p><a href="/admin/status?secret=${secretParam}">状態確認へ戻る</a></p>
  `;
}

app.get('/admin/members', wrap(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const allowList = await store.getAllowList();
  const users = await store.getAllUsers();
  res.send(renderMembersPage(allowList, users, req.query.notice, req.query.detail));
}));

app.get('/admin/add-member', wrap(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { email } = req.query;
  if (!email || typeof email !== 'string') return res.status(400).send('email がありません');

  const normalized = await store.addAllowedEmail(email);
  const inviteUrl = `${BASE_URL}/slack/oauth/start`;

  const result = await sendInviteViaSlackDM(normalized, inviteUrl);
  const notice = result.sent ? 'sent' : 'failed';
  const detailParam = result.reason ? `&detail=${encodeURIComponent(result.reason)}` : '';

  res.redirect(`/admin/members?secret=${encodeURIComponent(TRIGGER_SECRET || '')}&notice=${notice}${detailParam}`);
}));

app.get('/admin/remove-member', wrap(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { email } = req.query;
  if (!email || typeof email !== 'string') return res.status(400).send('email がありません');
  const { removedUserIds } = await store.removeAllowedEmail(email);
  console.log(`メンバー削除: ${email}（登録解除 ${removedUserIds.length}件）`);
  res.redirect(
    `/admin/members?secret=${encodeURIComponent(TRIGGER_SECRET || '')}&notice=removed&detail=${encodeURIComponent(email)}`
  );
}));

app.get('/admin/remove-user', wrap(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { userId } = req.query;
  if (!userId || typeof userId !== 'string') return res.status(400).send('userId がありません');
  await store.removeUser(userId);
  res.redirect(`/admin/members?secret=${encodeURIComponent(TRIGGER_SECRET || '')}`);
}));

app.use('/slack/interactions', express.raw({ type: '*/*' }));

function verifySlackSignature(req) {
  if (!SLACK_SIGNING_SECRET) {
    console.error('SLACK_SIGNING_SECRET が未設定のため、署名検証ができません。');
    return false;
  }
  const timestamp = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!timestamp || !sig) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 60 * 5) return false;

  const base = `v0:${timestamp}:${req.body.toString('utf8')}`;
  const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(base).digest('hex');
  const expected = `v0=${hmac}`;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(sig), 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

app.post('/slack/interactions', async (req, res) => {
  if (!verifySlackSignature(req)) return res.status(401).send('invalid signature');

  // Slackは3秒以内の応答を求めるため、先に200を返してから処理する。
  res.status(200).send();

  // ここから先の例外はすべて自前で捕まえる(プロセスを落とさない)。
  try {
    const bodyStr = req.body.toString('utf8');
    const payload = JSON.parse(new URLSearchParams(bodyStr).get('payload'));

    const action = payload.actions && payload.actions[0];
    if (!action) return;

    const key = action.value;
    const signal = SIGNALS[key];
    const userId = payload.user && payload.user.id;
    if (!signal || !userId) {
      console.warn('不正なボタン操作を無視しました。');
      return;
    }

    const user = await store.getUser(userId);
    if (!user || !user.userToken) {
      console.warn(`未登録ユーザーからの操作: ${userId}`);
      if (payload.response_url) {
        await axios
          .post(payload.response_url, {
            replace_original: false,
            text: '登録が見つかりませんでした。管理者に招待リンクの再送を依頼してください。',
          })
          .catch(() => {});
      }
      return;
    }

    const userClient = new WebClient(user.userToken);
    await userClient.users.profile.set({
      profile: JSON.stringify({
        status_text: signal.text,
        status_emoji: signal.emoji,
        status_expiration: 0,
      }),
    });

    if (payload.response_url) {
      const confirmText =
        key === 'clear'
          ? 'ステータスを解除しました（表示なし）'
          : `ステータスを更新しました: ${signal.emoji} ${signal.label}`;
      await axios.post(payload.response_url, { replace_original: true, text: confirmText });
    }
  } catch (err) {
    console.error('ステータス更新失敗:', err.data || err.message);
  }
});

app.get('/', (req, res) => {
  res.send(`<h1>業務負荷シグナルBot</h1><p><a href="/slack/oauth/start">Slackで登録する</a></p>`);
});

// asyncルートで発生した例外の最終受け皿(プロセスを落とさず500を返す)
app.use((err, req, res, next) => {
  console.error('リクエスト処理中のエラー:', err);
  if (res.headersSent) return;
  res.status(500).send('サーバーエラーが発生しました（詳細はサーバーログを確認してください）');
});

app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  if (TRIGGER_SECRET && BASE_URL) {
    console.log('管理用URL（このログは管理者しか見られません）:');
    console.log(`  状態確認: ${BASE_URL}/admin/status?secret=${TRIGGER_SECRET}`);
    console.log(`  メンバー管理: ${BASE_URL}/admin/members?secret=${TRIGGER_SECRET}`);
    console.log(`  テスト送信: ${BASE_URL}/admin/test?secret=${TRIGGER_SECRET}`);
  }
});
