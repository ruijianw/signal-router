/**
 * Cloudflare Native Logger (D1 Based)
 * 特性:
 * 1. 控制台输出 (方便调试)
 * 2. D1 持久化 (方便回溯)
 * 3. 异步非阻塞 (高性能)
 */

export class Logger {
  /**
   * @param {Env} env - 环境变量 (需要包含 DB)
   * @param {ExecutionContext} ctx - 用于 waitUntil
   */
  constructor(env, ctx) {
    this.env = env;
    this.ctx = ctx;
  }

  /**
   * 核心日志方法
   */
  log(level, message, meta = {}) {
    // 1. 永远打印到控制台 (Wrangler Tail 可见)
    const timestamp = new Date();
    const consoleMsg = `[${timestamp.toISOString()}] [${level}] ${message}`;
    
    if (level === 'ERROR') console.error(consoleMsg, meta);
    else console.log(consoleMsg, meta);

    // 2. 异步写入 D1
    if (this.env.DB) {
      this._saveToD1(level, message, meta, timestamp);
    }
  }

  info(msg, meta) { this.log('INFO', msg, meta); }
  warn(msg, meta) { this.log('WARN', msg, meta); }
  error(msg, meta) { this.log('ERROR', msg, meta); }

  /**
   * 内部方法：写入 D1
   */
  _saveToD1(level, message, meta, dateObj) {
    const timestamp = Math.floor(dateObj.getTime() / 1000);
    // 把 meta 对象转成字符串，防止报错
    const metaStr = meta ? JSON.stringify(meta) : null;

    const stmt = this.env.DB.prepare(
      `INSERT INTO system_logs (level, message, meta, created_at) VALUES (?, ?, ?, ?)`
    ).bind(level, message, metaStr, timestamp);

    // Fire and forget: 不等待写入完成，直接返回响应
    // 只要 Worker 没死，Cloudflare 会在后台完成写入
    this.ctx.waitUntil(stmt.run().catch(err => {
      console.error("🚨 Logger Failed to write to D1:", err);
    }));
  }
}