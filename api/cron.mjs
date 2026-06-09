import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export default async function handler(request, response) {
  // 1. 安全读取环境变量
  const UNICOM_COOKIE = process.env.UNICOM_COOKIE;
  const TG_BOT_TOKEN  = process.env.TG_BOT_TOKEN;
  const TG_CHAT_ID    = process.env.TG_CHAT_ID;

  if (!UNICOM_COOKIE || !TG_BOT_TOKEN || !TG_CHAT_ID) {
    return response.status(400).json({
      success: false,
      error: '缺少必要的配置，请在 Vercel 后台配置 UNICOM_COOKIE, TG_BOT_TOKEN 和 TG_CHAT_ID',
    });
  }

  const unicomUrl  = 'https://m.client.10010.com/servicequerybusiness/operationservice/queryOcsPackageFlowLeftContentRevisedInJune';
  const requestBody = 'duanlianjieabc=&channelCode=&serviceType=&saleChannel=&externalSources=&contactCode=&ticket=&ticketPhone=&ticketChannel=&language=chinese';

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15000);

  let browser;

  try {
    // 2. 请求联通接口
    const unicomResponse = await fetch(unicomUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   'android@12.1100',
        'Cookie':       UNICOM_COOKIE,
      },
      body:   requestBody,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!unicomResponse.ok) {
      throw new Error(`联通接口请求失败，状态码: ${unicomResponse.status}`);
    }

    const data = await unicomResponse.json();

    if (data.code !== '0000' && data.code !== '0') {
      throw new Error(`联通接口返回业务错误: ${data.reminder || '未知错误'}`);
    }

    // 3. 基础数据解析
    const packageName = data.packageName || '联通套餐';
    const updateTime  = data.time || new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const ts          = updateTime.length >= 16 ? updateTime.slice(5, 16) : updateTime;

    const flowRes  = data.resources?.find(r => r.type === 'flow');
    const voiceRes = data.resources?.find(r => r.type === 'Voice');

    // MB -> GB，保留两位小数
    const mbToGb = v => (parseFloat(v || 0) / 1024).toFixed(2);

    const flowUsed   = mbToGb(flowRes?.userResource);
    const flowRemain = mbToGb(flowRes?.remainResource);
    const voiceUsed   = voiceRes?.userResource  || '0';
    const voiceRemain = voiceRes?.remainResource || '0';

    // 整体流量使用百分比（用于主进度条）
    const flowUsedMb  = parseFloat(flowRes?.userResource  || 0);
    const flowTotalMb = flowUsedMb + parseFloat(flowRes?.remainResource || 0);
    const flowPct     = flowTotalMb > 0 ? Math.round((flowUsedMb / flowTotalMb) * 100) : 0;

    // 4. 分类收集流量包
    const generalItems = [];
    const carryItems   = [];
    const freeItems    = [];

    flowRes?.details?.forEach(item => {
      // 修正：实际字段是"套内"而非"套餐内"
      const name = (item.addUpItemName || item.feePolicyName || '未知流量包')
        .replace('(上月结转限本月使用)', '')
        .replace('套内国内流量',    '通用流量')
        .replace('套餐内专享免费流量', '专享免流')
        .trim();

      const entry = { name, total: item.total, remain: item.remain, use: item.use };

      if (item.resourceSource === '1') {
        carryItems.push(entry);
      } else if (item.flowType === '2' || parseFloat(item.total) === 0) {
        freeItems.push({ ...entry, unlimited: parseFloat(item.total) === 0 });
      } else {
        generalItems.push(entry);
      }
    });

    data.MlResources?.forEach(res =>
      res.details?.forEach(item => {
        if (parseFloat(item.use) > 0) {
          freeItems.push({
            name:      (item.feePolicyName || '专属定向包') + '（独立控量）',
            use:       item.use,
            unlimited: true,
          });
        }
      })
    );

    // 结转流量：只展示有实际用量的，其余折叠为摘要
    const carryActive    = carryItems.filter(i => parseFloat(i.use) > 0);
    const carryIdleCount = carryItems.length - carryActive.length;

    // 5. HTML 渲染辅助
    const getPct = (use, total) => {
      const t = parseFloat(total);
      if (!t || t <= 0) return 0;
      return Math.min(Math.round((parseFloat(use) / t) * 100), 100);
    };

    const renderItems = (items, barClass) =>
      items.map(item => {
        if (item.unlimited) {
          return `
            <div class="item">
              <div class="item-row">
                <span class="item-name">${item.name}</span>
                <span class="item-val">${mbToGb(item.use)} GB <span class="tag">不限额</span></span>
              </div>
              <div class="bar-bg"><div class="bar-fill ${barClass}" style="width:100%"></div></div>
            </div>`;
        }
        const pct = getPct(item.use, item.total);
        return `
          <div class="item">
            <div class="item-row">
              <span class="item-name">${item.name}</span>
              <span class="item-val">${mbToGb(item.use)} / ${mbToGb(item.total)} GB</span>
            </div>
            <div class="bar-bg"><div class="bar-fill ${barClass}" style="width:${pct}%"></div></div>
          </div>`;
      }).join('');

    // 6. HTML 卡片模板
    const htmlContent = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    background:#07090e;
    font-family:'Noto Sans SC',sans-serif;
    display:flex;justify-content:center;padding:20px
  }
  #widget{
    width:380px;
    background:#0d1117;
    border:1px solid rgba(255,255,255,.07);
    border-radius:20px;padding:22px;color:#fff
  }
  .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
  .brand{font-size:11px;font-weight:700;letter-spacing:2px;color:#3b82f6}
  .ts{font-size:11px;color:rgba(255,255,255,.3)}
  .pkg{
    font-size:13px;color:rgba(255,255,255,.45);margin-bottom:16px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap
  }
  .overview{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
  .stat-box{
    background:rgba(255,255,255,.03);
    border:1px solid rgba(255,255,255,.05);
    border-radius:14px;padding:12px 14px
  }
  .stat-label{font-size:10px;color:rgba(255,255,255,.3);margin-bottom:4px}
  .stat-num{font-size:24px;font-weight:700}
  .stat-unit{font-size:11px;font-weight:400;color:rgba(255,255,255,.35);margin-left:2px}
  .stat-sub{font-size:10px;color:rgba(255,255,255,.22);margin-top:3px}
  .total-bar-wrap{margin-bottom:6px}
  .total-bar-header{
    display:flex;justify-content:space-between;
    font-size:10px;color:rgba(255,255,255,.3);margin-bottom:5px
  }
  .bar-bg{height:4px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden}
  .bar-fill{height:100%;border-radius:4px}
  .bar-blue{background:linear-gradient(90deg,#2563eb,#60a5fa)}
  .bar-pink{background:#ec4899}
  .bar-teal{background:#14b8a6}
  hr{border:none;border-top:1px solid rgba(255,255,255,.05);margin:14px 0}
  .sec-label{
    font-size:10px;font-weight:600;
    color:rgba(255,255,255,.22);
    letter-spacing:1px;text-transform:uppercase;margin-bottom:10px
  }
  .item{margin-bottom:9px}.item:last-child{margin-bottom:0}
  .item-row{display:flex;justify-content:space-between;margin-bottom:4px}
  .item-name{font-size:12px;color:rgba(255,255,255,.6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px}
  .item-val{font-size:12px;font-weight:500;color:rgba(255,255,255,.85);white-space:nowrap}
  .tag{
    font-size:9px;padding:1px 5px;
    background:rgba(20,184,166,.15);color:#14b8a6;
    border-radius:4px;margin-left:4px;vertical-align:middle
  }
  .idle-hint{font-size:11px;color:rgba(255,255,255,.2);margin-top:8px}
  .footer{
    text-align:center;font-size:10px;color:rgba(255,255,255,.1);
    margin-top:16px;border-top:1px solid rgba(255,255,255,.04);
    padding-top:12px;font-style:italic
  }
</style>
</head><body><div id="widget">

  <div class="header">
    <div class="brand">FLOWFETCH</div>
    <div class="ts">${ts}</div>
  </div>
  <div class="pkg">${packageName}</div>

  <div class="overview">
    <div class="stat-box">
      <div class="stat-label">已用流量</div>
      <div class="stat-num" style="color:#3b82f6">${flowUsed}<span class="stat-unit">GB</span></div>
      <div class="stat-sub">剩余 ${flowRemain} GB</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">剩余语音</div>
      <div class="stat-num" style="color:#14b8a6">${voiceRemain}<span class="stat-unit">分钟</span></div>
      <div class="stat-sub">已用 ${voiceUsed} 分钟</div>
    </div>
  </div>

  <div class="total-bar-wrap">
    <div class="total-bar-header">
      <span>流量总使用进度</span>
      <span>${flowPct}%</span>
    </div>
    <div class="bar-bg">
      <div class="bar-fill bar-blue" style="width:${flowPct}%"></div>
    </div>
  </div>

  ${generalItems.length ? `
    <hr>
    <div class="sec-label">通用流量</div>
    ${renderItems(generalItems, 'bar-blue')}
  ` : ''}

  ${carryActive.length || carryIdleCount > 0 ? `
    <hr>
    <div class="sec-label">结转流量</div>
    ${renderItems(carryActive, 'bar-pink')}
    ${carryIdleCount > 0
      ? `<div class="idle-hint">另有 ${carryIdleCount} 个结转包暂未使用</div>`
      : ''}
  ` : ''}

  ${freeItems.length ? `
    <hr>
    <div class="sec-label">定向 / 免流</div>
    ${renderItems(freeItems, 'bar-teal')}
  ` : ''}

  <div class="footer">FlowFetch · 自动推送</div>

</div></body></html>`;

    // 7. 启动无头浏览器截图（browser 声明在 try 外，确保 finally 能关闭）
    browser = await puppeteer.launch({
      args:            chromium.args,
      defaultViewport: { width: 420, height: 800, deviceScaleFactor: 2 },
      executablePath:  await chromium.executablePath(),
      headless:        chromium.headless,
    });

    const page = await browser.newPage();
    // waitUntil: 'networkidle0' 确保 Google Fonts 字体加载完毕再截图
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const widgetElement = await page.$('#widget');
    const imageBuffer   = await widgetElement.screenshot({ type: 'png' });

    // 8. 发送图片至 Telegram
    const tgUrl    = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`;
    const formData = new FormData();
    formData.append('chat_id', TG_CHAT_ID);
    formData.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'flow_status.png');

    const tgResponse = await fetch(tgUrl, { method: 'POST', body: formData });

    if (!tgResponse.ok) {
      const errText = await tgResponse.text();
      throw new Error(`Telegram 图片发送失败: ${errText}`);
    }

    return response.status(200).json({ success: true, message: '卡片已成功推送至 Telegram！' });

  } catch (error) {
    clearTimeout(timeoutId);
    console.error('运行出错:', error);
    return response.status(500).json({ success: false, error: error.message });

  } finally {
    // 无论成功还是报错，都确保浏览器进程被关闭
    await browser?.close();
  }
}
