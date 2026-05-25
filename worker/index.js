const VRCHAT_CONFIG_URL = "https://api.vrchat.cloud/api/1/config";
const HEALTH_CHECK_TIMEOUT_MS = 10000;
const SLOW_THRESHOLD_MS = 5000;
const CONSECUTIVE_FAILURES_BEFORE_ALERT = 2;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("VRChat Status Webhook Receiver", { status: 200 });
    }

    try {
      const payload = await request.json();
      const embed = buildStatusPageEmbed(payload);

      if (!embed) {
        return new Response("No actionable event", { status: 200 });
      }

      const discordPayload = { embeds: [embed] };
      await sendToDiscord(env.DISCORD_WEBHOOK_URL, discordPayload);
      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Webhook handler error:", err);
      return new Response("Internal error", { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(performHealthCheck(env));
  },
};

async function performHealthCheck(env) {
  const result = await checkVRChatAPI();
  const previousState = await env.KV.get("health_state", { type: "json" }) || {
    status: "up",
    consecutive_failures: 0,
  };

  const currentStatus = determineStatus(result);
  const shouldNotify = shouldSendNotification(previousState, currentStatus, result);

  if (shouldNotify) {
    const embed = buildHealthEmbed(currentStatus, result, previousState.status);
    await sendToDiscord(env.DISCORD_WEBHOOK_URL, { embeds: [embed] });
  }

  const newState = {
    status: currentStatus,
    consecutive_failures: currentStatus === "up" ? 0 : (previousState.consecutive_failures || 0) + 1,
    last_check: new Date().toISOString(),
    last_status_code: result.statusCode,
    last_response_ms: result.responseMs,
  };

  await env.KV.put("health_state", JSON.stringify(newState));
}

async function checkVRChatAPI() {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    const resp = await fetch(VRCHAT_CONFIG_URL, { signal: controller.signal });
    clearTimeout(timeout);
    const elapsed = Date.now() - start;

    return {
      success: true,
      statusCode: resp.status,
      responseMs: elapsed,
      error: null,
    };
  } catch (err) {
    clearTimeout(timeout);
    const elapsed = Date.now() - start;

    let errorType = "UNKNOWN_ERROR";
    if (err.name === "AbortError") {
      errorType = "TIMEOUT";
    } else if (err.message?.includes("DNS")) {
      errorType = "DNS_FAILURE";
    } else if (err.message?.includes("connect")) {
      errorType = "CONNECTION_REFUSED";
    } else if (err.message?.includes("TLS") || err.message?.includes("SSL")) {
      errorType = "TLS_ERROR";
    }

    return {
      success: false,
      statusCode: null,
      responseMs: elapsed,
      error: errorType,
    };
  }
}

function determineStatus(result) {
  if (!result.success) return "down";
  if (result.statusCode !== 200) return "down";
  if (result.responseMs > SLOW_THRESHOLD_MS) return "degraded";
  return "up";
}

function shouldSendNotification(previousState, currentStatus, result) {
  const prevStatus = previousState.status;
  const failures = previousState.consecutive_failures || 0;

  if (currentStatus === "up" && prevStatus !== "up") {
    return true;
  }

  if (currentStatus === "down" && prevStatus === "up") {
    return true;
  }
  if (currentStatus === "down" && prevStatus === "down" && failures === CONSECUTIVE_FAILURES_BEFORE_ALERT - 1) {
    return false;
  }

  if (currentStatus === "degraded" && prevStatus === "up") {
    return true;
  }
  if (currentStatus === "up" && prevStatus === "degraded") {
    return true;
  }

  return false;
}

function buildHealthEmbed(currentStatus, result, previousStatus) {
  let title, color;

  if (currentStatus === "up" && previousStatus !== "up") {
    title = "✅ VRChat API 復旧";
    color = 0x2ecc71;
  } else if (currentStatus === "degraded") {
    title = "⚠️ VRChat API レスポンス遅延";
    color = 0xf1c40f;
  } else {
    title = "🚨 VRChat API ダウン検知";
    color = 0xe74c3c;
  }

  const fields = [];

  if (result.statusCode !== null) {
    fields.push({ name: "ステータスコード", value: `HTTP ${result.statusCode}`, inline: true });
  } else {
    fields.push({ name: "エラー種別", value: result.error, inline: true });
  }

  fields.push({ name: "レスポンス時間", value: `${result.responseMs}ms`, inline: true });
  fields.push({ name: "検知方法", value: "直接監視 (1分毎)", inline: true });

  let description;
  if (currentStatus === "up") {
    description = "VRChat API が正常に応答しています。";
  } else if (currentStatus === "degraded") {
    description = `VRChat API の応答に ${(result.responseMs / 1000).toFixed(1)} 秒かかっています。`;
  } else if (result.error === "TIMEOUT") {
    description = `VRChat API から ${HEALTH_CHECK_TIMEOUT_MS / 1000} 秒以内に応答がありませんでした。`;
  } else if (result.error) {
    description = `VRChat API への接続に失敗しました (${result.error})。`;
  } else {
    description = `VRChat API がエラーを返しています (HTTP ${result.statusCode})。`;
  }

  return {
    title,
    description,
    color,
    fields,
    url: "https://status.vrchat.com",
    footer: { text: "VRChat Status Monitor (直接監視)" },
    timestamp: new Date().toISOString(),
  };
}

// --- Statuspage Webhook 用 (既存) ---

function buildStatusPageEmbed(payload) {
  const incident = payload.incident || payload;

  if (!incident || !incident.name) {
    return null;
  }

  const status = incident.status || "unknown";
  const impact = incident.impact || "none";

  const IMPACT_COLORS = {
    none: 0x2ecc71,
    minor: 0xf1c40f,
    major: 0xe67e22,
    critical: 0xe74c3c,
  };

  const STATUS_LABELS = {
    investigating: "調査中",
    identified: "原因特定",
    monitoring: "経過観察中",
    resolved: "解決済み",
    postmortem: "事後分析",
  };

  let title;
  let color = IMPACT_COLORS[impact] || 0x95a5a6;

  if (status === "resolved") {
    title = `✅ 復旧: ${incident.name}`;
    color = 0x2ecc71;
  } else if (incident.new_status === "investigating" || status === "investigating") {
    title = `🚨 新規障害: ${incident.name}`;
  } else {
    title = `🔄 状態更新: ${incident.name}`;
  }

  const statusLabel = STATUS_LABELS[status] || status;

  const updates = incident.incident_updates || [];
  const latestBody = updates.length > 0 ? updates[0].body : "";

  const fields = [
    { name: "ステータス", value: statusLabel, inline: true },
    { name: "影響度", value: impact, inline: true },
  ];

  const affectedComponents = incident.components || [];
  if (affectedComponents.length > 0) {
    const names = affectedComponents.map((c) => c.name).join("\n");
    fields.push({ name: "影響コンポーネント", value: names, inline: false });
  }

  return {
    title,
    description: latestBody || "詳細情報なし",
    color,
    fields,
    url: incident.shortlink || "https://status.vrchat.com",
    footer: { text: "VRChat Status Monitor (Webhook)" },
    timestamp: incident.updated_at || new Date().toISOString(),
  };
}

// --- 共通ユーティリティ ---

async function sendToDiscord(webhookUrl, payload) {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    console.error(`Discord error: ${resp.status} ${await resp.text()}`);
  }

  return resp.ok;
}
