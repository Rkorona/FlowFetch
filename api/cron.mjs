import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

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

  // 因为要启动 Chromium 截图，超时时间放宽到 15 秒左右更为稳妥
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); 

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

    // 4. 分类收集流量包
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

    // 计算百分比的辅助函数
    const getPct = (use, total) => {
      const t = parseFloat(total);
      if (!t || t <= 0) return 0;
      return Math.min((parseFloat(use) / t) * 100, 100).toFixed(0);
    };

    // 🌟 HTML 渲染模板生成 (高级 iOS 组件风)
    const ts = updateTime.length >= 16 ? updateTime.slice(5, 16) : updateTime;
    
    // 动态生成子流量包的 HTML 行
    const renderRows = (items, typeClass) => {
      return items.map(item => {
        const shortName = item.name.replace('套餐内国内流量', '本月国内').replace('结转套餐内国内流量', '上月结转');
        if (item.unlimited) {
          return `
            <div class="item-row">
              <div class="item-info">
                <span class="item-name">${shortName}</span>
                <span class="item-usage">${mbToGb(item.use)} GB / 不限</span>
              </div>
              <div class="progress-bar-bg"><div class="progress-bar-fill ${typeClass}" style="width: 100%"></div></div>
            </div>`;
        }
        const pct = getPct(item.use, item.total);
        return `
          <div class="item-row">
            <div class="item-info">
              <span class="item-name">${shortName}</span>
              <span class="item-usage">${mbToGb(item.use)} / ${mbToGb(item.total)} GB (${pct}%)</span>
            </div>
            <div class="progress-bar-bg"><div class="progress-bar-fill ${typeClass}" style="width: ${pct}%"></div></div>
          </div>`;
      }).join('');
    };

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          margin: 0; padding: 20px; background: #07090e;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          display: flex; justify-content: center;
        }
        #widget {
          width: 375px; background: linear-gradient(145deg, #121824, #0b0e15);
          border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 24px;
          padding: 24px; color: #fff; box-shadow: 0 20px 40px rgba(0,0,0,0.6); box-sizing: border-box;
        }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .title { font-size: 13px; font-weight: 700; letter-spacing: 1px; color: #3b82f6; text-transform: uppercase; }
        .time { font-size: 11px; color: rgba(255, 255, 255, 0.35); font-variant-numeric: tabular-nums; }
        .package-name { font-size: 16px; font-weight: 600; margin-bottom: 20px; color: #e4e4e7; }
        .overview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 10px; }
        .stat-card { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.04); border-radius: 16px; padding: 14px; }
        .stat-label { font-size: 11px; color: rgba(255, 255, 255, 0.4); margin-bottom: 6px; }
        .stat-value { font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; color: #fff; }
        .stat-sub { font-size: 11px; color: rgba(255, 255, 255, 0.3); margin-top: 4px; font-variant-numeric: tabular-nums; }
        .section-title { font-size: 12px; font-weight: 600; color: rgba(255, 255, 255, 0.3); margin: 20px 0 10px 0; letter-spacing: 0.5px; }
        .item-row { margin-bottom: 12px; }
        .item-info { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 5px; }
        .item-name { color: rgba(255, 255, 255, 0.7); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .item-usage { font-variant-numeric: tabular-nums; font-weight: 500; color: rgba(255, 255, 255, 0.9); }
        .progress-bar-bg { height: 5px; background: rgba(255, 255, 255, 0.06); border-radius: 3px; overflow: hidden; }
        .progress-bar-fill { height: 100%; border-radius: 3px; }
        .bg-general { background: linear-gradient(90deg, #3b82f6, #1d4ed8); }
        .bg-carry { background: linear-gradient(90deg, #ec4899, #be185d); }
        .bg-free { background: linear-gradient(90deg, #10b981, #047857); }
        .footer { text-align: center; font-size: 10px; color: rgba(255, 255, 255, 0.15); margin-top: 20px; border-top: 1px solid rgba(255, 255, 255, 0.04); padding-top: 12px; font-style: italic; }
      </style>
    </head>
    <body>
      <div id="widget">
        <div class="header">
          <div class="title">FlowFetch Dashboard</div>
          <div class="time">${ts}</div>
        </div>
        <div class="package-name">${packageName}</div>
        
        <div class="overview-grid">
          <div class="stat-card">
            <div class="stat-label">已用 / 剩余流量</div>
            <div class="stat-value" style="color: #3b82f6;">${flowUsed} <span style="font-size:12px;font-weight:normal;">GB</span></div>
            <div class="stat-sub">剩余 ${flowRemain} GB</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">剩余 / 总语音</div>
            <div class="stat-value" style="color: #10b981;">${voiceRemain} <span style="font-size:12px;font-weight:normal;">分钟</span></div>
            <div class="stat-sub">已用 ${voiceUsed} 分钟</div>
          </div>
        </div>

        ${generalItems.length ? `<div class="section-title">通用流量明细</div>${renderRows(generalItems, 'bg-general')}` : ''}
        ${carryItems.length ? `<div class="section-title">结转流量明细</div>${renderRows(carryItems, 'bg-carry')}` : ''}
        ${freeItems.length ? `<div class="section-title">定向/免流明细</div>${renderRows(freeItems, 'bg-free')}` : ''}

        <div class="footer">FlowFetch Automated Push</div>
      </div>
    </body>
    </html>`;

    // 5. 核心：启动无头浏览器并进行精准 DOM 截图
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 420, height: 800, deviceScaleFactor: 2 }, // deviceScaleFactor: 2 确保生成的是高清视网膜视效图，防止文字发虚
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setContent(htmlContent);
    
    // 只截取 #widget 这个卡片节点，避免周围出现空白
    const widgetElement = await page.$('#widget');
    const imageBuffer = await widgetElement.screenshot({ type: 'png' });
    await browser.close();

    // 6. 将图片流封装为 FormData 发送至 Telegram (sendPhoto)
    const tgUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`;
    const formData = new FormData();
    formData.append('chat_id', TG_CHAT_ID);
    
    // 利用 Node 原生 Blob 转化二进制流，无需引入第三方 form-data 库
    const imageBlob = new Blob([imageBuffer], { type: 'image/png' });
    formData.append('photo', imageBlob, 'flow_status.png');

    const tgResponse = await fetch(tgUrl, {
      method: "POST",
      body: formData
    });

    if (!tgResponse.ok) {
      const errText = await tgResponse.text();
      throw new Error(`Telegram 图片发送失败: ${errText}`);
    }

    return response.status(200).json({ 
      success: true, 
      message: "精美卡片已成功推送至 Telegram！"
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

