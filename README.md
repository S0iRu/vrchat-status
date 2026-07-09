# VRChat Status Monitor Bot

VRChat のステータスを監視し、障害の発生・更新・復旧を Discord に自動通知するボットです。  
2系統の監視方式で運用しています。

1. **Statuspage ポーリング（GitHub Actions）** — VRChat 公式 Statuspage API を5分毎にチェックし、インシデントの差分を検知
2. **Statuspage Webhook 受信（Cloudflare Worker）** — Statuspage からの Webhook を受信し、日本語化して Discord に即時転送

このほか、VRChat API を直接ヘルスチェックする Worker（`worker/health-monitor.js`）もありますが、現在は停止中です。

## プロジェクト構成

```
.
├── main.py                          # Python エントリーポイント
├── requirements.txt                 # Python 依存パッケージ
├── src/
│   ├── config.py                    # 環境変数・定数
│   ├── checker.py                   # Statuspage API 取得・差分検出
│   ├── state.py                     # state.json 読み書き
│   └── notifiers/
│       └── discord.py               # Discord Webhook 通知
├── worker/
│   ├── index.js                     # CF Worker: Statuspage Webhook受信（日本語化してDiscord転送）
│   └── health-monitor.js            # CF Worker: ヘルスチェック専用（ヒステリシス付き・現在停止中）
└── .github/
    └── workflows/
        └── check_status.yml         # GitHub Actions ワークフロー
```

## 監視方式

### GitHub Actions — Statuspage ポーリング

[check_status.yml](.github/workflows/check_status.yml) により5分毎（cron）に `python main.py` を実行します。

- `https://status.vrchat.com/api/v2/incidents/unresolved.json` から未解決インシデントを取得
- 前回の `state.json`（Actions Cache で永続化）と比較して差分を検出
- 変更があれば Discord Webhook で通知

検出するイベント:

| イベント | 条件 |
|----------|------|
| 新規障害 | 前回になかったインシデントが出現 |
| 状態変化 | ステータスが変化（investigating → identified → monitoring 等） |
| 更新 | ステータスは同じだが `updated_at` が変化 |
| 復旧 | 前回あったインシデントが未解決リストから消えた |

### Cloudflare Worker — VRChat API 直接監視 + Webhook 受信

#### `worker/index.js`

Statuspage Webhook 受信専用の Worker です。HTTP POST で Statuspage からの Webhook を受け取り、Discord Embed に変換して転送します。

Webhook 通知は以下の日本語化処理を行います。

- **本文の日本語化**: Statuspage の定型文・VRChat の常用フレーズは内蔵辞書で翻訳。辞書に無いカスタム文は Workers AI（`@cf/meta/llama-3.3-70b-instruct-fp8-fast`）で機械翻訳し、末尾に「（AI翻訳）」を付記。AI が未設定・失敗時は英語原文をそのまま表示
- **ラベルの日本語化**: ステータス・影響度・コンポーネント名・コンポーネント状態・リージョン名を日本語表示（未知の値は英語のまま表示）
- **メンテナンス予定時間**: メンテナンス通知では開始〜終了の時間帯を Discord タイムスタンプ記法（`<t:...:f>` / `<t:...:R>`）で表示。閲覧者のタイムゾーン（日本なら JST）・言語で自動表示され、相対表示（「○時間後」等）は自動更新される
- **原文の併記**: embed 末尾の「以下原文」フィールドに英語のインシデント名・ステータス・本文をまとめて表示

#### `worker/health-monitor.js`（現在停止中）

ヘルスチェック専用の Worker です。Cron Trigger で `https://api.vrchat.cloud/api/1/config` を定期的に ping し、ダウン・レスポンス遅延（5秒超）を検知します。誤報を抑制するヒステリシス機構を備え、状態管理に KV を使用します。

- 連続2回失敗で「ダウン」通知
- 連続3回成功で「復旧」通知

## 通知内容

すべての通知は Discord Webhook 経由の Embed メッセージで送信されます。

- **新規障害** — インシデント名、ステータス、影響度、影響コンポーネント
- **状態更新** — ステータス変化の通知
- **復旧** — インシデント解決の通知
- **API ダウン検知** — VRChat API の接続失敗・HTTP エラー（health-monitor.js 稼働時のみ・現在停止中）
- **API レスポンス遅延** — 応答が5秒を超えた場合（health-monitor.js 稼働時のみ・現在停止中）
- **API 復旧** — ダウンまたは遅延状態からの復帰（health-monitor.js 稼働時のみ・現在停止中）

## セットアップ

### GitHub Actions

#### 1. Discord Webhook URL の取得

1. Discord で通知を送りたいチャンネルの設定を開く
2. 「連携サービス」→「ウェブフック」→「新しいウェブフック」
3. 名前を設定（例: VRChat Status）し、URL をコピー

#### 2. GitHub Secrets の設定

1. リポジトリの Settings → Secrets and variables → Actions
2. 「New repository secret」で以下を追加:

| Name | Value |
|------|-------|
| `DISCORD_WEBHOOK_URL` | Discord の Webhook URL |

#### 3. 動作確認

1. リポジトリの Actions タブを開く
2. 「VRChat Status Check」ワークフローを選択
3. 「Run workflow」で手動実行

### Cloudflare Worker

#### 1. Worker のデプロイ

```bash
npx wrangler deploy worker/index.js
```

#### 2. 環境変数の設定

Cloudflare ダッシュボードまたは `wrangler.toml` で `DISCORD_WEBHOOK_URL` を設定してください。

#### 3. シークレットパスの設定（推奨・偽装 POST 対策）

Worker の URL は認証なしで POST を受け付けるため、URL を知っていれば誰でも偽の通知を送れてしまいます。`WEBHOOK_SECRET` を設定すると、`/hook/<シークレット>` への POST のみ受け付けるようになります（それ以外は 404）。

1. ランダムな文字列を生成する

```powershell
-join ((48..57) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
```

2. Cloudflare にシークレットとして登録する

```bash
npx wrangler secret put WEBHOOK_SECRET
```

（またはダッシュボード → 対象 Worker → Settings → Variables and Secrets で `WEBHOOK_SECRET` を追加）

3. Statuspage の Webhook 購読を新しい URL で登録し直す

   1. 過去に届いた Webhook の `meta.unsubscribe` リンク、または [status.vrchat.com](https://status.vrchat.com/) の Subscribe メニューから既存の購読を解除
   2. `https://<worker名>.<サブドメイン>.workers.dev/hook/<シークレット>` で再購読

`WEBHOOK_SECRET` 未設定の場合は従来どおり全パスで受け付けます（後方互換）。

#### 4. Workers AI バインディングの設定（任意・本文の機械翻訳用）

辞書に無いカスタム文を日本語に機械翻訳する場合は、Workers AI のバインディングを追加します。

1. Cloudflare ダッシュボード → 対象 Worker → Settings → Bindings
2. 「Add」→「Workers AI」を選択し、変数名を `AI` に設定

未設定でも動作します（その場合、辞書に無い文は英語のまま表示）。Workers AI は無料プランでも1日 10,000 ニューロンの無料枠があり、本用途では十分です。無料枠超過時は課金されずリクエストが拒否され、英語原文表示にフォールバックします。

## ローカル実行

Python 側のステータスチェックはローカルでも実行できます。

```bash
pip install -r requirements.txt
```

```powershell
$env:DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/XXXXX/YYYYY"
python main.py
```

初回実行時は前回の状態がないため、現在アクティブな障害があれば通知が送信されます。  
2回目以降は前回との差分のみが通知されます。

## 環境変数

### Python / GitHub Actions

| 変数名 | 必須 | デフォルト | 用途 |
|--------|------|------------|------|
| `DISCORD_WEBHOOK_URL` | はい | `""` | Discord Webhook URL |
| `STATE_FILE` | いいえ | `state.json` | 状態ファイルのパス |
| `MISSKEY_INSTANCE_URL` | いいえ | `""` | Misskey 通知用（未実装） |
| `MISSKEY_ACCESS_TOKEN` | いいえ | `""` | Misskey 通知用（未実装） |

### Cloudflare Worker

| バインディング | 用途 |
|---------------|------|
| `DISCORD_WEBHOOK_URL` | Discord Webhook URL |
| `WEBHOOK_SECRET` | 受信パスのシークレット（推奨。設定時は `/hook/<シークレット>` のみ受け付け） |
| `AI` | Workers AI（任意。辞書に無い本文の機械翻訳用） |
| `KV` | ヘルスチェック状態の永続化（health-monitor.js 使用時のみ） |

## 今後の拡張予定

- [ ] Misskey 通知対応（`config.py` に環境変数は定義済み、notifier 未実装）
- [ ] X (Twitter) 通知対応
