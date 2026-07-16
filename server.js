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
  BOT_START_DATE = '', // 例: 2026-07-01（Asia/Tokyo基準）。空なら開始日の制限なし
  BOT_END_DATE = '',   // 例: 2026-07-31（この日を含む）。空なら終了日の制限なし
} = process.env;

const ALLOW_LIST = ALLOWED_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

const app = express();

// ------- ステータスの選択肢（ここを増減・変更すればOK） -------
const SIGNALS = {
  blue: { emoji: ':large_blue_circle:', label: '青（順調）', text: '順調に対応中' },
  yellow: { emoji: ':large_yellow_circle:', label: '黄（やや負荷あり）', text: 'やや負荷あり・急ぎは調整希望' },
  red: { emoji: ':red_circle:', label: '赤（高負荷）', text: '高負荷・緊急以外は後ほど対応' },
};

// ===================== 0. 起動期間・ON/OFF判定 =====================

// 今日の日付（Asia/Tokyo, YYYY-MM-DD）
function todayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// BOT_START_DATE〜BOT_END_DATEの期間内かどうか（両方空なら常にtrue）
function isWithinActivePeriod() {
  const today = todayJST();
  if (BOT_START_DATE && today < BOT_START_DATE) return false;
  if (BOT_END_DATE && today > BOT_END_DATE) return false;
  return true;
}

// 実際にチェックインを送ってよいか（手動ON/OFF ＋ 期間の両方を満たす必要がある）
function isActiveNow() {
  return store.getEnabled() && isWithinActivePeriod();
}

// ===================== 1. OAuth: メンバーの許可導線 =====================

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

    if (ALLOW_LIST.length > 0) {
      const botToken = store.getBotToken();
      const botClient = new WebClient(botToken);
      const info = await botClient.users.info({ user: userId });
      const email = info.user && info.user.profile && info.user.profile.email;
      if (!email || !ALLOW_LIST.includes(email.toLowerCase())) {
        return res
          .status(403)
          .send('<h2>登録できませんでした</h2><p>このBotは指定されたメンバーのみ利用できます。心当たりがない場合は管理者にご確認ください。</p>');
      }
      store.upsertUser(userId, { email });
    }

    store.upsertUser(userId, { userToken });
    return res.send(
      '<h2>登録が完了しました 🎉</h2><p>Botが稼働中の期間、毎朝10時・夕方17時にDMが届きます。ボタンを押すとあなたのSlackステータスが自動で切り替わります。このタブは閉じて大丈夫です。</p>'
    );
  } catch (err) {
    console.error(err);
    return res.status(500).send('サーバーエラー');
  }
});

// ===================== 2. DM送信（チェックイン） =====================

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
        ],
      });
    } catch (err) {
      console.error(`DM送信失敗 (user=${user.id}):`, err.data || err.message);
    }
  }
}

// 外部の無料cronサービス（例: cron-job.org）から叩いてもらうエンドポイント。
// GET /trigger?secret=TRIGGER_SECRET&label=morning|evening
// 手動OFF中、または起動期間外の場合はDMを送らずスキップする。
app.get('/trigger', async (req, res) => {
  const { secret, label } = req.query;
  if (secret !== TRIGGER_SECRET) return res.status(403).send('forbidden');

  if (!isActiveNow()) {
    console.log(`スキップ: enabled=${store.getEnabled()} / 期間内=${isWithinActivePeriod()}`);
    return res.send('skipped (Botは現在停止中、または起動期間外です)');
  }

  const timeLabel = label === 'evening' ? '17時' : '10時';
  await sendCheckinToAll(timeLabel);
  res.send('ok');
});

// サーバーを常時起動できる環境なら、内蔵cronでも良い（任意）。この場合もisActiveNow()でガードされる。
if (ENABLE_INTERNAL_CRON === 'true') {
  cron.schedule(
    '0 10 * * *',
    () => { if (isActiveNow()) sendCheckinToAll('10時'); },
    { timezone: 'Asia/Tokyo' }
  );
  cron.schedule(
    '0 17 * * *',
    () => { if (isActiveNow()) sendCheckinToAll('17時'); },
    { timezone: 'Asia/Tokyo' }
  );
}

// ===================== 2.5 管理用: 手動ON/OFF・状態確認 =====================
// ブラウザでURLを開くだけで切り替えられる。ブックマークしておくと便利。
// GET /admin/on?secret=...   → Botを起動（DM送信を再開）
// GET /admin/off?secret=...  → Botを停止（DM送信を止める）
// GET /admin/status?secret=... → 現在の状態を確認

app.get('/admin/on', (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return res.status(403).send('forbidden');
  store.setEnabled(true);
  res.send('<h2>Botを起動しました ▶️</h2><p>次回の10時/17時のチェックインからDMが届きます（起動期間の設定がある場合はその範囲内に限ります）。</p>');
});

app.get('/admin/off', (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return res.status(403).send('forbidden');
  store.setEnabled(false);
  res.send('<h2>Botを停止しました ⏸️</h2><p>再開するまでDMは送信されません。</p>');
});

app.get('/admin/status', (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return res.status(403).send('forbidden');
  res.send(
    `<h2>現在の状態</h2>` +
      `<p>手動ON/OFF: ${store.getEnabled() ? 'ON' : 'OFF'}</p>` +
      `<p>起動期間: ${BOT_START_DATE || '(指定なし)'} 〜 ${BOT_END_DATE || '(指定なし)'}</p>` +
      `<p>今日(JST): ${todayJST()} / 期間内: ${isWithinActivePeriod() ? 'はい' : 'いいえ'}</p>` +
      `<p>実際に送信されるか: ${isActiveNow() ? '送信される' : '送信されない'}</p>`
  );
});

// ===================== 3. ボタン押下 → 本人のステータスを変更 =====================

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
