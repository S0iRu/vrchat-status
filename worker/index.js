export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("VRChat Status Webhook Receiver", { status: 200 });
    }

    // WEBHOOK_SECRET 設定時は /hook/<シークレット> への POST のみ受け付ける(偽装POST対策)
    // 未設定の場合は従来どおり全パスで受け付ける(設定前のデプロイでも通知が止まらないように)
    if (env.WEBHOOK_SECRET) {
      const { pathname } = new URL(request.url);
      if (pathname !== `/hook/${env.WEBHOOK_SECRET}`) {
        return new Response("Not found", { status: 404 });
      }
    }

    try {
      const payload = await request.json();
      const embed = await buildStatusPageEmbed(payload, env);

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
};

// --- Statuspage Webhook 用 ---

const TRANSLATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const IMPACT_COLORS = {
  none: 0x2ecc71,
  minor: 0xf1c40f,
  major: 0xe67e22,
  critical: 0xe74c3c,
  maintenance: 0x3498db,
};

const STATUS_LABELS = {
  investigating: "調査中",
  identified: "原因特定",
  monitoring: "経過観察中",
  resolved: "解決済み",
  postmortem: "事後分析",
  scheduled: "メンテナンス予定",
  in_progress: "メンテナンス実施中",
  verifying: "完了確認中",
  completed: "メンテナンス完了",
};

const IMPACT_LABELS = {
  none: "なし",
  minor: "軽微",
  major: "重大",
  critical: "致命的",
  maintenance: "メンテナンス",
};

const COMPONENT_STATUS_LABELS = {
  operational: "稼働中",
  degraded_performance: "性能低下",
  partial_outage: "部分障害",
  major_outage: "重大障害",
  under_maintenance: "メンテナンス中",
};

const COMPONENT_NAME_LABELS = {
  "API / Website": "API / ウェブサイト",
  "Authentication / Login": "認証 / ログイン",
  "Social / Friends List": "ソーシャル / フレンドリスト",
  "SDK Asset Uploads": "SDKアセットアップロード",
  "Realtime Player State Changes": "リアルタイムプレイヤー状態更新",
  "Realtime Networking": "リアルタイムネットワーキング",
  "USA, West (San José)": "USW(米国西部・サンノゼ)",
  "USA, East (Washington D.C.)": "USE(米国東部・ワシントンD.C.)",
  "Europe (Amsterdam)": "EU(欧州・アムステルダム)",
  "Japan (Tokyo)": "JP(日本・東京)",
};

// 本文中のリージョン言及の表記揺れ → 統一表示(キーは小文字)
const REGION_LABELS = {
  "us west": "USW(米国西部・サンノゼ)",
  "us-west": "USW(米国西部・サンノゼ)",
  "usw": "USW(米国西部・サンノゼ)",
  "usa, west (san josé)": "USW(米国西部・サンノゼ)",
  "us east": "USE(米国東部・ワシントンD.C.)",
  "us-east": "USE(米国東部・ワシントンD.C.)",
  "use": "USE(米国東部・ワシントンD.C.)",
  "usa, east (washington d.c.)": "USE(米国東部・ワシントンD.C.)",
  "eu": "EU(欧州・アムステルダム)",
  "europe": "EU(欧州・アムステルダム)",
  "europe (amsterdam)": "EU(欧州・アムステルダム)",
  "japan": "JP(日本・東京)",
  "jp": "JP(日本・東京)",
  "japan (tokyo)": "JP(日本・東京)",
};

// Statuspage 標準定型文 + VRChat 常用フレーズ(過去インシデントで2回以上使用)
// キーは normalizeText() で正規化して照合する
const BODY_PHRASES = [
  // Statuspage 標準(障害系)
  ["We are currently investigating this issue.", "現在この問題を調査しています。"],
  ["The issue has been identified and a fix is being implemented.", "原因を特定し、修正対応を進めています。"],
  ["A fix has been implemented and we are monitoring the results.", "修正を適用し、経過を観察しています。"],
  ["We are continuing to investigate this issue.", "引き続きこの問題を調査しています。"],
  ["We are continuing to work on a fix for this issue.", "引き続き修正対応を進めています。"],
  ["We are continuing to monitor for any further issues.", "引き続き経過を観察しています。"],
  ["This incident has been resolved.", "この障害は解決されました。"],
  // Statuspage 標準(メンテナンス系)
  ["We will be undergoing scheduled maintenance during this time.", "この時間帯に定期メンテナンスを実施します。"],
  ["We will be undergoing scheduled maintenance at this time.", "この時間帯に定期メンテナンスを実施予定です。"],
  ["We will be undergoing scheduled maintenance at this time. All systems will still be operational during this maintenance.", "この時間帯に定期メンテナンスを実施予定です。メンテナンス中もすべてのシステムは通常どおり稼働します。"],
  ["All systems will still be operational during this maintenance.", "メンテナンス中もすべてのシステムは通常どおり稼働します。"],
  ["Scheduled maintenance is currently in progress. We will provide updates as necessary.", "定期メンテナンスを実施中です。必要に応じて更新情報をお知らせします。"],
  ["We are verifying that the maintenance was completed successfully.", "メンテナンスが正常に完了したことを確認しています。"],
  ["The scheduled maintenance has been completed.", "定期メンテナンスは完了しました。"],
  // VRChat 常用フレーズ
  ["We're observing logins return to normal levels", "ログインが通常水準に戻りつつあることを確認しています。"],
  ["We're seeing api errors and latency returning to normal levels. We'll continue to monitor to ensure things remain stable.", "APIのエラーとレイテンシが通常水準に戻りつつあります。安定が続くか引き続き監視します。"],
  ["We're aware of and are investigating increased latency and error rates of our API systems.", "APIシステムのレイテンシ増加とエラー率上昇を認識しており、調査中です。"],
  ["Network connectivity appears to be stabilized. We are monitoring the situation.", "ネットワーク接続は安定したようです。状況を監視しています。"],
  ["Login functionality is working again, we're continuing to monitor the stability of our upstream provider.", "ログイン機能は復旧しました。引き続き上流プロバイダーの安定性を監視します。"],
  ["We are monitoring network connectivity issues with our servers. Upstream providers have been contacted.", "サーバーのネットワーク接続問題を監視しています。上流プロバイダーには連絡済みです。"],
  ["Performance is returning to normal, we're continuing to monitor to ensure things remain stable.", "パフォーマンスは通常に戻りつつあります。安定が続くか引き続き監視します。"],
  ["Performance of API systems have returned to normal. We're continuing to monitor to ensure things remain stable.", "APIシステムのパフォーマンスは通常に戻りました。安定が続くか引き続き監視します。"],
  ["Our upstream provider has rolled out changes that should improve network connectivity across our real-time networking infrastructure. We'll keep monitoring the situation to quickly address any further issues.", "上流プロバイダーがリアルタイムネットワーク基盤の接続性を改善する変更を展開しました。さらなる問題に迅速に対応できるよう監視を続けます。"],
  ["We're aware of and are monitoring performance and stability issues of our API systems caused by issues with an upstream provider.", "上流プロバイダーの問題に起因するAPIシステムのパフォーマンス・安定性の問題を認識しており、監視しています。"],
  ["Connection times appear to have returned to normal, we will be continuing to monitor the situation.", "接続時間は通常に戻ったようです。引き続き状況を監視します。"],
  ["We are aware and are investigating login issues caused by an outage at one of our upstream providers.", "上流プロバイダーの障害によるログイン問題を認識しており、調査中です。"],
  ["We're currently investigating an increase in errors and latency with our API", "現在、APIのエラーとレイテンシの増加を調査しています。"],
  ["We're aware of and are monitoring performance and stability issues of our API systems caused by an upstream provider performing maintenance at this time.", "上流プロバイダーが実施中のメンテナンスに起因するAPIシステムのパフォーマンス・安定性の問題を認識しており、監視しています。"],
  ["We're currently observing issues with logging in to VRChat", "現在、VRChatへのログインに問題が発生していることを確認しています。"],
  ["We're seeing our systems recover and are monitoring to ensure they remain stable", "システムの回復を確認しており、安定が続くか監視しています。"],
  ["We're seeing an increase in latency and errors from our API, currently investigating", "APIのレイテンシ増加とエラーを確認しており、現在調査中です。"],
  ["We've identified the issue and are working to fix it", "問題の原因を特定し、修正に取り組んでいます。"],
  ["We've stabilized our systems and are seeing things recover. Will continue monitoring", "システムは安定し、回復傾向にあります。引き続き監視を行います。"],
  // リージョン障害テンプレートの後続定型段落
  ["Other regions appear to be unaffected by this issue, for the time being you may temporarily want to choose a different region during instance creation while we're investigating this incident with our provider.", "他のリージョンには影響がないようです。プロバイダーと調査を進める間、当面はインスタンス作成時に別のリージョンを選択することをご検討ください。"],
];

const BODY_PHRASE_MAP = new Map(BODY_PHRASES.map(([en, ja]) => [normalizeText(en), ja]));

// リージョン名だけが変わる頻出テンプレート文
const REGION_TEMPLATE_RE =
  /^we're observing upstream provider network connectivity issues with our realtime servers which may result in timeouts and degraded performance across instances(?: hosted in (?:the )?(.+?)(?: region)?)?\.?$/i;

function normalizeText(text) {
  return text.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "").toLowerCase();
}

function regionLabel(name) {
  return REGION_LABELS[name.trim().toLowerCase()] || name;
}

function formatUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// 段落単位で辞書・テンプレートを照合。一致しなければ null
function translateParagraph(paragraph) {
  const collapsed = paragraph.trim().replace(/\s+/g, " ");

  const hit = BODY_PHRASE_MAP.get(normalizeText(collapsed));
  if (hit) return hit;

  const m = collapsed.match(REGION_TEMPLATE_RE);
  if (m) {
    if (m[1]) {
      return `上流プロバイダーのネットワーク接続問題により、${regionLabel(m[1])}リージョンのインスタンスでタイムアウトやパフォーマンス低下が発生する可能性があります。`;
    }
    return "上流プロバイダーのネットワーク接続問題により、インスタンスでタイムアウトやパフォーマンス低下が発生する可能性があります。";
  }

  return null;
}

function cleanTranslationOutput(raw) {
  let output = raw.trim();
  // reasoning 系モデルの思考ブロック除去
  output = output.replace(/<think>[\s\S]*?<\/think>/gi, "");
  output = output.replace(/<think>[\s\S]*?<\/redacted_thinking>/gi, "");
  output = output.trim();
  // 前置き除去
  output = output.replace(/^(?:Translation|Japanese translation|日本語訳|訳文)\s*[:：]\s*/i, "");
  // 前後の引用符・括弧除去
  output = output.replace(/^["'「『]+|["'」』]+$/g, "").trim();
  return output;
}

async function translateWithAI(text, env) {
  if (!env || !env.AI) return null;

  try {
    const result = await env.AI.run(TRANSLATION_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You are a professional translator. Translate the user's text from English to natural Japanese. Output only the Japanese translation, with no explanations, notes, or quotation marks.",
        },
        { role: "user", content: text },
      ],
      max_tokens: 1024,
    });

    const output = cleanTranslationOutput(result?.response || "");
    if (!output) {
      console.error("AI translation empty output");
      return null;
    }
    // 異常出力ガード(翻訳として長すぎる場合は採用しない)
    if (output.length > text.length * 3 + 100) {
      console.error("AI translation too long:", output.length);
      return null;
    }
    return output;
  } catch (err) {
    console.error("AI translation error:", err);
    return null;
  }
}

// 本文の日本語化: 全段落が辞書・テンプレートに一致すれば辞書訳、
// 一致しなければ AI 翻訳(末尾に「(AI翻訳)」)、それも不可なら英語原文
async function translateBody(body, env) {
  if (!body) return "";

  const paragraphs = body.trim().split(/\n\s*\n/);
  const translated = paragraphs.map(translateParagraph);

  if (translated.every((t) => t !== null)) {
    return translated.join("\n\n");
  }

  const ai = await translateWithAI(body, env);
  if (ai) return `${ai}(AI翻訳)`;

  return body;
}

async function buildStatusPageEmbed(payload, env) {
  const incident = payload.incident || payload;

  if (!incident || !incident.name) {
    return null;
  }

  const status = incident.status || "unknown";
  const impact = incident.impact || "none";

  let title;
  let color = IMPACT_COLORS[impact] || 0x95a5a6;

  if (status === "resolved") {
    title = `✅ 復旧: ${incident.name}`;
    color = 0x2ecc71;
  } else if (status === "completed") {
    title = `✅ メンテナンス完了: ${incident.name}`;
    color = 0x2ecc71;
  } else if (status === "scheduled") {
    title = `🔧 メンテナンス予定: ${incident.name}`;
    color = 0x3498db;
  } else if (status === "in_progress") {
    title = `🔧 メンテナンス実施中: ${incident.name}`;
    color = 0x3498db;
  } else if (status === "verifying") {
    title = `🔧 メンテナンス完了確認中: ${incident.name}`;
    color = 0x3498db;
  } else if (incident.new_status === "investigating" || status === "investigating") {
    title = `🚨 新規障害: ${incident.name}`;
  } else {
    title = `🔄 状態更新: ${incident.name}`;
  }

  const updates = incident.incident_updates || [];
  const latestUpdate = updates.length > 0 ? updates[0] : null;
  const latestBody = latestUpdate ? latestUpdate.body : "";

  let description = (await translateBody(latestBody, env)) || "詳細情報なし";
  if (description.length > 2000) {
    description = description.slice(0, 2000) + "...";
  }

  const fields = [
    { name: "ステータス", value: STATUS_LABELS[status] || status, inline: true },
    { name: "影響度", value: IMPACT_LABELS[impact] || impact, inline: true },
  ];

  const affectedComponents = incident.components || [];
  if (affectedComponents.length > 0) {
    const names = affectedComponents
      .map((c) => {
        // Unicode 正規化(NFC)で é 等の合成差異による不一致を防ぐ
        const nameJa = COMPONENT_NAME_LABELS[(c.name || "").normalize("NFC")] || c.name;
        const statusJa = c.status ? COMPONENT_STATUS_LABELS[c.status] || c.status : "";
        return statusJa ? `${nameJa} - ${statusJa}` : nameJa;
      })
      .join("\n");
    fields.push({ name: "影響コンポーネント", value: names, inline: false });
  }

  // メンテナンスの予定時間帯(scheduled_for / scheduled_until はメンテナンス時のみ含まれる)
  // Discord タイムスタンプ記法: 閲覧者のタイムゾーン(JST等)・言語で自動表示
  if (incident.scheduled_for) {
    const start = Math.floor(Date.parse(incident.scheduled_for) / 1000);
    const end = incident.scheduled_until ? Math.floor(Date.parse(incident.scheduled_until) / 1000) : NaN;
    if (Number.isFinite(start)) {
      const range = Number.isFinite(end) ? `<t:${start}:f> 〜 <t:${end}:f>` : `<t:${start}:f>`;
      fields.push({ name: "メンテナンス予定時間", value: `${range}\n(<t:${start}:R>)`, inline: false });
    }
  }

  const originalLines = [`**${incident.name}**`, `Status: ${status} / Impact: ${impact}`];
  if (affectedComponents.length > 0) {
    const componentList = affectedComponents
      .map((c) => (c.status ? `${c.name} (${c.status})` : c.name))
      .join(", ");
    originalLines.push(`Components: ${componentList}`);
  }
  if (incident.scheduled_for) {
    const until = incident.scheduled_until ? ` - ${formatUtc(incident.scheduled_until)}` : "";
    originalLines.push(`Scheduled: ${formatUtc(incident.scheduled_for)}${until} UTC`);
  }
  if (latestBody) {
    originalLines.push(
      latestBody
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
    );
  }
  let original = originalLines.join("\n");
  if (original.length > 1024) {
    original = original.slice(0, 1021) + "...";
  }
  // 日本語エリアと原文エリアの視覚的な区切り("\u200b" は不可視文字)
  fields.push({
    name: "\u200b",
    value: "🔗 [VRChat ステータスページ](https://status.vrchat.com/)\n──────────────────",
    inline: false,
  });
  fields.push({ name: "以下原文", value: original, inline: false });

  return {
    title,
    description,
    color,
    fields,
    url: incident.shortlink || "https://status.vrchat.com",
    footer: { text: "VRChat Status Monitor (Webhook)" },
    timestamp: incident.updated_at || new Date().toISOString(),
  };
}

// テスト用エクスポート
export { buildStatusPageEmbed, translateBody };

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
