"""VRChat Status Monitor - メインエントリーポイント"""

from src.checker import fetch_unresolved_incidents, build_incident_state, detect_changes
from src.state import load_state, save_state
from src.notifiers.discord import send_discord_notification


def main():
    print("=== VRChat Status Monitor ===")

    # 1. 現在のインシデントを取得
    print("Statuspage API からデータ取得中...")
    incidents = fetch_unresolved_incidents()
    print(f"  未解決インシデント数: {len(incidents)}")

    # 2. 状態をビルド
    current_state = build_incident_state(incidents)

    # 3. 前回の状態をロード
    previous_state = load_state()
    print(f"  前回の保存状態: {len(previous_state)} 件")

    # 4. 差分を検出
    events = detect_changes(previous_state, current_state)
    print(f"  検出された変更: {len(events)} 件")

    # 5. 変更があれば通知を送信
    if events:
        for event in events:
            print(f"  -> {event['type']}: {event['incident']['name']}")
            send_discord_notification(event)
    else:
        print("  変更なし。通知はスキップします。")

    # 6. 現在の状態を保存
    save_state(current_state)
    print("状態を保存しました。完了。")


if __name__ == "__main__":
    main()
