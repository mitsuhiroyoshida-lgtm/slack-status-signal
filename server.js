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
  BOT_START_DATE = '',
  BOT_END_DATE = '',
  SKIP_WEEKENDS_AND_HOLIDAYS = 'true',
} = process.env;

const INITIAL_ALLOW_LIST = ALLOWED_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
store.seedAllowListIfEmpty(INITIAL_ALLOW_LIST);

const app = express();

const SIGNALS = {
  blue: { emoji: ':large_blue_circle:', label: '青（順調）', text: '順調に対応中' },
  yellow: { emoji: ':large_yellow_circle:', label: '黄（やや負荷あり）', text: 'やや負荷あり・急ぎは調整希望' },
  red: { emoji: ':red_circle:', label: '赤（高負荷）', text: '高負荷・緊急以外は後ほど対応' },
};

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

async function getHolidaysMap() {
  const today = todayJST();
  if (holidaysCache && holidaysCacheDate === today) return holidaysCache;
  try {
    const { data } = await axios.get('https://holidays-jp.github.io/api/v1/date.json', { timeout: 5000 });
    holidaysCache = data;
    holidaysCacheDate = today;
    return data;
  } catch (err) {
    console.error('祝日データ取得失敗:', err.message);
    return holidaysCache || {};
  }
}

async function isHolidayTodayJST() {
  const map = await getHolidaysMap();
  return Boolean(map[todayJST()]);
}

async function isActiveNow() {
  if (!store.getEnabled()) return false;
  if (!isWithinActivePeriod()) return false;
  if (SKIP_WEEKENDS_AND_HOLIDAYS === 'true') {
    if (isWeekendJST()) return false;
    if (await isHolidayTodayJST()) return false;
  }
  return true;
}

async function sendInviteViaSlackDM(email, inviteUrl) {
  const botToken = store.getBotToken();
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

    if (data.access_token && !store.getBotToken()) {
      store.setBotToken(data.access_token);
    }

    const userId = data.authed_user && data.authed_user.id;
    const userToken = data.authed_user && data.authed_user.access_token;

    if (!userId || !userToken) {
      return res.status(400).send('ユーザートークンの取得に失敗しました');
    }

    const allowList = store.getAllowList();
    if (allowList.length > 0) {
      const botToken = store.getBotToken();
      const botClient = new WebClient(botToken);
      const info = await botClient.users.info({ user: userId });
      const email = info.user && info.user.profile && info.user.profile.email;
      if (!email || !allowList.includes(email.toLowerCase())) {
        return res
          .status(403)
          .send('<h2>登録できませんでした</h2><p>このBotは指定されたメンバーのみ利用できます。心当たりがない場合は管理者にご確認ください。</p>');
      }
      store.upsertUser(userId, { email });
    }

    store.upsertUser(userId, { userToken });
    return res.send(
      '<h2>登録が完了しました 🎉</h2><p>Botが稼働中の期間、平日の10時・17時にDMが届きます。ボタンを押すとあなたのSlackステータスが自動で切り替わります。このタブは閉じて大丈夫です。</p>'
    );
  } catch (err) {
    console.error(err);
    return res.status(500).send('サーバーエラー');
  }
});

async function sendCheckinToAll(timeLabel) {
  const botToken = store.getBotToken();
  if (!botToken) {
    console.warn('botトークン未登録。誰か1人がまず /slack/oauth/start から登録してください。');
    return;
  }
  const client = new WebClient(botToken);
  const users = store.getAllUsers();

  for (const user of users) {
    try {
      const im = await client.conversations.open({ users: user.id });
      const channelId = im.channel.id;

      await client.chat.postMessage({
        channel: channelId,
        text: `${timeLabel}の負荷状況チェックです。今の状況を選んでください。`,
        blocks: [
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
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text:
                  'Bot管理用リンク: ' +
                  `<${BASE_URL}/admin/on?secret=${TRIGGER_SECRET}|起動(ON)> ｜ ` +
                  `<${BASE_URL}/admin/off?secret=${TRIGGER_SECRET}|停止(OFF)> ｜ ` +
                  `<${BASE_URL}/admin/status?secret=${TRIGGER_SECRET}|状態確認> ｜ ` +
                  `<${BASE_URL}/admin/members?secret=${TRIGGER_SECRET}|メンバー管理>`,
              },
            ],
          },
        ],
      });
    } catch (err) {
      console.error(`DM送信失敗 (user=${user.id}):`, err.data || err.message);
    }
  }
}

app.get('/trigger', async (req, res) => {
  const { secret, label } = req.query;
  if (secret !== TRIGGER_SECRET) return res.status(403).send('forbidden');

  const active = await isActiveNow();
  if (!active) {
    console.log(`スキップ: enabled=${store.getEnabled()} / 期間内=${isWithinActivePeriod()} / 土日祝スキップ設定=${SKIP_WEEKENDS_AND_HOLIDAYS}`);
    return res.send('skipped (Botは現在停止中、起動期間外、または土日祝日です)');
  }

  const timeLabel = label === 'evening' ? '17時' : '10時';
  await sendCheckinToAll(timeLabel);
  res.send('ok');
});

if (ENABLE_INTERNAL_CRON === 'true') {
  cron.schedule(
    '0 10 * * *',
    async () => { if (await isActiveNow()) sendCheckinToAll('10時'); },
    { timezone: 'Asia/Tokyo' }
  );
  cron.schedule(
    '0 17 * * *',
    async () => { if (await isActiveNow()) sendCheckinToAll('17時'); },
    { timezone: 'Asia/Tokyo' }
  );
}

app.get('/admin/on', (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return res.status(403).send('forbidden');
  store.setEnabled(true);
  res.send('<h2>Botを起動しました ▶️</h2><p>次回の10時/17時のチェックインからDMが届きます（起動期間・土日祝日の設定がある場合はその範囲内に限ります）。</p>');
});

app.get('/admin/off', (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return res.status(403).send('forbidden');
  store.setEnabled(false);
  res.send('<h2>Botを停止しました ⏸️</h2><p>再開するまでDMは送信されません。</p>');
});

app.get('/admin/status', async (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return res.status(403).send('forbidden');
  const weekend = isWeekendJST();
  const holiday = SKIP_WEEKENDS_AND_HOLIDAYS === 'true' ? await isHolidayTodayJST() : false;
  const active = await isActiveNow();
  res.send(
    `<h2>現在の状態</h2>` +
      `<p>手動ON/OFF: ${store.getEnabled() ? 'ON' : 'OFF'}</p>` +
      `<p>起動期間: ${BOT_START_DATE || '(指定なし)'} 〜 ${BOT_END_DATE || '(指定なし)'}</p>` +
      `<p>土日祝スキップ設定: ${SKIP_WEEKENDS_AND_HOLIDAYS === 'true' ? '有効' : '無効'}</p>` +
      `<p>今日(JST): ${todayJST()} / 土日: ${weekend ? 'はい' : 'いいえ'} / 祝日: ${holiday ? 'はい' : 'いいえ'}</p>` +
      `<p>期間内: ${isWithinActivePeriod() ? 'はい' : 'いいえ'}</p>` +
      `<p>実際に送信されるか: ${active ? '送信される' : '送信されない'}</p>`
  );
});

function renderMembersPage(notice, noticeDetail) {
  const allowList = store.getAllowList();
  const users = store.getAllUsers();
  const registeredEmails = new Set(users.map((u) => (u.email || '').toLowerCase()));

  const rows = allowList
    .map((email) => {
      const registered = registeredEmails.has(email);
      const status = registered ? '✅ 登録済み' : '⏳ 招待中（未登録）';
      const removeLink = `/admin/remove-member?secret=${TRIGGER_SECRET}&email=${encodeURIComponent(email)}`;
      const resendLink = `/admin/add-member?secret=${TRIGGER_SECRET}&email=${encodeURIComponent(email)}`;
      return `<tr><td>${email}</td><td>${status}</td><td><a href="${resendLink}">招待DM再送</a> | <a href="${removeLink}" onclick="return confirm('${email} を削除しますか？')">削除</a></td></tr>`;
    })
    .join('');

  const inviteUrl = `${BASE_URL}/slack/oauth/start`;

  let noticeHtml = '';
  if (notice === 'sent') {
    noticeHtml = '<p style="color:green;">✅ Slack DMで招待を送信しました</p>';
  } else if (notice === 'failed') {
    noticeHtml =
      `<p style="color:red;">⚠️ メンバーは追加しましたが、招待DMの送信に失敗しました（${noticeDetail || '原因不明'}）。上の登録用リンクを直接送ってください。</p>`;
  }

  return `
    <h2>メンバー管理</h2>
    ${noticeHtml}
    <p>ここで許可したメールアドレスの人だけが、下記の登録リンクを使ってBotに登録できます。</p>
    <p>登録用リンク（DM送信に失敗した場合はこちらを直接送ってください）:<br><code>${inviteUrl}</code></p>

    <h3>メンバーを追加（追加すると自動でSlack DMが送られます）</h3>
    <form method="GET" action="/admin/add-member">
      <input type="hidden" name="secret" value="${TRIGGER_SECRET}" />
      <input type="email" name="email" placeholder="tanaka@example.com" required />
      <button type="submit">追加して招待DMを送る</button>
    </form>

    <h3>現在のメンバー一覧</h3>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th>メールアドレス</th><th>状態</th><th></th></tr>
      ${rows || '<tr><td colspan="3">まだ登録されていません</td></tr>'}
    </table>
  `;
}

app.get('/admin/members', (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return res.status(403).send('forbidden');
  res.send(renderMembersPage(req.query.notice, req.query.detail));
});

app.get('/admin/add-member', async (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return res.status(403).send('forbidden');
  const { email } = req.query;
  if (!email) return res.status(400).send('email がありません');

  const normalized = store.addAllowedEmail(email);
  const inviteUrl = `${BASE_URL}/slack/oauth/start`;

  const result = await sendInviteViaSlackDM(normalized, inviteUrl);
  const notice = result.sent ? 'sent' : 'failed';
  const detailParam = result.reason ? `&detail=${encodeURIComponent(result.reason)}` : '';

  res.redirect(`/admin/members?secret=${TRIGGER_SECRET}&notice=${notice}${detailParam}`);
});

app.get('/admin/remove-member', (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return res.status(403).send('forbidden');
  const { email } = req.query;
  if (!email) return res.status(400).send('email がありません');
  store.removeAllowedEmail(email);
  res.redirect(`/admin/members?secret=${TRIGGER_SECRET}`);
});

app.use('/slack/interactions', express.raw({ type: '*/*' }));

function verifySlackSignature(req) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!timestamp || !sig) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 60 * 5) return false;

  const base = `v0:${timestamp}:${req.body.toString('utf8')}`;
  const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(base).digest('hex');
  const expected = `v0=${hmac}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

app.post('/slack/interactions', async (req, res) => {
  if (!verifySlackSignature(req)) return res.status(401).send('invalid signature');

  const bodyStr = req.body.toString('utf8');
  const payload = JSON.parse(new URLSearchParams(bodyStr).get('payload'));

  res.status(200).send();

  const action = payload.actions && payload.actions[0];
  if (!action) return;

  const key = action.value;
  const signal = SIGNALS[key];
  const userId = payload.user.id;
  const user = store.getUser(userId);

  if (!signal || !user || !user.userToken) {
    console.warn(`未登録ユーザーからの操作、または不正な値: ${userId}`);
    return;
  }

  try {
    const userClient = new WebClient(user.userToken);
    await userClient.users.profile.set({
      profile: JSON.stringify({
        status_text: signal.text,
        status_emoji: signal.emoji,
        status_expiration: 0,
      }),
    });

    if (payload.response_url) {
      await axios.post(payload.response_url, {
        replace_original: true,
        text: `ステータスを更新しました: ${signal.emoji} ${signal.label}`,
      });
    }
  } catch (err) {
    console.error('ステータス更新失敗:', err.data || err.message);
  }
});

app.get('/', (req, res) => {
  res.send(
    `<h1>業務負荷シグナルBot</h1><p><a href="/slack/oauth/start">Slackで登録する</a></p>`
  );
});

app.listen(PORT, () => console.log(`listening on :${PORT}`));
