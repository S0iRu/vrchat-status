# VRChat Status Monitor Bot

VRChat のステータスを監視し、障害の発生・更新・復旧を Discord に自動通知するボットです。  
2系統の監視方式で運用しています。

1. **Statuspage ポーリング（GitHub Actions）** — VRChat 公式 Statuspage API を5分毎にチェックし、インシデントの差分を検知
2. **VRChat API 直接監視（Cloudflare Worker）** — VRChat API エンドポイントを1分毎にヘルスチェックし、ダウンや遅延を即時検知。加えて Statuspage Webhook の受信にも対応

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
│   ├── index.js                     # CF Worker: Webhook受信 + ヘルスチェック
│   └── health-monitor.js            # CF Worker: ヘルスチェック専用（ヒステリシス付き）
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

2つの機能を持つ Worker です。

- **Statuspage Webhook 受信**: HTTP POST で Statuspage からの Webhook を受け取り、Discord Embed に変換して転送
- **VRChat API ヘルスチェック**: Cron Trigger で `https://api.vrchat.cloud/api/1/config` を定期的に ping し、ダウン・レスポンス遅延（5秒超）を検知。KV で前回状態を管理

#### `worker/health-monitor.js`

ヘルスチェック専用の Worker です。`index.js` と同じ VRChat API を監視しますが、誤報を抑制するヒステリシス機構を備えています。

- 連続2回失敗で「ダウン」通知
- 連続3回成功で「復旧」通知

## 通知内容

すべての通知は Discord Webhook 経由の Embed メッセージで送信されます。

- **新規障害** — インシデント名、ステータス、影響度、影響コンポーネント
- **状態更新** — ステータス変化の通知
- **復旧** — インシデント解決の通知
- **API ダウン検知** — VRChat API の接続失敗・HTTP エラー（Worker による直接監視）
- **API レスポンス遅延** — 応答が5秒を超えた場合（Worker による直接監視）
- **API 復旧** — ダウンまたは遅延状態からの復帰（Worker による直接監視）

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

#### 2. KV Namespace の作成

ヘルスチェックの状態管理用に KV Namespace を作成し、Worker にバインドします。

```bash
npx wrangler kv namespace create "KV"
```

#### 3. 環境変数の設定

Cloudflare ダッシュボードまたは `wrangler.toml` で `DISCORD_WEBHOOK_URL` を設定してください。

#### 4. Cron Trigger の設定

Cloudflare ダッシュボードで Cron Trigger を設定します（例: `* * * * *` で1分毎）。

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
| `KV` | ヘルスチェック状態の永続化 |

## 今後の拡張予定

- [ ] Misskey 通知対応（`config.py` に環境変数は定義済み、notifier 未実装）
- [ ] X (Twitter) 通知対応
