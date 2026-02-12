/**
 * Cloudflare Worker - Quant Signal Router (Production Grade)
 * * Architecture:
 * - Input: HTTP POST (Vencord) & Cron Triggers
 * - Logic: Regex Ticker Extraction -> KV Config Routing -> AI Sentiment Analysis
 * - Storage: D1 Database (Tables: trades, analysis, feeds, system_logs)
 * - Output: Discord / Telegram Webhooks
 * - Observability: D1-based structured logging
 */

import { TickerEngine } from './utils/tickerEngine.js';
import { Logger } from './utils/logger.js';

// --- Constants & Config ---
const CONSTANTS = {
  KV_KEYS: {
    ROUTING: "ROUTING_TABLE",
    TASKS: "SCHEDULED_TASKS"
  },
  TYPES: {
    SIGNAL: "SIGNAL",
    ANALYSIS: "ANALYSIS",
    FEED: "FEED",
    REPORT_TRENDING: "TRENDING_FEED",
    REPORT_ANALYSIS: "ANALYSIS_SUMMARY"
  },
  AI_MODEL: "@cf/huggingface/distilbert-sst-2-int8",
  CORS_HEADERS: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
};

export default {
  // =================================================================
  // 1. HTTP Request Handler
  // =================================================================
  async fetch(request, env, ctx) {
    // Initialize Logger
    const logger = new Logger(env, ctx);

    // CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CONSTANTS.CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: CONSTANTS.CORS_HEADERS });
    }

    try {
      // Payload Parsing
      const payload = await safeJsonParse(request);
      if (!payload) {
        logger.warn("Invalid JSON Payload received");
        return new Response("Invalid JSON", { status: 400, headers: CONSTANTS.CORS_HEADERS });
      }

      // 1. Ticker Extraction
      const tickers = TickerEngine.extract(payload.text || "");
      
      // Log incoming interesting traffic
      if (tickers.length > 0 || String(payload.is_test) === "true") {
        logger.info("Traffic Received", { 
          user: payload.u, 
          channel: payload.cn, 
          tickers: tickers,
          is_test: payload.is_test 
        });
      }

      // 2. Load Configuration
      const routingConfig = await getKVConfig(env, CONSTANTS.KV_KEYS.ROUTING, logger);
      if (!routingConfig) {
        logger.warn("KV Config missing or empty");
      }

      // 3. Task Dispatching
      const tasks = [];
      const isTest = String(payload.is_test) === "true";
      let matchedRule = null;

      for (const rule of (routingConfig || [])) {
        if (!rule.enabled) continue;

        // Rule Matching Logic
        const matchChannel = !rule.match.channel_id?.length || rule.match.channel_id.includes(payload.c_id);
        const matchUser = !rule.match.user_id?.length || rule.match.user_id.includes(payload.u_id);
        const isTestMatch = isTest && (rule.name.toLowerCase().includes("test"));

        if ((matchChannel && matchUser) || isTestMatch) {
          matchedRule = rule.name;
          
          // Scenario A: Trade Signal (Priority: High)
          if (rule.type === CONSTANTS.TYPES.SIGNAL) {
            if (tickers.length > 0) {
              tasks.push(saveTradeToD1(env, tickers, payload, logger));
            }
            // Push Notifications
            rule.routes?.telegram?.forEach(chatId => 
              tasks.push(sendToTelegram(payload, env.TG_BOT_TOKEN, chatId, logger))
            );
            rule.routes?.discord?.forEach(webhook => 
              tasks.push(sendToDiscord(payload, webhook, logger))
            );
          }

          // Scenario B: Market Analysis (Priority: Medium)
          else if (rule.type === CONSTANTS.TYPES.ANALYSIS) {
            if (tickers.length > 0) {
              tasks.push(analyzeAndSaveToD1(env, "analysis", tickers, payload, logger));
            }
          }

          // Scenario C: Social Feed (Priority: Low, High Noise)
          else if (rule.type === CONSTANTS.TYPES.FEED) {
            if (tickers.length > 0) {
              tasks.push(analyzeAndSaveToD1(env, "feeds", tickers, payload, logger));
            }
          }
        }
      }

      if (matchedRule) {
        logger.info("Rule Matched", { rule: matchedRule, type: payload.is_test ? "TEST" : "LIVE" });
      }

      // Non-blocking execution
      ctx.waitUntil(Promise.allSettled(tasks));

      // Return success with CORS headers
      return new Response("OK", { status: 200, headers: CONSTANTS.CORS_HEADERS });

    } catch (e) {
      // Global Error Boundary
      logger.error("Worker Panic", { error: e.message, stack: e.stack });
      return new Response("Internal Server Error", { status: 500, headers: CONSTANTS.CORS_HEADERS });
    }
  },

  // =================================================================
  // 2. Scheduled Handler (Heartbeat Pattern)
  // =================================================================
  async scheduled(event, env, ctx) {
    const logger = new Logger(env, ctx);
    const currentMinute = Math.floor(Date.now() / 60000);
    
    // Auto-cleanup logs every day at 3:00 AM UTC (180th minute of the day)
    // 1440 minutes in a day. 180 % 1440 == 180.
    if (currentMinute % 1440 === 180) {
      ctx.waitUntil(cleanupOldLogs(env, logger));
    }

    const tasksConfig = await getKVConfig(env, CONSTANTS.KV_KEYS.TASKS, logger);
    if (!tasksConfig) return;

    const jobs = [];
    for (const task of tasksConfig) {
      if (!task.enabled) continue;

      // Trigger logic: Execute if current minute aligns with interval
      if (task.interval && currentMinute % task.interval === 0) {
        logger.info(`Triggering Scheduled Task: ${task.name}`);
        
        // Set default lookback to interval if not specified
        task.lookback_minutes = task.lookback_minutes || task.interval; 
        jobs.push(generateAndSendReport(env, task, logger));
      }
    }

    ctx.waitUntil(Promise.allSettled(jobs));
  }
};

// =================================================================
// 3. Logic & Helper Functions
// =================================================================

/** Safely parse JSON from request */
async function safeJsonParse(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Helper to get and parse KV config */
async function getKVConfig(env, key, logger) {
  try {
    const raw = await env.SIGNAL_CONFIG.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    logger.error(`KV Error [${key}]`, { error: e.message });
    return null;
  }
}

/** Helper to construct Discord Jump Link */
function createJumpLink(data) {
  return `https://discord.com/channels/${data.s_id}/${data.c_id}/${data.m_id}`;
}

/** Helper to extract first image URL */
function extractImage(data) {
  return (data.imgs && data.imgs.length > 0) ? data.imgs[0] : null;
}

// --- D1 & AI Operations ---

async function saveTradeToD1(env, tickers, data, logger) {
  if (!env.DB) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const img = extractImage(data);
  
  const stmt = env.DB.prepare(
    `INSERT INTO trades (ticker, raw_message, source_channel, source_message_id, created_at, image_url) VALUES (?, ?, ?, ?, ?, ?)`
  );
  
  const batch = tickers.map(t => stmt.bind(t, data.text, data.cn, data.m_id, timestamp, img));
  
  try {
    await env.DB.batch(batch);
    logger.info(`Saved Trades`, { count: tickers.length, tickers: tickers });
  } catch (e) {
    logger.error("D1 Trade Save Error", { error: e.message });
  }
}

async function analyzeAndSaveToD1(env, tableName, tickers, data, logger) {
  if (!env.DB || !env.AI) return;

  // AI Sentiment Inference
  let sentiment = "NEUTRAL";
  let confidence = 0.0;

  try {
    const response = await env.AI.run(CONSTANTS.AI_MODEL, { text: data.text });
    if (response && response[0]) {
      // Sort by score descending
      const top = [...response].sort((a, b) => b.score - a.score)[0];
      if (top.label === "POSITIVE") sentiment = "BULLISH";
      else if (top.label === "NEGATIVE") sentiment = "BEARISH";
      confidence = top.score;
    }
  } catch (e) {
    logger.error("AI Inference Failed", { error: e.message });
  }

  // DB Insert
  const timestamp = Math.floor(Date.now() / 1000);
  const img = extractImage(data);
  const stmt = env.DB.prepare(
    `INSERT INTO ${tableName} (ticker, sentiment, confidence, raw_message, author, source_channel, created_at, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const batch = tickers.map(t => 
    stmt.bind(t, sentiment, confidence, data.text, data.u, data.cn, timestamp, img)
  );

  try {
    await env.DB.batch(batch);
    // Don't log every single feed item to avoid spamming system_logs, only log high confidence ones or analysis
    if (tableName === 'analysis' || confidence > 0.9) {
        logger.info(`Analyzed Content`, { table: tableName, tickers: tickers, sentiment: sentiment });
    }
  } catch (e) {
    logger.error(`D1 ${tableName} Error`, { error: e.message });
  }
}

async function cleanupOldLogs(env, logger) {
    if (!env.DB) return;
    // 7 days ago
    const threshold = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
    
    try {
      const info = await env.DB.prepare(
        `DELETE FROM system_logs WHERE created_at < ?`
      ).bind(threshold).run();
      
      logger.info("System Logs Cleaned", { deleted: info.meta.changes });
    } catch (e) {
      logger.error("Log Cleanup Failed", { error: e.message });
    }
}

// --- Notification Actions ---

async function sendToTelegram(data, botToken, chatId, logger) {
  if (!botToken || !chatId) return;

  const jumpLink = createJumpLink(data);
  const text = `
🚨 <b>SIGNAL</b>
📂 ${data.sn} | ${data.cn}
👤 <b>${data.u}</b>
------------------------------
${data.text}

<a href="${jumpLink}">🔗 Jump to Message</a>`.trim();

  const img = extractImage(data);
  const endpoint = img ? "sendPhoto" : "sendMessage";
  const body = { 
    chat_id: chatId, 
    parse_mode: "HTML", 
    disable_web_page_preview: true 
  };
  
  if (img) { 
    body.photo = img; 
    body.caption = text; 
  } else { 
    body.text = text; 
  }

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/${endpoint}`, {
      method: "POST", 
      headers: { "Content-Type": "application/json" }, 
      body: JSON.stringify(body)
    });
  } catch (e) { 
    logger.error("TG Send Error", { error: e.message }); 
  }
}

async function sendToDiscord(data, webhookUrl, logger) {
  if (!webhookUrl) return;

  // 1. 颜色判定
  let color = 0x5865F2; 
  const content = (data.text || "").toLowerCase();
  if (content.match(/call|bull|buy|long|up/)) color = 0x57F287; 
  if (content.match(/put|bear|sell|short|down|gap/)) color = 0xED4245; 

  // 2. 构建主 Embed
  const mainEmbed = {
    author: {
        name: `${data.sn || 'Unknown'} • #${data.cn || 'Unknown'}`,
        icon_url: data.g_icon || "https://i.imgur.com/4M34hi2.png" 
    },
    title: `📢 New Signal from ${data.u || 'User'}`,
    url: typeof createJumpLink === 'function' ? createJumpLink(data) : null, 
    description: data.text || "", 
    color: color,
    footer: { text: new Date().toLocaleTimeString() },
    timestamp: new Date().toISOString()
  };

  // --- 3. 图片识别 (双重保险: imgs + attachments) ---
  let validImageUrl = null;
  // A. 检查 Vencord 特有字段 imgs
  if (data.imgs && Array.isArray(data.imgs) && data.imgs.length > 0) {
      validImageUrl = data.imgs[0];
  }
  // B. 检查标准 attachments
  if (!validImageUrl && data.attachments && Array.isArray(data.attachments)) {
    const found = data.attachments.find(att => {
        return (att.width || att.height) || 
               (att.content_type && att.content_type.startsWith("image/")) ||
               (att.filename && /\.(jpg|jpeg|png|gif|webp)$/i.test(att.filename)) ||
               (att.url && /\.(jpg|jpeg|png|gif|webp)/i.test(att.url));
    });
    if (found) validImageUrl = found.url;
  }
  if (validImageUrl) {
      mainEmbed.image = { url: validImageUrl };
  }

  // --- 4. 🔥 修复：Bot Embeds (兼容 desc 缩写) ---
  const extraEmbeds = [];
  if (data.embeds && Array.isArray(data.embeds)) {
    data.embeds.forEach(originEmbed => {
      const richEmbed = {};
      
      // 搬运 Title
      if (originEmbed.title) richEmbed.title = originEmbed.title;
      
      // ✅ [核心修复] 同时检查 description 和 desc
      // 很多插件为了省流量会用 desc 这个缩写
      const descText = originEmbed.description || originEmbed.desc; 
      if (descText) richEmbed.description = descText;
      
      // 搬运 URL
      if (originEmbed.url) richEmbed.url = originEmbed.url;
      
      // 搬运 Footer
      if (originEmbed.footer) {
          richEmbed.footer = { text: originEmbed.footer.text, icon_url: originEmbed.footer.icon_url };
      }
      
      // 搬运 Timestamp
      if (originEmbed.timestamp) richEmbed.timestamp = originEmbed.timestamp;
      
      // 搬运颜色
      richEmbed.color = color !== 0x5865F2 ? color : (originEmbed.color || color);

      // 搬运图片
      if (originEmbed.image && originEmbed.image.url) {
          richEmbed.image = { url: originEmbed.image.url };
      }
      if (originEmbed.thumbnail && originEmbed.thumbnail.url) {
          richEmbed.thumbnail = { url: originEmbed.thumbnail.url };
      }
      
      // 搬运 Fields
      if (originEmbed.fields && Array.isArray(originEmbed.fields)) {
        richEmbed.fields = originEmbed.fields.map(f => ({
            name: f.name.slice(0, 256),
            value: f.value.slice(0, 1024),
            inline: f.inline
        }));
      }

      if (Object.keys(richEmbed).length > 0) {
        extraEmbeds.push(richEmbed);
      }
    });
  }

  const finalEmbeds = [mainEmbed, ...extraEmbeds];

  try {
    await fetch(webhookUrl, {
      method: "POST", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Signal Router",
        avatar_url: "https://i.imgur.com/4M34hi2.png", 
        embeds: finalEmbeds 
      })
    });
  } catch (e) { 
    logger.error("Discord Send Error", { error: e.message }); 
  }
}

// --- Reporting Logic (Restored) ---

async function generateAndSendReport(env, task, logger) {
  if (!env.DB) return;
  const timeThreshold = Math.floor(Date.now() / 1000) - (task.lookback_minutes * 60);
  
  let reportEmbed = null;

  // Report Type A: Trending Heatmap
  if (task.type === CONSTANTS.TYPES.REPORT_TRENDING) {
    const { results } = await env.DB.prepare(`
      SELECT ticker, sentiment, COUNT(*) as count 
      FROM feeds 
      WHERE created_at > ? 
      GROUP BY ticker 
      HAVING count >= ?
      ORDER BY count DESC 
      LIMIT 10
    `).bind(timeThreshold, task.min_mentions || 1).all();

    if (!results || results.length === 0) return;

    const listText = results.map((r, i) => {
      const icon = r.sentiment === 'BULLISH' ? '🟢' : (r.sentiment === 'BEARISH' ? '🔴' : '⚪');
      return `**#${i+1} ${r.ticker}** ${icon} (${r.count} mentions)`;
    }).join("\n");

    reportEmbed = {
      title: `🔥 Market Heatmap (Last ${task.lookback_minutes}m)`,
      description: listText,
      color: 0xFF9900, // Orange
      footer: { text: "Signal Router Analytics" },
      timestamp: new Date().toISOString()
    };
  }

  // Report Type B: Analysis Summary
  else if (task.type === CONSTANTS.TYPES.REPORT_ANALYSIS) {
    const { results } = await env.DB.prepare(`
      SELECT ticker, sentiment, raw_message, author, created_at
      FROM analysis
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 15
    `).bind(timeThreshold).all();

    if (!results || results.length === 0) return;

    const fields = results.map(r => {
      const icon = r.sentiment === 'BULLISH' ? '🚀' : (r.sentiment === 'BEARISH' ? '📉' : '⚖️');
      const summary = r.raw_message.length > 60 ? r.raw_message.substring(0, 60) + "..." : r.raw_message;
      return {
        name: `${icon} ${r.ticker} (${r.author})`,
        value: summary,
        inline: false
      };
    });

    reportEmbed = {
      title: `🧠 Institutional Views (Last ${(task.lookback_minutes/60).toFixed(1)}h)`,
      color: 0x9B59B6, // Purple
      fields: fields,
      timestamp: new Date().toISOString()
    };
  }

  // Send Report
  if (reportEmbed && task.target_hooks) {
    for (const hook of task.target_hooks) {
      await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Market Reporter",
          avatar_url: "https://i.imgur.com/UsingCustomIcon.png",
          embeds: [reportEmbed]
        })
      });
    }
    logger.info(`Report Sent`, { type: task.type });
  }
}