import requests
from .config import VRCHAT_STATUS_API


def fetch_unresolved_incidents() -> list[dict]:
    url = f"{VRCHAT_STATUS_API}/incidents/unresolved.json"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data.get("incidents", [])


def fetch_status_summary() -> dict:
    url = f"{VRCHAT_STATUS_API}/status.json"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.json()


def build_incident_state(incidents: list[dict]) -> dict[str, dict]:
    """各インシデントのID -> 最新ステータスのマッピングを構築"""
    state = {}
    for incident in incidents:
        latest_update = incident.get("incident_updates", [])
        latest_status = latest_update[0]["status"] if latest_update else incident.get("status", "unknown")
        latest_body = latest_update[0]["body"] if latest_update else ""

        affected = [
            c["name"] for c in incident.get("components", [])
            if c.get("status") != "operational"
        ]

        state[incident["id"]] = {
            "id": incident["id"],
            "name": incident.get("name", ""),
            "status": latest_status,
            "body": latest_body,
            "impact": incident.get("impact", ""),
            "affected_components": affected,
            "shortlink": incident.get("shortlink", ""),
            "created_at": incident.get("created_at", ""),
            "updated_at": incident.get("updated_at", ""),
        }
    return state


def detect_changes(previous: dict[str, dict], current: dict[str, dict]) -> list[dict]:
    """前回と今回の状態を比較して変更イベントのリストを返す"""
    events = []

    for inc_id, inc_data in current.items():
        if inc_id not in previous:
            events.append({
                "type": "new_incident",
                "incident": inc_data,
            })
        elif previous[inc_id]["status"] != inc_data["status"]:
            events.append({
                "type": "status_change",
                "incident": inc_data,
                "previous_status": previous[inc_id]["status"],
            })
        elif previous[inc_id]["updated_at"] != inc_data["updated_at"]:
            events.append({
                "type": "update",
                "incident": inc_data,
            })

    for inc_id, inc_data in previous.items():
        if inc_id not in current:
            events.append({
                "type": "resolved",
                "incident": inc_data,
            })

    return events
