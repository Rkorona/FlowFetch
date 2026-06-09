// 在 ESM 模式 (type: "module") 下，必须使用 export default 导出
export default async function handler(request, response) {
  // 1. 安全读取环境变量
  const UNICOM_COOKIE = process.env.UNICOM_COOKIE;
  const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
  const TG_CHAT_ID = process.env.TG_CHAT_ID;

  if (!UNICOM_COOKIE || !TG_BOT_TOKEN || !TG_CHAT_ID) {
    return response.status(400).json({ 
      success: false,
      error: "缺少必要的配置，请在 Vercel 后台配置 UNICOM_COOKIE, TG_BOT_TOKEN 和 TG_CHAT_ID" 
    });
  }

  const unicomUrl = "https://m.client.10010.com/servicequerybusiness/operationservice/queryOcsPackageFlowLeftContentRevisedInJune";
  const requestBody = "duanlianjieabc=&channelCode=&serviceType=&saleChannel=&externalSources=&contactCode=&ticket=&ticketPhone=&ticketChannel=&language=chinese";

  // 创建超时控制器：如果 7 秒内联通没有响应，主动断开请求，防止 Vercel 函数 10 秒超时崩溃
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000); 

  try {
    console.log("正在请求联通接口...");
    
    // 2. 请求联通接口
    const unicomResponse = await fetch(unicomUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "android@12.1100",
        "Cookie": UNICOM_COOKIE
      },
      body: requestBody,
      signal: controller.signal // 绑定超时信号
    });

    clearTimeout(timeoutId); // 成功响应，清除定时器

    if (!unicomResponse.ok) {
      throw new Error(`联通接口请求失败，状态码: ${unicomResponse.status}`);
    }

    const data = await unicomResponse.json();

    // 校验联通返回的数据状态
    if (data.code !== "0000" && data.code !== "0") {
      throw new Error(`联通接口返回业务错误: ${data.reminder || '未知错误'}`);
    }

    // 3. 精准解析数据结构
    const packageName = data.packageName || "联通套餐";
    const updateTime = data.time || new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    // 寻找流量和语音资源包
    const flowRes = data.resources?.find(r => r.type === "flow");
    const voiceRes = data.resources?.find(r => r.type === "Voice");

    // 单位转换：MB -> GB (保留两位小数)
    const mbToGb = (mbStr) => (parseFloat(mbStr || 0) / 1024).toFixed(2);

    const flowUsed = mbToGb(flowRes?.userResource);
    const flowRemain = mbToGb(flowRes?.remainResource);

    const voiceUsed = voiceRes?.userResource || "0";
    const voiceRemain = voiceRes?.remainResource || "0";

    // 4. 解析产生消耗的流量明细 (use > 0)
    let activeFlowDetails = [];
    if (flowRes && flowRes.details) {
      activeFlowDetails = flowRes.details
        .filter(item => parseFloat(item.use) > 0)
        .map(item => {
          const usedGB = mbToGb(item.use);
          const name = item.addUpItemName || item.feePolicyName || "未知流量包";
          
          if (parseFloat(item.total) === 0) {
            return `  🔹 ${name}\n       已用: ${usedGB} GB (定向免流)`;
          } else {
            const totalGB = mbToGb(item.total);
            const remainGB = mbToGb(item.remain);
            return `  🔹 ${name}\n       已用: ${usedGB} GB / 剩余: ${remainGB} GB (总 ${totalGB} GB)`;
          }
        });
    }

    // 5. 拼接精美的 Telegram 消息排版
    let tgMessage = `🔔 *FlowFetch 流量与余量自动提醒*\n`;
    tgMessage += `━━━━━━━━━━━━━━━━━━\n`;
    tgMessage += `📦 *当前套餐*：${packageName}\n`;
    tgMessage += `📅 *更新时间*：${updateTime}\n\n`;

    tgMessage += `📊 *整体额度汇总*：\n`;
    tgMessage += `📶 累计已用流量：\`${flowUsed} GB\`\n`;
    tgMessage += `✅ 剩余可用流量：\`${flowRemain} GB\`\n`;
    tgMessage += `📞 剩余通话语音：\`${voiceRemain} 分钟\` (已用 ${voiceUsed} 分)\n\n`;

    if (activeFlowDetails.length > 0) {
      tgMessage += `📈 *动态消耗账单* (本月已产生使用)：\n`;
      tgMessage += activeFlowDetails.join("\n") + "\n";
    }
    tgMessage += `━━━━━━━━━━━━━━━━━━\n`;
    tgMessage += `⚡ _数据来自 FlowFetch 自动化推送_`;

    console.log("正在发送至 Telegram...");
    
    // 6. 发送至 Telegram
    const tgUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    const tgResponse = await fetch(tgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: tgMessage,
        parse_mode: "Markdown"
      })
    });

    if (!tgResponse.ok) {
      const errText = await tgResponse.text();
      throw new Error(`Telegram 发送失败: ${errText}`);
    }

    return response.status(200).json({ 
      success: true, 
      message: "通知成功发送！"
    });

  } catch (error) {
    clearTimeout(timeoutId);
    console.error("运行出错:", error);

    let friendlyMessage = error.message;
    if (error.name === 'AbortError') {
      friendlyMessage = "请求联通接口超时（7秒未响应）。说明 Vercel 的海外 IP 被中国联通防火墙直接拦截/丢包。";
    }

    return response.status(500).json({ 
      success: false, 
      error: friendlyMessage 
    });
  }
}

