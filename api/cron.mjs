// FlowFetch/api/cron.mjs
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
    // ── 工具 ────────────────────────────────────
    const bar = (usedMb, totalMb, w = 6) => {
      const total = parseFloat(totalMb);
      if (!total || total <= 0) return null;
      const pct = Math.min(parseFloat(usedMb) / total, 1);
      const filled = Math.round(pct * w);
      return '█'.repeat(filled) + '░'.repeat(w - filled) + ' ' + Math.round(pct * 100) + '%';
    };
    
    // ── 分类收集流量包 ────────────────────────────
    const generalItems = [], carryItems = [], freeItems = [];
    
    flowRes?.details?.forEach(item => {
      const name = (item.addUpItemName || item.feePolicyName || '未知流量包')
        .replace('(上月结转限本月使用)', '').trim();
      const entry = { name, total: item.total, remain: item.remain, use: item.use };
    
      if (item.resourceSource === '1')                              carryItems.push(entry);
      else if (item.flowType === '2' || parseFloat(item.total) === 0) freeItems.push({...entry, unlimited: parseFloat(item.total) === 0});
      else                                                          generalItems.push(entry);
    });
    
    data.MlResources?.forEach(res =>
      res.details?.forEach(item => {
        if (parseFloat(item.use) > 0)
          freeItems.push({ name: (item.feePolicyName || '专属定向包') + '(独立控量)', use: item.use, unlimited: true });
      })
    );
    
    // ── 单行格式化 ───────────────────────────────
    const fmtItem = ({ name, use, total, unlimited }) => {
      if (unlimited)
        return `∙ ${name}   已用 \`${mbToGb(use)} GB\`（不限额）`;
      const b = bar(use, total);
      return `∙ ${name}   \`${mbToGb(use)} / ${mbToGb(total)} GB\`` + (b ? `  ${b}` : '');
    };
    
    // ── 整体进度条 ───────────────────────────────
    const flowUsedMb  = parseFloat(flowRes?.userResource   || 0);
    const flowTotalMb = flowUsedMb + parseFloat(flowRes?.remainResource || 0);
    const overallBar  = bar(flowUsedMb, flowTotalMb, 10) || '';
    
    // ── 组装消息 ─────────────────────────────────
    const ts = updateTime.length >= 16 ? updateTime.slice(5, 16) : updateTime;
    let msg = `*FlowFetch*　\`${ts}\`\n${packageName}\n\n`;
    
    msg += `*流量*　${overallBar}\n`;
    msg += `已用 \`${flowUsed} GB\` · 剩余 \`${flowRemain} GB\`\n\n`;
    msg += `*语音*　剩余 \`${voiceRemain} 分钟\``;
    if (parseInt(voiceUsed) > 0) msg += `　已用 \`${voiceUsed} 分\``;
    msg += '\n';
    
    if (generalItems.length || carryItems.length || freeItems.length) {
      msg += `\n───────────────────\n`;
      if (generalItems.length) msg += `*通用流量*\n` + generalItems.map(fmtItem).join('\n') + '\n';
      if (carryItems.length)   msg += `\n*结转流量*\n` + carryItems.map(fmtItem).join('\n') + '\n';
      if (freeItems.length)    msg += `\n*定向免流*\n` + freeItems.map(fmtItem).join('\n') + '\n';
    }
    
    if ((voiceRes?.details?.length ?? 0) > 1) {
      msg += `\n───────────────────\n*语音明细*\n`;
      voiceRes.details.forEach(({ feePolicyName, addUpItemName, use, total }) => {
        msg += `∙ ${feePolicyName || addUpItemName}　\`${use} / ${total} 分钟\`\n`;
      });
    }
    
    msg += `\n───────────────────\n_FlowFetch 自动推送_`;
        // 6. 发送至 Telegram
    const tgUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    const tgResponse = await fetch(tgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: msg,
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
    return response.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
