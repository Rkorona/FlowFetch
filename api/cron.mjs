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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000); 

  try {
    // 2. 请求联通接口
    const unicomResponse = await fetch(unicomUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "android@12.1100",
        "Cookie": UNICOM_COOKIE
      },
      body: requestBody,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!unicomResponse.ok) {
      throw new Error(`联通接口请求失败，状态码: ${unicomResponse.status}`);
    }

    const data = await unicomResponse.json();

    if (data.code !== "0000" && data.code !== "0") {
      throw new Error(`联通接口返回业务错误: ${data.reminder || '未知错误'}`);
    }

    // 3. 基础顶层数据解析
    const packageName = data.packageName || "联通套餐";
    const updateTime = data.time || new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const flowRes = data.resources?.find(r => r.type === "flow");
    const voiceRes = data.resources?.find(r => r.type === "Voice");

    // 单位转换：MB -> GB (保留两位小数)
    const mbToGb = (mbStr) => (parseFloat(mbStr || 0) / 1024).toFixed(2);

    const flowUsed = mbToGb(flowRes?.userResource);
    const flowRemain = mbToGb(flowRes?.remainResource);

    const voiceUsed = voiceRes?.userResource || "0";
    const voiceRemain = voiceRes?.remainResource || "0";

    // 4. 深度拆解子资产包
    let generalText = "";      // 本月通用
    let carryForwardText = ""; // 上月结转
    let directionalText = "";    // 定向免流
    let voiceDetailsText = ""; // 语音明细

    if (flowRes && flowRes.details) {
      flowRes.details.forEach(item => {
        const name = item.addUpItemName || item.feePolicyName || "未知流量包";
        const totalGB = mbToGb(item.total);
        const remainGB = mbToGb(item.remain);
        const usedGB = mbToGb(item.use);

        // A. 上月结转流量 (resourceSource === "1")
        if (item.resourceSource === "1") {
          carryForwardText += `  ⏳ *${name}*\n       已用: \`${usedGB} GB\` | 剩余: \`${remainGB} GB\` / 共 \`${totalGB} GB\`\n`;
        } 
        // B. 定向免流包 (flowType === "2" 或总额度为 0)
        else if (item.flowType === "2" || parseFloat(item.total) === 0) {
          if (parseFloat(item.total) === 0) {
            directionalText += `  🔹 *${name}*\n       已用: \`${usedGB} GB\` (免流不限额)\n`;
          } else {
            directionalText += `  🔹 *${name}*\n       已用: \`${usedGB} GB\` | 剩余: \`${remainGB} GB\` / 共 \`${totalGB} GB\`\n`;
          }
        } 
        // C. 本月通用流量
        else {
          generalText += `  ▫️ *${name}*\n       已用: \`${usedGB} GB\` | 剩余: \`${remainGB} GB\` / 共 \`${totalGB} GB\`\n`;
        }
      });
    }

    // 提取 MlResources 里面的独立应用免流明细 (例如腾讯游戏)
    if (data.MlResources) {
      data.MlResources.forEach(res => {
        res.details?.forEach(item => {
          if (parseFloat(item.use) > 0) {
            const name = item.feePolicyName || "专属定向包";
            const usedGB = mbToGb(item.use);
            directionalText += `  🔹 *${name} (独立控量)*\n       已用: \`${usedGB} GB\`\n`;
          }
        });
      });
    }

    // D. 拆解语音包明细
    if (voiceRes && voiceRes.details) {
      voiceRes.details.forEach(item => {
        const name = item.feePolicyName || item.addUpItemName || "语音包";
        voiceDetailsText += `  🎙️ *${name}*\n       已用: \`${item.use} 分钟\` | 剩余: \`${item.remain} 分钟\` / 共 \`${item.total} 分钟\`\n`;
      });
    }

    // 5. 组装精细化账单排版
    let tgMessage = `🔔 *FlowFetch 全量资产细节明细账单*\n`;
    tgMessage += `━━━━━━━━━━━━━━━━━━\n`;
    tgMessage += `📦 *套餐名称*：${packageName}\n`;
    tgMessage += `📅 *数据时间*：${updateTime}\n\n`;

    tgMessage += `📊 *【 核心资产大盘 】*\n`;
    tgMessage += `📶 累计总已用：\`${flowUsed} GB\`\n`;
    tgMessage += `✅ 核心总剩余：\`${flowRemain} GB\`\n`;
    tgMessage += `📞 语音总剩余：\`${voiceRemain} 分钟\` (已用 ${voiceUsed} 分)\n\n`;

    if (generalText) {
      tgMessage += `🌐 *【 本月通用流量仓 】*\n${generalText}\n`;
    }
    if (carryForwardText) {
      tgMessage += `⏳ *【 上月结转流量仓 】*\n${carryForwardText}\n`;
    }
    if (directionalText) {
      tgMessage += `🎯 *【 定向与专属免流 】*\n${directionalText}\n`;
    }
    if (voiceDetailsText) {
      tgMessage += `📞 *【 语音通话包明细 】*\n${voiceDetailsText}\n`;
    }

    tgMessage += `━━━━━━━━━━━━━━━━━━\n`;
    tgMessage += `⚡ _数据来自 FlowFetch 自动化推送_`;

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
      message: "精细化通知成功发送！"
    });

  } catch (error) {
    clearTimeout(timeoutId);
    console.error("运行出错:", error);
    return response.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}