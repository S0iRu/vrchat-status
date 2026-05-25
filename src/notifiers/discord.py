import requests
from ..config import DISCORD_WEBHOOK_URL


IMPACT_COLORS = {
    "none": 0x2ECC71,       # 緑
    "minor": 0xF1C40F,      # 黄
    "major": 0xE67E22,      # オレンジ
    "critical": 0xE74C3C,   # 赤
}

STATUS_LABELS = {
    "investigating": "調査中",
    "identified": "原因特定",
    "monitoring": "経過観察中",
    "resolved": "解決済み",
    "postmortem": "事後分析",
}


def send_discord_notification(event: dict) -> bool:
    if not DISCORD_WEBHOOK_URL:
        print("[Discord] DISCORD_WEBHOOK_URL が未設定のためスキップ")
        return False

    embed = _build_embed(event)
    payload = {"embeds": [embed]}

    resp = requests.post(DISCORD_WEBHOOK_URL, json=payload, timeout=30)
    if resp.status_code in (200, 204):
        print(f"[Discord] 通知送信成功: {event['type']}")
        return True
    else:
        print(f"[Discord] 通知送信失敗: {resp.status_code} {resp.text}")
        return False


def _build_embed(event: dict) -> dict:
    incident = event["incident"]
    event_type = event["type"]
    impact = incident.get("impact", "none")
    color = IMPACT_COLORS.get(impact, 0x95A5A6)

    status_raw = incident.get("status", "unknown")
    status_label = STATUS_LABELS.get(status_raw, status_raw)

    if event_type == "new_incident":
        title = f"🚨 新規障害: {incident['name']}"
    elif event_type == "resolved":
        title = f"✅ 復旧: {incident['name']}"
        color = 0x2ECC71
    elif event_type == "status_change":
        title = f"🔄 状態更新: {incident['name']}"
    else:
        title = f"📝 更新: {incident['name']}"

    fields = []
    fields.append({"name": "ステータス", "value": status_label, "inline": True})
    fields.append({"name": "影響度", "value": impact, "inline": True})

    affected = incident.get("affected_components", [])
    if affected:
        fields.append({"name": "影響コンポーネント", "value": "\n".join(affected), "inline": False})

    description = incident.get("body", "")
    if len(description) > 300:
        description = description[:300] + "..."

    embed = {
        "title": title,
        "description": description or "詳細情報なし",
        "color": color,
        "fields": fields,
        "url": incident.get("shortlink", "https://status.vrchat.com"),
        "footer": {"text": "VRChat Status Monitor"},
    }

    return embed
