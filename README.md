# Signal Router (量化信号路由)

这是一个基于 Cloudflare Workers 构建的生产级量化信号路由系统。它主要用于接收来自不同渠道（如 Discord Vencord 插件）的金融市场消息，自动提取股票代码 (Ticker)，进行 AI 情感分析，并根据配置规则将信号路由到下游服务（如 Discord Webhooks 或 Telegram Bot）。

## 核心功能

1.  **多渠道信号接收**: 支持通过 HTTP POST 接收结构化 JSON 数据。
2.  **智能路由 (KV Config)**: 基于 Cloudflare KV 的动态路由配置。
    *   支持按 `channel_id` 和 `user_id` 过滤。
    *   **Signal 模式**: 高优先级，实时推送到 Discord/Telegram，并存入数据库。
    *   **Analysis 模式**: 中优先级，调用 AI 进行多空情感分析。
    *   **Feed 模式**: 低优先级，仅做数据流记录。
3.  **AI 情感分析**: 集成 Cloudflare Workers AI (`@cf/huggingface/distilbert-sst-2-int8`)，自动判断消息是 **BULLISH** (看多)、**BEARISH** (看空) 还是 **NEUTRAL** (中性)。
4.  **数据持久化 (D1)**: 使用 Cloudflare D1 数据库存储交易信号、分析记录、原始 Feed 以及系统日志。
5.  **定时任务 & 报告**:
    *   Cron 触发器 (每分钟心跳)。
    *   自动生成市场热力图 (Market Heatmap)。
    *   自动生成机构观点汇总 (Institutional Views)。
    *   自动清理过期日志。
6.  **多平台通知**:
    *   **Discord**: 发送带有富文本 (Embeds)、颜色编码 (多绿空红) 和图片预览的 Webhook 消息。
    *   **Telegram**: 发送包含跳转链接和图片的即时消息。

## 技术栈

*   **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/)
*   **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQL)
*   **Config**: [Cloudflare KV](https://developers.cloudflare.com/kv/) (Key-Value Storage)
*   **AI**: [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)
*   **Language**: JavaScript (ES Modules)
*   **Package Manager**: npm

## 快速开始

### 1. 环境准备

确保你已经安装了 [Node.js](https://nodejs.org/) 和 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)。

```bash
npm install
npm install -g wrangler
wrangler login
```

### 2. 配置 Cloudflare 资源

需要在 `wrangler.jsonc` 中配置以下绑定资源：

*   **KV Namespace (`SIGNAL_CONFIG`)**: 用于存储路由规则和定时任务配置。
*   **D1 Database (`DB`)**: 用于存储业务数据。
*   **AI (`AI`)**: 启用 Workers AI 绑定。

### 3. 本地开发

启动本地开发服务器：

```bash
npm run dev
# 或
npx wrangler dev
```

### 4. 部署

部署到 Cloudflare Workers：

```bash
npm run deploy
```

## 配置说明 (KV)

系统依赖 KV 中的 JSON 配置来决定如何处理消息。

### 路由表 (`ROUTING_TABLE`)

```json
[
  {
    "name": "VIP Signals",
    "enabled": true,
    "type": "SIGNAL",
    "match": {
      "channel_id": ["123456789"],
      "user_id": ["987654321"]
    },
    "routes": {
      "discord": ["https://discord.com/api/webhooks/..."],
      "telegram": ["-100123456789"]
    }
  }
]
```

### 定时任务 (`SCHEDULED_TASKS`)

```json
[
  {
    "name": "Hourly Heatmap",
    "enabled": true,
    "type": "TRENDING_FEED",
    "interval": 60,
    "lookback_minutes": 60,
    "min_mentions": 3,
    "target_hooks": ["https://discord.com/api/webhooks/..."]
  }
]
```

## 统一配置归档 (`src/signal_router_config`)

为了简化管理，项目使用 `src/signal_router_config` 文件统一管理 Vencord 插件配置和 Cloudflare KV 路由表。

该文件包含两部分：

1.  **顶部 (Line 1)**: **Vencord 插件转发映射**
    *   格式: `SourceChannelID:TargetChannelID,SourceChannelID:*,...`
    *   用途: 供 Vencord 插件 (如 `MessageLogger` 或自定义脚本) 使用，决定哪些频道的消需要被转发到 Signal Router。
    *   示例: `123456:987654` (将 123456 的消息发给 987654 对应的 Webhook), `123456:*` (广播)。

2.  **底部 (JSON Array)**: **Cloudflare KV 路由表**
    *   用途: `SIGNAL_CONFIG` KV 中的 `ROUTING_TABLE` 值。
    *   作用: Cloudflare Worker 运行时使用此配置来决定如何处理接收到的 HTTP POST 请求（分析、过滤、转发等）。
    *   **部署**: 修改此 JSON 后，需要手动或通过脚本将其更新到 Cloudflare KV 中。

---

## 数据库 Schema (D1)

项目依赖以下数据表 (Schema 示意):

*   `trades`: 存储确认为交易信号的数据。
*   `analysis`: 存储带有 AI情感分析结果的数据。
*   `feeds`: 存储原始信息流。
*   `system_logs`: 系统运行日志。

## 测试

项目使用 `vitest` 进行单元测试。

```bash
npm run test
```
