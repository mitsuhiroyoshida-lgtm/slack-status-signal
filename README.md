# 業務負荷シグナルBot（Slackステータス自動更新）

平日の朝10時・夕方17時にSlackのDMで「今の負荷状況」を聞き、青🔵／黄🟡／赤🔴／解除⚪のボタンを押すと
**本人のSlackステータス絵文字が自動で切り替わる**仕組みです。
1つのBotをホスティングすれば、チームメンバーは各自ブラウザで1回リンクを開いて許可するだけで使えます。

> このREADMEは、コード（このリポジトリ）を保守・設定する管理者向けのドキュメントです。
> 登録メンバー向けの使い方説明は `guide/guide.docx`（利用ガイド）を参照・配布してください。

## 仕組み

1. サーバーを1つデプロイする（このリポジトリのコード）
2. メンバー各自が `https://あなたのURL/slack/oauth/start` を開いて「許可する」を押す（1人1回だけ）
3. 外部の無料cronサービスが `10:00` と `17:00` にサーバーの `/trigger` を叩く
4. サーバーが登録済み全員へDMを送信（青/黄/赤/解除の4ボタン）
5. 押すとその人のSlackステータスがその場で切り替わる（「解除」は空にリセット）

ステータス変更は「本人のトークン」で行うので、Botが勝手に他人のふりをすることはありません。
メンバーが増えても、各自がリンクを開くだけで展開できます。
登録データ（許可リスト・トークン・ON/OFF状態）はUpstash Redis（無料の外部データベース）に保存されるため、
Renderを再デプロイしてもデータは消えません。

## 事前準備：Slack Appを作る（最初の1回だけ、管理者作業）

1. https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. 対象ワークスペースを選び、`manifest.yaml` の中身を貼り付ける
   - `YOUR_HOST` を実際にデプロイするURLに置き換えてから貼り付ける（後述のデプロイ完了後に確定するので、一旦仮のURLで作成し、後で **App Manifest** 画面から書き換えてもOK）
3. 作成後、**Basic Information** ページで以下をメモ
   - Client ID
   - Client Secret
   - Signing Secret

## 事前準備：Upstash Redisを作る（データの永続化用、最初の1回だけ）

Render等の無料ホスティングは再デプロイのたびにファイルが消えるため、外部の無料データベースにデータを保存します。

1. https://upstash.com で無料アカウント作成 → **Redis** データベースを1つ作成
2. データベースの詳細画面から **REST API** の以下2つの値をメモ
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

## デプロイ手順（例：Render、無料枠あり）

1. このフォルダをGitHubリポジトリにpush
2. https://render.com → **New** → **Web Service** → リポジトリを選択
3. Build Command: `npm install` / Start Command: `npm start`
4. Environment変数に `.env.example` の内容を設定
   - `BASE_URL` はRenderが払い出すURL（例 `https://slack-status-signal.onrender.com`）
   - `TRIGGER_SECRET` は適当な長いランダム文字列
   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` は上記で取得した値
5. デプロイ後、Slack Appの設定に戻り以下を更新
   - **OAuth & Permissions** → Redirect URLs → `https://あなたのURL/slack/oauth/callback`
   - **Interactivity & Shortcuts** → Request URL → `https://あなたのURL/slack/interactions`
6. Slack Appの **Install App** ページから、まず自分（管理者）がワークスペースにインストール
   → これでBotトークンが自動保存され、以降のDM送信に使われます

※ Renderの無料プランは一定時間アクセスがないとスリープします。
下記の「10時・17時にcronを叩く」方式なら、その瞬間だけ起動すればよいので無料プランでも実用的です。
（常時起動できる環境があるなら、`ENABLE_INTERNAL_CRON=true` を設定すればサーバー内蔵cronも使えます）

## 10時・17時に自動で叩く設定（無料・コード不要）

https://cron-job.org/ （無料）などの外部cronサービスで、以下2本のURLを毎日決まった時刻に呼び出すよう設定するだけです。

- 朝10:00: `https://あなたのURL/trigger?secret=あなたのTRIGGER_SECRET&label=morning`
- 夕方17:00: `https://あなたのURL/trigger?secret=あなたのTRIGGER_SECRET&label=evening`

タイムゾーンをAsia/Tokyoに設定してください。

## メンバーへの展開方法（自分＋指定した人だけに限定）

誰でも登録できてしまわないよう、`.env` の `ALLOWED_EMAILS` に許可するメールアドレスを
カンマ区切りで指定してください（Slackのプロフィールに登録されているメールアドレスと一致させる）。
これは初回起動時の初期値としてのみ使われ、以降はブラウザの「メンバー管理」画面から追加・削除します。

```
ALLOWED_EMAILS=mitsuhiro.yoshida@yappli.co.jp,tanaka@example.com
```

### ブラウザのメンバー管理画面から追加する（通常運用はこちら）

```
https://あなたのURL/admin/members?secret=あなたのTRIGGER_SECRET
```

メールアドレスを入力して追加すると、Botが自動でそのアドレス宛にSlack DMで招待（登録リンク）を送信します。
（Slackにそのメールアドレスのアカウントが存在している必要があります）
相手が登録リンクを開いて「許可する」を押せば登録完了。次の10時 or 17時のDMからボタンが届きます。
`ALLOWED_EMAILS` に載っていないメールアドレスの人がリンクを開いた場合は「登録できませんでした」と表示され、登録されません。
不要になったメンバーは同じ画面の「削除」リンクから外せます。

## ある期間だけBotを動かす／手動でON・OFFする

「繁忙期の2週間だけ動かしたい」「今すぐ一時停止したい」に対応する2つの仕組みがあります。

### ① 期間指定（環境変数、自動で切り替わる）

`.env` に開始日・終了日を設定すると、その期間の外は自動的にDMが送られなくなります（`/trigger`を叩いても何もしません）。

```
BOT_START_DATE=2026-08-01
BOT_END_DATE=2026-08-15
```

空欄のままなら期間の制限はかかりません（②の手動ON/OFFのみで制御）。

### ② 手動ON/OFF（ブラウザでURLを開くだけ）

以下のURLを開くだけで、いつでも即座に停止・再開できます（`あなたのTRIGGER_SECRET`は`.env`で設定した値）。ブックマークしておくと便利です。

- 停止: `https://あなたのURL/admin/off?secret=あなたのTRIGGER_SECRET`
- 再開: `https://あなたのURL/admin/on?secret=あなたのTRIGGER_SECRET`
- 状態確認: `https://あなたのURL/admin/status?secret=あなたのTRIGGER_SECRET`
- メンバー管理: `https://あなたのURL/admin/members?secret=あなたのTRIGGER_SECRET`

実際にDMが送られるのは「①の期間内」かつ「②がON」の両方を満たしたときだけです。
たとえば期間指定はせずに②だけ使えば、繁忙期が始まったら`/admin/on`を開いて起動し、終わったら`/admin/off`で止める、という運用もできます。

これら4つのリンクは、毎回のチェックインDM本文にも「Bot管理用リンク」として表示されます（全登録メンバーから見える点に注意してください）。

## 土日祝日の自動スキップ

`.env` の `SKIP_WEEKENDS_AND_HOLIDAYS`（デフォルト `true`）を有効にしておくと、土曜・日曜・日本の祝日は
自動的にチェックインDMがスキップされます（`/admin/status` で今日の判定結果を確認できます）。

```
SKIP_WEEKENDS_AND_HOLIDAYS=true
```

## ステータスの絵文字・文言を変える

`server.js` 内の `SIGNALS` オブジェクトを編集するだけで、絵文字・ラベル・ステータス文言を自由に変更できます。

```js
const SIGNALS = {
  blue:   { emoji: ':large_blue_circle:',   label: '青（順調）',       text: '順調に対応中' },
  yellow: { emoji: ':large_yellow_circle:', label: '黄（やや負荷あり）', text: 'やや負荷あり・急ぎは調整希望' },
  red:    { emoji: ':red_circle:',          label: '赤（高負荷）',     text: '高負荷・緊急以外は後ほど対応' },
  clear:  { emoji: '',                      label: '解除（表示なし）', text: '' },
};
```

`clear` のようにemoji/textを空にすると、押したときにSlackステータス表示自体が消えます（解除ボタン）。

## ファイル構成

- `server.js` … サーバー本体（OAuth・DM送信・ボタン処理・管理画面）
- `store.js` … データ保存（Upstash Redis経由。許可リスト・トークン・ON/OFF状態を永続化）
- `manifest.yaml` … Slack App作成用マニフェスト
- `.env.example` … 必要な環境変数一覧
- `guide/guide.docx` … 登録メンバー向けの利用ガイド（配布用）

## 注意点・制限

- データはUpstash Redis（無料枠）に保存しています。無料枠の上限を超える規模で使う場合はプラン変更を検討してください。
- 「一定期間だけ負荷がかかる」用途とのことなので、不要になったら「メンバー管理」画面から該当メンバーを削除するか、Bot自体を停止すればOKです。
- Slackの `users.profile:write` はユーザー本人の許可があって初めて使えるスコープです。管理者権限で他人のステータスを強制変更することはできません（意図的な仕様です）。
- チェックインDMの「Bot管理用リンク」は全登録メンバーに見える形で表示されます。ON/OFFやメンバー管理は基本的に管理者だけが操作する運用にしてください。
