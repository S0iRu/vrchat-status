# VRChat Status Monitor Bot

VRChatのステータスページを定期的に監視し、障害の発生・更新・復旧をDiscordに自動通知するボットです。

## セットアップ手順

### 1. リポジトリをGitHubにプッシュ

```bash
cd D:\GitHubRepos\vrchat-status-bot
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<あなたのユーザー名>/vrchat-status-bot.git
git push -u origin main
```

### 2. Discord Webhook URLの取得

1. Discordで通知を送りたいサーバーのチャンネル設定を開く
2. 「連携サービス」→「ウェブフック」→「新しいウェブフック」
3. 名前を設定（例: VRChat Status）し、URLをコピー

### 3. GitHub Secretsの設定

1. GitHubリポジトリの Settings → Secrets and variables → Actions
2. 「New repository secret」をクリック
3. 以下を追加:

| Name | Value |
|------|-------|
| `DISCORD_WEBHOOK_URL` | DiscordのWebhook URL |

### 4. 動作確認

1. GitHubリポジトリの Actions タブを開く
2. 「VRChat Status Check」ワークフローを選択
3. 「Run workflow」ボタンで手動実行
4. ログを確認してエラーがないことを確認

## ローカルでのテスト

```bash
pip install -r requirements.txt
set DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/XXXXX/YYYYY
python main.py
```

初回実行時は前回の状態がないため、現在アクティブな障害があれば通知が送信されます。
2回目以降は前回との差分のみが通知されます。

## 通知内容

- **新規障害**: 新しいインシデントが作成された時
- **状態更新**: ステータスが変化した時（investigating → identified → monitoring）
- **復旧**: インシデントが解決された時

## 今後の拡張予定

- [ ] Misskey 通知対応
- [ ] X (Twitter) 通知対応
