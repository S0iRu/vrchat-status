const VRCHAT_CONFIG_URL = "https://api.vrchat.cloud/api/1/config";
const HEALTH_CHECK_TIMEOUT_MS = 10000;
const SLOW_THRESHOLD_MS = 5000;
const FAILURES_BEFORE_ALERT = 2;
const RECOVERIES_BEFORE_CLEAR = 3;

export default {
  async fetch(request, env) {
    return new Response("VRChat Health Monitor - Use Cron Trigger", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(performHealthCheck(env));
  },
};

async function performHealthCheck(env) {
  const result = await checkVRChatAPI();
  const previousState = (await env.KV.get("health_state", { type: "json" })) || {
    status: "up",
    consecutive_failures: 0,
    consecutive_recoveries: 0,
  };

  const currentCheck = determineStatus(result);
  const prevStatus = previousState.status;
  const failures = previousState.consecutive_failures || 0;
  const recoveries = previousState.consecutive_recoveries || 0;

  let newStatus = prevStatus;
  let newFailures = failures;
  let newRecoveries = recoveries;

  if (currentCheck === "up") {
    newFailures = 0;
    if (prevStatus !== "up") {
      newRecoveries = recoveries + 1;
      if (newRecoveries >= RECOVERIES_BEFORE_CLEAR) {
        newStatus = "up";
        newRecoveries = 0;
      }
    } else {
      newRecoveries = 0;
    }
  } else {
    newRecoveries = 0;
    newFailures = failures + 1;
    if (newFailures >= FAILURES_BEFORE_ALERT && prevStatus === "up") {
      newStatus = currentCheck;
    }
  }

  const stateChanged = newStatus !== prevStatus || newFailures !== failures || newRecoveries !== recoveries;
  const needsWrite = stateChanged && (newStatus !== "up" || prevStatus !== "up");

  if (newStatus !== prevStatus) {
    if (newStatus === "up" && prevStatus !== "up") {
      const embed = buildHealthEmbed("up", result, prevStatus);
      await sendToDiscord(env.DISCORD_WEBHOOK_URL, { embeds: [embed] });
    } else if (newStatus !== "up" && prevStatus === "up") {
      const embed = buildHealthEmbed(newStatus, result, prevStatus);
      await sendToDiscord(env.DISCORD_WEBHOOK_URL, { embeds: [embed] });
    }
  }

  if (needsWrite) {
    const newState = {
      status: newStatus,
      consecutive_failures: newFailures,
      consecutive_recoveries: newRecoveries,
      last_check: new Date().toISOString(),
      last_status_code: result.statusCode,
      last_response_ms: result.responseMs,
    };
    await env.KV.put("health_state", JSON.stringify(newState));
  }
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
