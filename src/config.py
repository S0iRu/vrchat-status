import os


VRCHAT_STATUS_API = "https://status.vrchat.com/api/v2"

DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL", "")
MISSKEY_INSTANCE_URL = os.environ.get("MISSKEY_INSTANCE_URL", "")
MISSKEY_ACCESS_TOKEN = os.environ.get("MISSKEY_ACCESS_TOKEN", "")

STATE_FILE = os.environ.get("STATE_FILE", "state.json")
