import allTickers from './tickers.json';
// 👇 1. 引入新文件
import ambiguousTickers from './ambiguousTickers.json';

// 2. 基础 Ticker 集合
const TICKER_SET = new Set(allTickers);

// 👇 3. 高危词库 (直接使用导入的 JSON 初始化 Set)
const AMBIGUOUS_WORDS = new Set(ambiguousTickers);

// 4. 金融上下文关键词 (Context Boosters)
// (这个暂时保留在代码里，因为它属于策略的一部分，变动频率较低)
const FINANCIAL_CONTEXT = new Set([
  "BUY", "SELL", "LONG", "SHORT", "CALL", "PUT", "OPTION", "STRIKE", "EXPIRY",
  "CHART", "CANDLE", "BREAKOUT", "RESISTANCE", "SUPPORT", "TREND", "VOLUME",
  "EARNINGS", "REPORT", "DIVIDEND", "SPLIT", "IPO", "SEC", "FILING",
  "BULL", "BEAR", "MOON", "DUMP", "PUMP", "TANK", "RIP", "DIP", "ATH", "ATL",
  "PRICE", "COST", "PROFIT", "LOSS", "GAIN", "TRADE", "SWING", "SCALP", "HOLD", "HODL",
  "POS", "POSITION", "ENTRY", "EXIT", "STOP", "LIMIT", "MARKET"
]);

export class TickerEngine {
  static extract(text) {
    if (!text) return [];
    
    const contentUpper = text.toUpperCase();
    const tokens = contentUpper.split(/[\s,.;!?()"[\]{}]+/); 
    const found = new Set();
    
    // --- Step 1: 快速判断是否有金融上下文 ---
    let hasContext = false;
    for (const token of tokens) {
      if (FINANCIAL_CONTEXT.has(token)) {
        hasContext = true;
        break;
      }
    }

    // --- Step 2: 扫描每一个 Token ---
    const regex = /\$?([A-Z]{1,5})\b/g;
    let match;

    while ((match = regex.exec(contentUpper)) !== null) {
      const rawMatch = match[0];
      const symbol = match[1];
      const hasCashTag = rawMatch.startsWith('$');

      // 0. 必须是合法 Ticker
      if (!TICKER_SET.has(symbol)) continue;

      // 1. 如果有 '$' 前缀 -> 直接通过
      if (hasCashTag) {
        found.add(symbol);
        continue;
      }

      // 2. 如果是“安全词” (不在高危列表里) -> 通过
      if (!AMBIGUOUS_WORDS.has(symbol)) {
        if (symbol.length === 1 && !hasContext) continue;
        found.add(symbol);
        continue;
      }

      // 3. 如果是“高危词” -> 需要上下文担保
      if (hasContext) {
        found.add(symbol); 
      }
    }

    return Array.from(found);
  }
}