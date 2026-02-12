// proxy.js
// 这是一个极简的“二传手”，专门帮 Vencord 绕过 CSP
const http = require('http');

// 你的 Cloudflare Worker 地址 (填你自己的！)
const TARGET_URL = "https://signal-router.wrj5518.workers.dev";

const server = http.createServer(async (req, res) => {
    // 设置 CORS 头，允许 Discord 前端访问本地后端
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // 处理预检请求 (Preflight)
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        
        req.on('end', async () => {
            try {
                console.log("收到 Discord 信号，正在转发给 Cloudflare...");
                
                // 替 Discord 向 Cloudflare 发起请求 (Node.js 不受 CSP 限制)
                const cfResponse = await fetch(TARGET_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: body
                });

                const responseText = await cfResponse.text();
                console.log("转发成功:", responseText);

                res.writeHead(cfResponse.status);
                res.end(responseText);
            } catch (error) {
                console.error("转发失败:", error);
                res.writeHead(500);
                res.end("Proxy Error");
            }
        });
    } else {
        res.end("Only POST allowed");
    }
});

server.listen(3000, '127.0.0.1', () => {
    console.log('🚀 本地代理已启动！监听 http://127.0.0.1:3000');
});