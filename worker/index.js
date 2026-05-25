export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("VRChat Status Webhook Receiver", { status: 200 });
    }

    try {
      const payload = await request.json();
      const embed = buildEmbed(payload);

      if (!embed) {
        return new Response("No actionable event", { status: 200 });
      }

      const discordPayload = { embeds: [embed] };

      const resp = await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload),
      });

      if (!resp.ok) {
        console.error(`Discord error: ${resp.status} ${await resp.text()}`);
        return new Response("Discord notification failed", { status: 502 });
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Error:", err);
      return new Response("Internal error", { status: 500 });
    }
  },
};

function buildEmbed(payload) {
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
