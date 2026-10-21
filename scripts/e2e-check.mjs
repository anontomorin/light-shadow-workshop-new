/**
 * 端到端冒烟测试（Node + Chrome DevTools Protocol，无需额外依赖）。
 *
 * 验证内容：
 *   1. 页面无 JS 异常；
 *   2. WebGL 场景正常初始化（未落到降级错误页）；
 *   3. 标题页 → 二级入口「光影挑战」→ 关卡页 → 游戏页的流程可走通，
 *      且影形解谜 / 自由实验室确实已从首页收起（藏入二级入口）；
 *   3b. 首页右侧三扇花窗按真实纹样轮播，朱砂印章的题名随之同步更换；
 *      全局字体为**系统本地**的宋体（正文）/ 楷体（标题），不加载任何网络字体；
 *   4. 观看视角可切换（预设 / 滑杆 / 越界夹紧 / 复位）；
 *   5. 真实鼠标拖动会改变物体位置并实时刷新匹配度；
 *   6. 目标状态能够真正触发通关（走完整投影 + IoU 校验，且需连续 3 次达标）；
 *   7. 十个关卡（含四道经典花窗题目）都能进入、渲染并可解；
 *   8. 自由实验室可进入、添加 / 拖动 / 删除 / 重置物体、切换视角并返回，
 *      并校验 13 种形状（含十字 / 五角星 / 圆环三个带镂空的凹形）可用；
 *   9. 花窗工坊：**版面（三维操作区居中且最宽、侧栏可收起、工具栏不压画布）**、
 *      操作指引卡（四步上手 + 真实键位表）、模板切换 / 参数重建 / 自绘窗棂 /
 *      **绘制模式（用真实鼠标事件走一遍：进入 → 悬停预览 → 节点标识 →
 *      按钮退出 / Esc 退出 → 退出后仍能点选窗格）** /
 *      引导实验 / 作品保存 / PNG 海报导出，
 *      且投影确实随窗格位置变化（证明是几何投影而非固定图）；
 *  10. 纹样图鉴与文化来源链接可追溯；
 *  11. 生产构建不暴露调试钩子（见 scripts/check-prod-hook.mjs）。
 *
 * 运行：node scripts/e2e-check.mjs   （需要先启动 npm run dev）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const URL_BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const PORT = 9333;
const OUT_DIR = join(process.cwd(), 'docs', 'shots');
/** 首屏等待：本地为毫秒级，线上经代理加载 560KB 的包可能需要十几秒 */
const BOOT_WAIT = Number(process.env.E2E_BOOT_WAIT ?? 2500);
const RELOAD_WAIT = Number(process.env.E2E_RELOAD_WAIT ?? 2400);
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

let chromeProc = null;
let ws = null;
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const pageExceptions = [];

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`evaluate 失败：${res.exceptionDetails.text} ${res.result?.description ?? ''}`);
  }
  return res.result?.value;
}

/**
 * 轮询等待页面内表达式变为真值。
 * 刷新/首次加载后应用需要一段时间才把 window.__lightShadow 挂上，
 * 定长 sleep 在慢网络下不够可靠，故改为轮询直到就绪或超时。
 */
async function waitFor(expression, timeoutMs = 15000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      /* 页面可能正在导航，忽略后重试 */
    }
    await sleep(intervalMs);
  }
  return false;
}

/**
 * 把屏幕坐标夹到一个"UI 覆盖层之外"的安全拖动区。
 *
 * 舞台顶部叠着教程提示条（.tutorial-bar）、顶部栏（.game-topbar），
 * 底部叠着操作坞（.game-dock）。用 screenPos() 算出的物体屏幕坐标可能正好
 * 落在这些浮层上——此时鼠标事件被浮层吃掉，物体会"纹丝不动"，
 * 表现为一段假失败（应用本身没有问题）。
 * 因此拖动测试统一把起点夹进画布中段：y ∈ [150, 视口高 - 190]。
 */
async function safeStagePoint(x, y) {
  const vp = await evaluate(`JSON.stringify({ w: innerWidth, h: innerHeight })`);
  const { w, h } = JSON.parse(vp);
  const padX = 40;
  return {
    x: Math.min(Math.max(x, padX), w - padX),
    y: Math.min(Math.max(y, 150), h - 190),
  };
}

async function screenshot(name) {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(res.data, 'base64'));
  console.log(`  · 截图已保存 docs/shots/${name}.png`);
  return file;
}

async function mouse(type, x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button,
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
  });
}

/**
 * 读取画布像素并统计颜色分布。
 * 通过 CDP 直接抓画布位图，避免受页面上其它 DOM 干扰。
 * 返回影子主题色（#31455a 附近）与目标描边色（#1f7f96 附近）的像素数。
 */
async function wallPixelStats(x0, y0, x1, y1) {
  const res = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: 1 },
  });
  // PNG 只在内存里传给页面（data URL），不落盘：
  // 临时文件一旦残留会被 git status 当作未跟踪文件，污染仓库。
  const stats = await evaluateWithPng(
    `(async (dataUrl) => {
      const blob = await (await fetch(dataUrl)).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      // 影子主题色 #31455a → (49, 69, 90)；目标描边 #1f7f96 → (31, 127, 150)
      const nearShadow = (r, g, b) => Math.abs(r - 49) < 46 && Math.abs(g - 69) < 46 && Math.abs(b - 90) < 46 && b > r;
      const nearStroke = (r, g, b) => Math.abs(r - 31) < 30 && Math.abs(g - 127) < 30 && Math.abs(b - 150) < 30;
      const w = bmp.width;
      const h = bmp.height;
      const isShadow = new Uint8Array(w * h);
      let shadowCount = 0;
      let strokeCount = 0;
      for (let p = 0, i = 0; p < w * h; p++, i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (nearStroke(r, g, b)) strokeCount++;
        if (!nearShadow(r, g, b)) continue;
        isShadow[p] = 1;
        shadowCount++;
      }
      // 只统计"内部"像素（四邻域也是影子）：边缘一圈是画布抗锯齿产生的过渡色，
      // 与"半透明叠加造成的接缝"无关。真正的接缝会形成成片的内部色差，仍会被抓住。
      const buckets = new Map();
      let interior = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * w + x;
          if (!isShadow[p]) continue;
          if (!isShadow[p - 1] || !isShadow[p + 1] || !isShadow[p - w] || !isShadow[p + w]) continue;
          interior++;
          const i = p * 4;
          const key = (d[i] >> 2) + ',' + (d[i + 1] >> 2) + ',' + (d[i + 2] >> 2);
          buckets.set(key, (buckets.get(key) || 0) + 1);
        }
      }
      // 只把"成片"的色差算作接缝：单个物件的硬边/高光零散像素不算。
      // 真正的半透明叠加会在重叠区形成一大块明显更深的颜色，占比远超 2%。
      const minShare = Math.max(8, Math.floor(interior * 0.02));
      const solid = [...buckets.entries()].filter(([, n]) => n >= minShare).sort((a, b) => b[1] - a[1]);
      const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
      return { count: shadowCount, distinct: solid.length, interior, strokeCount, top };
    })`,
    `data:image/png;base64,${res.data}`,
  );
  return stats;
}

/** 调用页面内的异步函数并注入一个 base64 图片数据，避免受本地文件权限限制 */
async function evaluateWithPng(expression, dataUrl) {
  const res = await send('Runtime.evaluate', {
    expression: `(${expression})(${JSON.stringify(dataUrl)})`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`evaluate 失败：${res.exceptionDetails.text} ${res.result?.description ?? ''}`);
  }
  return res.result?.value;
}

/** 在渲染中插入一个可读的检查点，等待若干帧 */
const waitFrames = (n = 12) =>
  evaluate(
    `new Promise((r) => { let i = 0; const t = () => (++i >= ${n} ? r(true) : requestAnimationFrame(t)); requestAnimationFrame(t); })`,
  );

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const chrome = findChrome();
  if (!chrome) throw new Error('未找到 Chrome / Edge 可执行文件');
  console.log(`使用浏览器：${chrome}`);

  const userDataDir = join(tmpdir(), `lsw-e2e-${Date.now()}`);
  chromeProc = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--hide-scrollbars',
      '--window-size=1440,900',
      '--no-first-run',
      '--no-default-browser-check',
      // 线上复测时禁用磁盘缓存：Pages 的 CDN 可能仍返回上一版 bundle，
      // 导致"本地已改好但线上测出的还是旧行为"这种假失败。
      '--disable-application-cache',
      '--disable-http-cache',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  // 等待调试端口就绪
  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) {
        version = await r.json();
        break;
      }
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  if (!version) throw new Error('Chrome 调试端口未就绪');
  console.log(`浏览器版本：${version.Browser}`);

  const listRes = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await listRes.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到页面目标');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`));
      else resolve(msg.result ?? {});
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageExceptions.push(msg.params.exceptionDetails?.exception?.description ?? 'unknown');
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const results = [];
  const check = (label, ok, detail = '') => {
    results.push({ label, ok, detail });
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `：${detail}` : ''}`);
  };

  // ── 1. 打开页面 ──────────────────────────────────────────
  console.log('\n[1] 打开页面');
  await send('Page.navigate', { url: URL_BASE });
  await sleep(BOOT_WAIT);
  const booted = await waitFor(`!!window.__lightShadow`, 25000);
  check('应用启动并挂载调试接口', booted === true);
  await waitFrames(20);

  const hasTitle = await evaluate(`!!document.querySelector('.title-main')`);
  check('标题页渲染', hasTitle === true);
  const fatal = await evaluate(`!!document.querySelector('.fatal-error')`);
  check('未落入 WebGL 降级页', fatal === false);
  await screenshot('01-title');

  // ── 1b. 首页花窗轮播与中国风字体 ──
  console.log('\n[1b] 首页花窗轮播与中国风字体');
  const heroFrames = await evaluate(`document.querySelectorAll('.hero-frame').length`);
  check('首页右侧有三扇花窗（轮播）', heroFrames === 3, `帧数=${heroFrames}`);
  check(
    '轮播同一时刻只有一扇处于激活态',
    (await evaluate(`document.querySelectorAll('.hero-frame.is-active').length`)) === 1,
  );

  const heroInfo = JSON.parse(
    (await evaluate(
      `JSON.stringify({
        caption: document.querySelector('.hero-caption')?.textContent?.trim() ?? '',
        polys: [...document.querySelectorAll('.hero-frame')].map((f) => f.querySelectorAll('polygon').length),
        dots: document.querySelectorAll('.hero-dot').length,
        names: [...document.querySelectorAll('.hero-dot')].map((d) => d.getAttribute('aria-label') ?? ''),
      })`,
    )) ?? '{}',
  );
  check(
    '三扇花窗都由纹样生成器实际绘制（SVG 非空）',
    Array.isArray(heroInfo.polys) && heroInfo.polys.length === 3 && heroInfo.polys.every((n) => n > 0),
    `多边形数=${heroInfo.polys?.join(' / ')}`,
  );
  check(
    '三扇窗分别是步步锦 / 冰裂纹 / 三交六椀菱花',
    JSON.stringify(heroInfo.names) === JSON.stringify(['步步锦', '冰裂纹', '三交六椀菱花']),
    heroInfo.names?.join(' / '),
  );
  // 印章题名必须与**当前激活的那一帧**一致。
  // 注意不要写成 `seal === '步步锦'`：轮播是 4.2 秒自动切换的，
  // 页面一慢（例如同时跑别的无头 Chrome）就会切到第二扇，那条断言会假失败。
  // 这里断言的是不变式"印章 == 当前帧的样式名"，并在换字动画（.is-swapping 淡出 220ms）结束后再读。
  const readSeal = async () =>
    JSON.parse(
      await evaluate(
        `JSON.stringify((() => {
           const frames = [...document.querySelectorAll('.hero-frame')];
           const idx = frames.findIndex((f) => f.classList.contains('is-active'));
           const dot = document.querySelectorAll('.hero-dot')[idx];
           const seal = document.querySelector('.title-seal');
           return {
             idx,
             expect: dot ? dot.getAttribute('aria-label') ?? '' : '',
             seal: seal ? seal.textContent.trim() : '',
             swapping: seal ? seal.classList.contains('is-swapping') : false,
           };
         })())`,
      ),
    );
  let sealOk = false;
  let sealMsg = '';
  for (let i = 0; i < 14; i++) {
    const s = await readSeal();
    sealMsg = `帧${s.idx} 印章="${s.seal}" 当前样式名="${s.expect}"${s.swapping ? '（换字动画中）' : ''}`;
    if (!s.swapping && s.expect && s.seal === s.expect) {
      sealOk = true;
      break;
    }
    await sleep(200);
  }
  check('朱砂印章显示的是当前窗棂样式名（与当前帧一致）', sealOk, sealMsg);
  check(
    '底部说明行标注当前纹样全名',
    typeof heroInfo.caption === 'string' && heroInfo.caption.includes('窗格示意图由纹样生成器实时绘制'),
    heroInfo.caption,
  );
  check('三扇窗对应三个指示点', heroInfo.dots === 3, `点数=${heroInfo.dots}`);

  // 点第三个指示点 → 立刻切到第三扇；印章要淡出 140ms 后才落新题名，等 700ms 再读
  const dotActive = await evaluate(
    `(() => { document.querySelectorAll('.hero-dot')[2].click(); return [...document.querySelectorAll('.hero-frame')].findIndex((f) => f.classList.contains('is-active')); })()`,
  );
  check('点击指示点会立刻切换花窗', dotActive === 2, `activeIndex=${dotActive}`);
  // 轮播可能在等待期间自动切到下一扇，因此断言的是"印章仍与当前帧一致"这一不变式，
  // 而不是硬编码某个纹样名（否则页面稍慢就会假失败）。
  let sealAfter = '';
  let sealAfterOk = false;
  for (let i = 0; i < 8; i++) {
    await sleep(180);
    const s = await readSeal();
    sealAfter = `帧${s.idx} 印章="${s.seal}" 当前样式名="${s.expect}"`;
    if (!s.swapping && s.expect && s.seal === s.expect) {
      sealAfterOk = true;
      break;
    }
  }
  check('印章题名随花窗同步更换', sealAfterOk, sealAfter);

  // 字体：断言 CSS 令牌本身（稳定），再断言正文没有回退到黑体栈
  const fontVars = JSON.parse(
    (await evaluate(
      `(() => { const cs = getComputedStyle(document.documentElement); return JSON.stringify({ body: getComputedStyle(document.body).fontFamily, bodyVar: cs.getPropertyValue('--font'), titleVar: cs.getPropertyValue('--font-title') }); })()`,
    )) ?? '{}',
  );
  check('正文使用宋体系（中国风）', /Songti|STSong|SimSun/.test(fontVars.bodyVar ?? ''), fontVars.bodyVar?.trim());
  check(
    '标题使用内嵌毛笔楷书（并保留楷体回退）',
    /Ma Shan Zheng/.test(fontVars.titleVar ?? '') && /Kaiti|STKaiti|KaiTi/.test(fontVars.titleVar ?? ''),
    fontVars.titleVar?.trim(),
  );
  check(
    '正文没有回退到黑体栈',
    /PingFang|Microsoft YaHei|system-ui/.test(fontVars.body ?? '') === false,
    fontVars.body ?? '',
  );
  const fontInfo = JSON.parse(
    (await evaluate(
      `(async () => { await document.fonts.ready; return JSON.stringify({ count: document.fonts.size, msz: document.fonts.check('24px "Ma Shan Zheng"', '光影工坊'), zcool: document.fonts.check('16px "ZCOOL XiaoWei"', '光影工坊') }); })()`,
    )) ?? '{}',
  );
  check('内嵌主题字体已声明（离线可用）', (fontInfo.count ?? 0) >= 2, `@font-face 数=${fontInfo.count}`);
  check(
    '内嵌字体已成功加载',
    fontInfo.msz === true && fontInfo.zcool === true,
    `马善政=${fontInfo.msz} / 站酷小薇=${fontInfo.zcool}`,
  );

  // ── 2. 标题页与二级入口 ──────────────────────────────────
  console.log('\n[2] 标题页与二级入口');
  const titleLabels = JSON.parse(
    (await evaluate(
      `JSON.stringify([...document.querySelectorAll('.title-actions .btn')].map((b) => b.textContent.trim()))`,
    )) ?? '[]',
  );
  check('标题页提供四个一级入口', titleLabels.length === 4, titleLabels.join(' / '));
  check(
    '花窗工坊是首页主入口（列在第一位）',
    (titleLabels[0] ?? '').includes('花窗工坊'),
    titleLabels[0] ?? '（缺失）',
  );
  check(
    '影形解谜已从首页收起（藏入二级入口）',
    titleLabels.some((t) => t.includes('影形解谜')) === false,
  );
  check(
    '自由实验室已从首页收起（藏入二级入口）',
    titleLabels.some((t) => t.includes('实验室')) === false,
  );

  const intoModes = await evaluate(
    `(() => { const b = [...document.querySelectorAll('.title-actions .btn')].find((x) => x.textContent.includes('光影挑战')); if (!b) return false; b.click(); return true; })()`,
  );
  check('标题页存在「光影挑战」入口', intoModes === true);
  await sleep(800);
  await waitFrames(10);
  check(
    '可进入二级入口页「光影挑战」',
    (await evaluate(`!!document.querySelector('.mode-screen')`)) === true,
  );
  const modeCards = await evaluate(`document.querySelectorAll('.mode-screen .mode-card').length`);
  check('二级入口列出两个玩法卡片', modeCards === 2, `卡片数=${modeCards}`);
  check(
    '二级入口同时提供影形解谜与自由实验室',
    (await evaluate(
      `!!document.querySelector('.mode-screen .mode-card.mode-levels') && !!document.querySelector('.mode-screen .mode-card.mode-lab')`,
    )) === true,
  );
  const modeTitles = JSON.parse(
    (await evaluate(
      `JSON.stringify([...document.querySelectorAll('.mode-screen .mode-title')].map((e) => e.textContent.trim()))`,
    )) ?? '[]',
  );
  check(
    '两个玩法卡片分别是「影形解谜」「自由实验室」',
    modeTitles.includes('影形解谜') && modeTitles.includes('自由实验室'),
    modeTitles.join(' / '),
  );
  await screenshot('02-mode-select');

  // 从二级入口进入关卡选择
  const intoLevels = await evaluate(
    `(() => { const b = document.querySelector('.mode-screen .mode-card.mode-levels .mode-actions .btn'); if (!b) return false; b.click(); return true; })()`,
  );
  check('可从二级入口进入影形解谜', intoLevels === true);
  await sleep(700);
  await waitFrames(10);
  const cardCount = await evaluate(`document.querySelectorAll('.level-card').length`);
  check('关卡卡片数量为 10', cardCount === 10, `实际 ${cardCount}`);
  const lockedCount = await evaluate(`document.querySelectorAll('.level-card.locked').length`);
  check('初始仅解锁第 1 关', lockedCount === 9, `锁定 ${lockedCount} 个`);
  const groupTitles = JSON.parse(
    (await evaluate(
      `JSON.stringify([...document.querySelectorAll('.level-group-title h2, .level-group-title .level-group-name, .level-group-title span')].map((e) => e.textContent.trim()).filter(Boolean))`,
    )) ?? '[]',
  );
  check('关卡按主题分组呈现', groupTitles.length >= 2, groupTitles.join(' / '));
  const latticeCount = await evaluate(
    `[...document.querySelectorAll('.level-card .lv-tag')].filter((t) => t.textContent.includes('花窗')).length`,
  );
  check('四道经典花窗题目已进入关卡列表', latticeCount === 4, `花窗题目=${latticeCount}`);
  await screenshot('02-level-select');

  // ── 3. 进入第 1 关 ──────────────────────────────────────
  console.log('\n[3] 进入第 1 关');
  await evaluate(`document.querySelector('.level-card').click()`);
  await sleep(1800);
  await waitFrames(20);
  check('三维画布已挂载', (await evaluate(`!!document.querySelector('canvas')`)) === true);
  const webgl = await evaluate(
    `(() => { const c = document.querySelector('canvas'); if (!c) return null; return !!(c.getContext('webgl2') || c.getContext('webgl')); })()`,
  ).catch(() => null);
  check('WebGL 上下文可用', webgl === true);
  const state1 = await evaluate(`window.__lightShadow.getState()`);
  check('已进入第 1 关', state1?.levelId === 1, `levelId=${state1?.levelId}`);
  const initialIou = await evaluate(`window.__lightShadow.score()`);
  check('初始匹配度低于阈值', initialIou < 0.6, `IoU=${initialIou.toFixed(3)}`);
  const shadowMesh = await evaluate(`window.__lightShadow.getState().objects.length`);
  check('关卡物体已加载', shadowMesh === 1, `物体数=${shadowMesh}`);
  await screenshot('03-level1-initial');

  // ── 3b. 观看视角 ────────────────────────────────────────
  console.log('\n[3b] 观看视角');
  /** 按滑杆标签设置数值（避免依赖 DOM 顺序） */
  const setSliderByLabel = (label, value) =>
    evaluate(
      `(() => {
        const row = [...document.querySelectorAll('.slider-row')].find(
          (r) => r.querySelector('label') && r.querySelector('label').textContent.trim() === ${JSON.stringify(label)},
        );
        if (!row) return null;
        const input = row.querySelector('input[type=range]');
        input.value = String(${value});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return Number(input.value);
      })()`,
    );

  const view0 = await evaluate(`window.__lightShadow.getView()`);
  check(
    '取得默认视角',
    !!view0 && view0.distance > 10,
    view0
      ? `水平 ${view0.azimuth.toFixed(1)}° / 俯仰 ${view0.elevation.toFixed(1)}° / 距离 ${view0.distance.toFixed(1)}`
      : 'null',
  );

  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.preset-group .btn')].find(x => x.textContent.trim() === '正视'); if (b) b.click(); })()`,
  );
  await sleep(400);
  await waitFrames(6);
  const viewFront = await evaluate(`window.__lightShadow.getView()`);
  check('预设视角可切换到正视', Math.abs(viewFront.azimuth) < 0.6, `水平角=${viewFront.azimuth.toFixed(2)}°`);
  await screenshot('03b-view-front');

  const clamped = await evaluate(
    `window.__lightShadow.setView({ azimuth: 999, elevation: -50, distance: 1 })`,
  );
  check(
    '越界视角被夹紧在合法范围',
    Math.abs(clamped.azimuth - 80) < 0.01 &&
      Math.abs(clamped.elevation - 8) < 0.01 &&
      Math.abs(clamped.distance - 13) < 0.01,
    `水平 ${clamped.azimuth}° / 俯仰 ${clamped.elevation}° / 距离 ${clamped.distance}`,
  );

  const sliderValue = await setSliderByLabel('水平角', -20);
  await sleep(400);
  const viewSlider = await evaluate(`window.__lightShadow.getView()`);
  check(
    '视角滑杆可改变水平角',
    sliderValue !== null && Math.abs(viewSlider.azimuth - -20) < 1.5,
    `滑杆=${sliderValue} → 水平角=${viewSlider.azimuth.toFixed(2)}°`,
  );

  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.btn')].find(x => x.textContent.trim() === '复位视角'); if (b) b.click(); })()`,
  );
  await sleep(400);
  const viewBack = await evaluate(`window.__lightShadow.getView()`);
  check(
    '复位视角回到默认机位',
    Math.abs(viewBack.azimuth - view0.azimuth) < 1 && Math.abs(viewBack.distance - view0.distance) < 0.5,
    `水平角=${viewBack.azimuth.toFixed(2)}°`,
  );

  // ── 3c. 左键拖动空白处 = 环绕视角 ────────────────────────
  console.log('\n[3c] 左键拖动改变观看视角');
  const orbitBefore = await evaluate(`window.__lightShadow.getView()`);
  // 在画布内搜索一个"既不会命中物体、也没有被任何浮层盖住"的空白点。
  // 两个条件缺一不可：
  //   · hitTest 为假 —— 避免"以为在拖空白，其实点到了物体"；
  //   · elementFromPoint 恰好是画布本身 —— 顶部栏 / 教程条 / 侧栏 / 操作坞
  //     都会吃掉鼠标事件，落在那上面拖动时相机会"纹丝不动"（假失败）。
  //     这正是 safeStagePoint() 想解决的问题，这里把安全区直接用进搜索。
  const blank = await evaluate(
    `(() => {
      const c = document.querySelector('.stage canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      const lo = Math.max(r.top + 4, 150);
      const hi = Math.min(r.bottom - 4, innerHeight - 190);
      if (!(hi > lo)) return null;
      for (const fy of [0.1, 0.25, 0.4, 0.6, 0.8, 0.95]) {
        for (const fx of [0.06, 0.14, 0.86, 0.94]) {
          const x = r.left + r.width * fx;
          const y = lo + (hi - lo) * fy;
          if (document.elementFromPoint(x, y) !== c) continue;
          if (!window.__lightShadow.hitTest(x, y)) return { x, y };
        }
      }
      return null;
    })()`,
  );
  check('找到用于环绕的空白位置', !!blank, blank ? `(${blank.x.toFixed(0)}, ${blank.y.toFixed(0)})` : 'null');
  const bx = blank.x;
  const by = blank.y;
  await mouse('mousePressed', bx, by);
  await sleep(80);
  for (let i = 1; i <= 14; i++) {
    await mouse('mouseMoved', bx + i * 9, by - i * 2);
    await sleep(22);
  }
  await mouse('mouseReleased', bx + 14 * 9, by - 14 * 2);
  await sleep(320);
  await waitFrames(6);
  const orbitAfter = await evaluate(`window.__lightShadow.getView()`);
  check(
    '左键拖动空白处可环绕观看视角',
    Math.abs(orbitAfter.azimuth - orbitBefore.azimuth) > 5,
    `水平角 ${orbitBefore.azimuth.toFixed(1)}° → ${orbitAfter.azimuth.toFixed(1)}°`,
  );

  // 俯仰方向：向左下拖动应抬高相机（俯仰角增大）
  const elevBefore = await evaluate(`window.__lightShadow.getView()`);
  await mouse('mousePressed', blank.x, blank.y);
  await sleep(80);
  for (let i = 1; i <= 12; i++) {
    await mouse('mouseMoved', blank.x, blank.y + i * 8);
    await sleep(22);
  }
  await mouse('mouseReleased', blank.x, blank.y + 12 * 8);
  await sleep(320);
  await waitFrames(6);
  const elevAfter = await evaluate(`window.__lightShadow.getView()`);
  check(
    '向下拖动抬高俯仰角（视线更俯视）',
    elevAfter.elevation > elevBefore.elevation + 5,
    `俯仰角 ${elevBefore.elevation.toFixed(1)}° → ${elevAfter.elevation.toFixed(1)}°`,
  );
  const orbitObjectBefore = await evaluate(`window.__lightShadow.getState().objects[0].transform`);
  check(
    '环绕视角不会误移动物体',
    Math.abs(orbitObjectBefore.x - state1.objects[0].transform.x) < 0.02 &&
      Math.abs(orbitObjectBefore.y - state1.objects[0].transform.y) < 0.02,
    `x=${orbitObjectBefore.x.toFixed(2)}, y=${orbitObjectBefore.y.toFixed(2)}`,
  );
  await screenshot('03c-orbited');
  // 回到默认机位，后续拖动检查仍以初始视角进行
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.btn')].find(x => x.textContent.trim() === '复位视角'); if (b) b.click(); })()`,
  );
  await sleep(400);
  await waitFrames(6);

  // ── 4. 真实鼠标拖动 ─────────────────────────────────────
  console.log('\n[4] 真实鼠标拖动');
  const objId = state1.objects[0].id;
  const p0Raw = await evaluate(`window.__lightShadow.screenPos(${JSON.stringify(objId)})`);
  const pT = await evaluate(`window.__lightShadow.targetScreenPos(${JSON.stringify(objId)})`);
  check('取得物体与目标的屏幕坐标', !!p0Raw && !!pT,
    p0Raw && pT ? `物体(${p0Raw.x.toFixed(0)}, ${p0Raw.y.toFixed(0)}) → 目标(${pT.x.toFixed(0)}, ${pT.y.toFixed(0)})` : 'null');

  // screenPos 是纯数学投影，起点若落在教程提示条/顶部栏/操作坞上，
  // 鼠标事件会被浮层截获，物体不动（假失败）。夹进安全拖动区。
  const p0 = p0Raw ? await safeStagePoint(p0Raw.x, p0Raw.y) : null;
  if (p0 && (p0.x !== p0Raw.x || p0.y !== p0Raw.y)) {
    console.log(`  · 拖动起点已夹进安全区：(${p0Raw.x.toFixed(0)}, ${p0Raw.y.toFixed(0)}) → (${p0.x.toFixed(0)}, ${p0.y.toFixed(0)})`);
  }

  const iouBeforeDrag = await evaluate(`window.__lightShadow.score()`);
  await mouse('mousePressed', p0.x, p0.y);
  await sleep(150);

  // 分步拖向目标，期间采样匹配度，验证"影子实时跟随"
  const steps = 26;
  const samples = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await mouse('mouseMoved', p0.x + (pT.x - p0.x) * t, p0.y + (pT.y - p0.y) * t);
    await sleep(28);
    if (i % 5 === 0) samples.push(await evaluate(`window.__lightShadow.score()`));
  }
  await mouse('mouseReleased', pT.x, pT.y);
  await sleep(1200);
  await waitFrames(12);

  const after = await evaluate(`window.__lightShadow.getState().objects[0].transform`);
  const moved = Math.abs(after.x - state1.objects[0].transform.x) > 0.05;
  check('拖动改变了物体位置', moved,
    `x: ${state1.objects[0].transform.x.toFixed(2)} → ${after.x.toFixed(2)}, y: ${state1.objects[0].transform.y.toFixed(2)} → ${after.y.toFixed(2)}`);

  const maxSample = Math.max(...samples);
  check('影子随拖动实时变化', maxSample > iouBeforeDrag,
    `拖动中匹配度采样 ${samples.map((v) => v.toFixed(2)).join(' → ')}`);

  const iouAfterDrag = await evaluate(`window.__lightShadow.score()`);
  check('用鼠标拖到目标即接近满分', iouAfterDrag > 0.9, `IoU=${iouAfterDrag.toFixed(3)}`);
  const dragModal = await evaluate(
    `document.querySelector('.modal h2') ? document.querySelector('.modal h2').textContent : null`,
  );
  check('真实鼠标操作可触发通关', !!dragModal, dragModal ?? '未弹出结算');
  await screenshot('04-after-drag');
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.modal .btn')].find(x => x.textContent.includes('重玩')); if (b) b.click(); })()`,
  );
  await sleep(1400);

  // ── 4b. 影子必须盖在示例图形上方 ────────────────────────
  console.log('\n[4b] 影子图层在最上方');
  // 说明：不要用像素采样来验证这一条。物体位于相机与墙之间，会遮住自己
  // 投射在墙上的影子，从默认机位根本采不到"影子压住描边"的像素。
  // 真正决定遮挡关系的是 **renderOrder**（透明通道按相机距离排序，
  // 距离并列时结果不稳定，只有 renderOrder 能钉死），直接断言它即可。
  const layers = await evaluate(`window.__lightShadow.layerOrder()`);
  check(
    '影子绘制顺序在示例填充与描边之后',
    layers && layers.shadow > layers.targetStroke && layers.shadow > layers.targetFill,
    layers ? `填充#${layers.targetFill} → 描边#${layers.targetStroke} → 影子#${layers.shadow}` : 'null',
  );
  check(
    '影子确实位于最上层（renderOrder 与 z 值同时成立）',
    layers?.shadowIsTop === true,
    layers?.shadowIsTop ? '影子在最上层' : '影子未在最上层',
  );
  check(
    '模板印章先于铺色平面绘制（否则并集铺色会失效）',
    layers?.stampBeforeFill === true,
    layers?.stampBeforeFill ? '印章在铺色之前' : '顺序有误',
  );
  await screenshot('04b-shadow-on-top');

  // ── 5. 重置与提示 ───────────────────────────────────────
  console.log('\n[5] 重置与提示系统');
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.modal .btn')].find(x => x.textContent.includes('重玩')); if (b) b.click(); })()`,
  );
  await sleep(1400);
  await waitFrames(12);
  const restartIou = await evaluate(`window.__lightShadow.score()`);
  check('重玩本关后回到初始状态', restartIou < 0.03, `IoU=${restartIou.toFixed(3)}`);

  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.game-dock .btn')].find(x => x.textContent.includes('重置')); if (b) b.click(); })()`,
  );
  await sleep(700);
  const afterResetIou = await evaluate(`window.__lightShadow.score()`);
  check('重置按钮可用', afterResetIou < 0.03, `IoU=${afterResetIou.toFixed(3)}`);

  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.game-dock .btn')].find(x => x.textContent.includes('提示')); if (b) b.click(); })()`,
  );
  await sleep(400);
  const hint = await evaluate(
    `document.querySelector('.side-hint') ? document.querySelector('.side-hint').textContent : null`,
  );
  check('提示可以显示', !!hint, hint ? hint.slice(0, 24) + '…' : '未显示');
  await screenshot('05-hint');

  // 再次通关，为"下一关"按钮验证做准备
  await evaluate(`window.__lightShadow.solve()`);
  await sleep(1500);
  await waitFrames(10);
  const backModal = await evaluate(
    `document.querySelector('.modal h2') ? document.querySelector('.modal h2').textContent : null`,
  );
  check('设置到目标状态可再次通关', !!backModal, backModal ?? '未弹出');

  // ── 6. 下一关与全部关卡渲染 ──────────────────────────────
  console.log('\n[6] 下一关与关卡遍历');
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.modal .btn')].find(x => x.textContent.includes('下一关')); if (b) b.click(); })()`,
  );
  await sleep(1500);
  await waitFrames(15);
  const state2 = await evaluate(`window.__lightShadow.getState()`);
  check('可以进入第 2 关', state2?.levelId === 2, `levelId=${state2?.levelId}`);
  const unlocked = await evaluate(`window.__lightShadow.getState().unlocked`);
  check('第 2 关已解锁', unlocked >= 2, `unlocked=${unlocked}`);
  await screenshot('06-level2');

  // ── 7. 逐关渲染（含四道花窗题目） ────────────────────────
  console.log('\n[7] 逐关渲染验证');
  for (const id of [3, 4, 5, 6, 7, 8, 9, 10]) {
    await evaluate(`window.__lightShadow.goToLevel(${id})`);
    await sleep(1300);
    await waitFrames(15);
    const st = await evaluate(`window.__lightShadow.getState()`);
    const iou = await evaluate(`window.__lightShadow.score()`);
    check(`第 ${id} 关可进入并渲染`, st?.levelId === id, `初始 IoU=${iou.toFixed(3)}`);
    await screenshot(`${String(id).padStart(2, '0')}-level${id}`);
  }

  // 花窗题目的影子必须有真实画出来（不是空掩码），且每关的目标初始就有可比的 IoU
  console.log('\n[7a] 花窗题目投影非空');
  for (const id of [7, 8, 9, 10]) {
    await evaluate(`window.__lightShadow.goToLevel(${id})`);
    await sleep(1300);
    await waitFrames(15);
    const shadow = await evaluate(`window.__lightShadow.wallShadowCount()`);
    const st = await evaluate(`window.__lightShadow.getState()`);
    const iou = await evaluate(`window.__lightShadow.score()`);
    const objectCount = st?.objects?.length ?? 0;
    check(
      `第 ${id} 关由多个花窗构件组成`,
      objectCount >= 3,
      `物体数=${objectCount} · 墙面影子多边形=${shadow}`,
    );
    check(
      `第 ${id} 关墙面已逐构件绘制窗格影子`,
      shadow >= objectCount + 4,
      `影子多边形=${shadow} > 物体数=${objectCount}（每个构件拆成多个凸块独立投影）`,
    );
    // IoU > 0 同时证明「当前影子」与「目标轮廓」两个掩码都非空：
    // 只要任一侧是空掩码，交集必为 0、并集 > 0，IoU 必然恰好等于 0。
    check(
      `第 ${id} 关影子与目标都是非空掩码（投影确实算出来了）`,
      iou > 0.01,
      `初始 IoU=${iou.toFixed(3)}`,
    );
  }

  console.log('\n[7b] 目标状态可解性与通关');
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    await evaluate(`window.__lightShadow.goToLevel(${id})`);
    await sleep(1200);
    await evaluate(`window.__lightShadow.solve()`);
    await sleep(1400);
    await waitFrames(12);
    const solvedIou = await evaluate(`window.__lightShadow.score()`);
    const modal = await evaluate(
      `document.querySelector('.modal h2') ? document.querySelector('.modal h2').textContent : null`,
    );
    check(`第 ${id} 关目标状态可通关`, !!modal && solvedIou > 0.98,
      `IoU=${solvedIou.toFixed(4)}${modal ? ` · ${modal}` : ' · 未弹出结算'}`);
    if (id === 10) await screenshot('07-final-result');
    // 关闭弹窗
    await evaluate(
      `(() => { const b = [...document.querySelectorAll('.modal .btn')].find(x => x.textContent.includes('返回')); if (b) b.click(); })()`,
    );
    await sleep(400);
  }

  // ── 8. 刷新后存档恢复 ───────────────────────────────────
  console.log('\n[8] 存档与刷新');
  await send('Page.navigate', { url: URL_BASE });
  await sleep(RELOAD_WAIT);
  // 刷新后必须等应用真正挂载完成再读状态：定长 sleep 在慢网络（如线上 Pages
  // 首次拉取新 bundle）下会读到 window.__lightShadow 尚未赋值的一刻，
  // 从而抛 "Cannot read properties of undefined" 的假失败。
  const ready = await waitFor(`!!window.__lightShadow`, 20000);
  check('刷新后应用重新挂载', ready === true);
  await waitFrames(10);
  const saved = await evaluate(`window.__lightShadow.getState()`);
  check('刷新后解锁进度保留', saved.unlocked === 10, `unlocked=${saved.unlocked}`);
  const lab = await evaluate(`window.__lightShadow.getState().totalLevels === 10`);
  check('关卡总数与解锁进度一致地保存在存档里', lab === true);
  await screenshot('08-after-reload');

  // ── 8b. 自由实验室（经二级入口进入） ────────────────────
  console.log('\n[8b] 自由实验室');
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.title-actions .btn')].find(x => x.textContent.includes('光影挑战')); if (b) b.click(); })()`,
  );
  await sleep(800);
  await waitFrames(10);
  const intoLab = await evaluate(
    `(() => { const b = document.querySelector('.mode-screen .mode-card.mode-lab .mode-actions .btn'); if (!b) return false; b.click(); return true; })()`,
  );
  check('可从二级入口进入自由实验室', intoLab === true);
  await sleep(1800);
  await waitFrames(20);
  check('已进入自由实验室界面', (await evaluate(`!!document.querySelector('.lab-screen')`)) === true);
  check(
    '实验室三维画布已挂载',
    (await evaluate(`!!document.querySelector('.lab-screen canvas')`)) === true,
  );
  const labState0 = await evaluate(`window.__lightShadow.getLabState()`);
  check('实验室默认包含 3 个物体', labState0?.count === 3, `count=${labState0?.count}`);
  const labShadow0 = await evaluate(`window.__lightShadow.wallShadowCount()`);
  check('实验室已在墙面绘制影子', labShadow0 >= 3, `墙面影子图元=${labShadow0}`);
  const labShapeBtns = await evaluate(`document.querySelectorAll('.lab-add-grid .btn').length`);
  check('实验室已扩充到 13 种形状', labShapeBtns === 13, `形状按钮=${labShapeBtns}`);
  const hollowBtns = JSON.parse(
    (await evaluate(
      `JSON.stringify([...document.querySelectorAll('.lab-add-grid .btn')].map((b) => b.textContent.trim()))`,
    )) ?? '[]',
  );
  check(
    '带镂空的凹形（十字形 / 五角星 / 圆环）可选',
    ['十字形', '五角星', '圆环'].every((n) => hollowBtns.some((t) => t === n)),
    hollowBtns.join(' / '),
  );
  await screenshot('09-lab');

  // 重叠区域不得出现颜色接缝：把多个物体叠在一起，检查影子色是否只有一种
  await evaluate(`window.__lightShadow.overlapProbe()`);
  await sleep(700);
  await waitFrames(10);
  const stageRect = await evaluate(
    `(() => { const r = document.querySelector('.lab-screen canvas').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`,
  );
  const probe = await wallPixelStats(
    Math.round(stageRect.left + stageRect.width * 0.2),
    Math.round(stageRect.top + stageRect.height * 0.15),
    Math.round(stageRect.left + stageRect.width * 0.8),
    Math.round(stageRect.top + stageRect.height * 0.85),
  );
  check(
    '影子采样到足够像素',
    probe.count > 400,
    `影子像素=${probe.count}`,
  );
  check(
    '重叠区域颜色均匀（无叠加接缝）',
    probe.distinct <= 3,
    `成片色阶数=${probe.distinct}（内部像素=${probe.interior}；越接近 1 越说明是单次填充）top=${JSON.stringify(probe.top)}`,
  );
  await screenshot('09b-overlap');
  await evaluate(`window.__lightShadow.resetLabScene && window.__lightShadow.resetLabScene()`);
  await sleep(500);
  await waitFrames(8);

  // 添加几何体
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.lab-add-grid .btn')].find(x => x.textContent.includes('六边')); if (b) b.click(); })()`,
  );
  await sleep(700);
  await waitFrames(8);
  const labState1 = await evaluate(`window.__lightShadow.getLabState()`);
  check('添加几何体生效', labState1?.count === 4, `count=${labState1?.count}`);

  // 真实鼠标拖动实验室物体
  const labDragId = labState1.selected;
  const labBefore = labState1.objects.find((o) => o.id === labDragId)?.transform;
  const lpRaw = await evaluate(`window.__lightShadow.screenPos(${JSON.stringify(labDragId)})`);
  check('取得实验室物体的屏幕坐标', !!lpRaw, lpRaw ? `(${lpRaw.x.toFixed(0)}, ${lpRaw.y.toFixed(0)})` : 'null');
  if (lpRaw) {
    // screenPos 是纯数学投影，物体可能被教程提示条/顶部栏遮住，
    // 起点必须夹进安全区，否则鼠标事件打在浮层上、物体不动（假失败）。
    const lp = await safeStagePoint(lpRaw.x, lpRaw.y);
    await mouse('mousePressed', lp.x, lp.y);
    await sleep(150);
    for (let i = 1; i <= 12; i++) {
      await mouse('mouseMoved', lp.x - i * 7, lp.y + i * 2);
      await sleep(26);
    }
    await mouse('mouseReleased', lp.x - 12 * 7, lp.y + 12 * 2);
    await sleep(600);
    await waitFrames(8);
    const labState2 = await evaluate(`window.__lightShadow.getLabState()`);
    const labAfter = labState2.objects.find((o) => o.id === labDragId)?.transform;
    check(
      '实验室可拖动物体',
      !!labBefore && !!labAfter && (Math.abs(labAfter.x - labBefore.x) > 0.05 || Math.abs(labAfter.y - labBefore.y) > 0.05),
      labBefore && labAfter
        ? `起点(${lp.x.toFixed(0)}, ${lp.y.toFixed(0)}) · x: ${labBefore.x.toFixed(2)} → ${labAfter.x.toFixed(2)}, y: ${labBefore.y.toFixed(2)} → ${labAfter.y.toFixed(2)}`
        : '缺少变换数据',
    );
  }

  // 实验室同样可以切换观看视角
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.lab-screen .preset-group .btn')].find(x => x.textContent.trim() === '俯视'); if (b) b.click(); })()`,
  );
  await sleep(500);
  await waitFrames(6);
  const labView = await evaluate(`window.__lightShadow.getView()`);
  check('实验室可切换观看视角', labView.elevation > 50, `俯仰角=${labView.elevation.toFixed(1)}°`);
  await screenshot('10-lab-view');

  // 删除选中物体
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.lab-screen .side-panel .btn')].find(x => x.textContent.includes('删除选中物体')); if (b) b.click(); })()`,
  );
  await sleep(600);
  await waitFrames(8);
  const labState3 = await evaluate(`window.__lightShadow.getLabState()`);
  check('删除几何体生效', labState3?.count === 3, `count=${labState3?.count}`);

  // 重置场景
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.lab-screen .game-dock .btn')].find(x => x.textContent.includes('重置场景')); if (b) b.click(); })()`,
  );
  await sleep(700);
  await waitFrames(8);
  const labState4 = await evaluate(`window.__lightShadow.getLabState()`);
  check('重置场景恢复默认 3 个物体', labState4?.count === 3, `count=${labState4?.count}`);
  const labShadow1 = await evaluate(`window.__lightShadow.wallShadowCount()`);
  check('重置后墙面影子重新绘制', labShadow1 >= 3, `墙面影子图元=${labShadow1}`);
  await screenshot('11-lab-reset');

  // 凹形（带镂空）加入后必须产生真实投影多边形：圆环由 18 个凸环扇块组成，
  // 并集会保留中间的孔。这里只断言"新增了投影多边形"，
  // 严格的"整块凸包 vs 逐块并集"像素差断言在 npm run verify:window 里。
  const ringAdded = await evaluate(`window.__lightShadow.addLabShape('ring')`);
  await sleep(700);
  await waitFrames(10);
  const labShadow2 = await evaluate(`window.__lightShadow.wallShadowCount()`);
  check(
    '圆环（凹形镂空）加入后会产生真实投影多边形',
    ringAdded === 4 && labShadow2 > labShadow1,
    `物体数=${ringAdded} · 墙面影子图元 ${labShadow1} → ${labShadow2}`,
  );

  // 返回二级入口
  // 注意：实验室的返回按钮不在底部操作坞里，而是顶部栏左侧的图标按钮
  // （LabHUD 里 .game-topbar 的 .btn-icon，aria-label="返回光影挑战"）。
  await evaluate(
    `(() => { const b = document.querySelector('.lab-screen .game-topbar .btn-icon'); if (b) b.click(); })()`,
  );
  await sleep(800);
  check(
    '可从自由实验室返回二级入口',
    (await evaluate(`!!document.querySelector('.mode-screen')`)) === true,
  );
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.mode-screen .header-actions .btn')].find(x => x.textContent.includes('返回标题页')); if (b) b.click(); })()`,
  );
  await sleep(700);
  check(
    '可从二级入口返回标题页',
    (await evaluate(`!!document.querySelector('.title-main')`)) === true,
  );

  // ── 8c. 花窗工坊 ────────────────────────────────────────
  console.log('\n[8c] 花窗工坊（窗棂之间）');
  const wsBtn = await evaluate(
    `(() => { const b = [...document.querySelectorAll('.title-actions .btn')].find(x => x.textContent.includes('花窗工坊')); if (!b) return false; b.click(); return true; })()`,
  );
  check('标题页存在「花窗工坊」入口', wsBtn === true);
  await sleep(2000);
  await waitFrames(24);
  check('可进入花窗工坊界面', (await evaluate(`!!document.querySelector('.workshop-screen')`)) === true);
  check(
    '工坊三维画布已挂载（与关卡/实验室共用同一渲染器）',
    (await evaluate(`!!document.querySelector('.workshop-screen canvas')`)) === true,
  );

  // ── 8c-0. 版面：三维操作区必须居中且最宽（回归：曾因通用 .stage-wrap{grid-column:1}
  //          被挤成 268px 窄条，左栏反而吃掉 1fr），且操作指引必须是详细可读的真实键位 ──
  console.log('\n[8c-0] 工坊版面与操作指引');
  const layout = await evaluate(
    `(() => {
      const q = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom }; };
      return { topbar: q('.workshop-screen .game-topbar'), body: q('.workshop-body'), left: q('.workshop-left'), stage: q('.workshop-screen .stage-wrap'), right: q('.workshop-right') };
    })()`,
  );
  check(
    '三维操作区位于左栏右侧、右栏左侧（确实在中间）',
    !!layout?.stage && !!layout?.left && !!layout?.right
      && layout.stage.x > layout.left.x + layout.left.w - 1
      && layout.stage.x + layout.stage.w <= layout.right.x + 1,
    layout ? `左栏 ${layout.left.w.toFixed(0)}px | 画布 x=${layout.stage.x.toFixed(0)} w=${layout.stage.w.toFixed(0)} | 右栏 ${layout.right.w.toFixed(0)}px` : 'null',
  );
  check(
    '三维操作区比任一单侧栏都宽得多（操作区优先，不是窄条）',
    !!layout && layout.stage.w > layout.left.w * 2 && layout.stage.w > layout.right.w * 2,
    layout ? `画布 ${layout.stage.w.toFixed(0)}px vs 左 ${layout.left.w.toFixed(0)} / 右 ${layout.right.w.toFixed(0)}` : 'null',
  );
  check(
    '工具栏在画布之上，不再浮在画布上沿（操作区高度占满主体）',
    !!layout?.stage && !!layout?.topbar
      && layout.stage.y >= layout.topbar.b - 1
      && Math.abs(layout.stage.h - layout.body.h) < 1,
    layout ? `工具栏底 y=${layout.topbar.b.toFixed(0)} · 画布 y=${layout.stage.y.toFixed(0)} 高=${layout.stage.h.toFixed(0)} / 主体高=${layout.body.h.toFixed(0)}` : 'null',
  );

  const guide = await evaluate(
    `(() => {
      const card = document.querySelector('.stage-hud .guide-card');
      if (!card) return null;
      return {
        steps: card.querySelectorAll('.guide-step').length,
        groups: card.querySelectorAll('.guide-group').length,
        rows: card.querySelectorAll('.guide-row').length,
        keys: [...card.querySelectorAll('.guide-keys .kbd')].map((k) => k.textContent),
        text: card.textContent,
      };
    })()`,
  );
  check('画布上有「操作指引」卡', !!guide);
  check('指引含四步上手（4 条）', (guide?.steps ?? 0) === 4, `步骤数=${guide?.steps}`);
  check(
    '指引含分组键位表（≥4 组 / ≥15 行）',
    (guide?.groups ?? 0) >= 4 && (guide?.rows ?? 0) >= 15,
    `分组=${guide?.groups} · 键位行=${guide?.rows}`,
  );
  check(
    '指引列出的是真实存在的按键（Q/E、方向键、Shift、Esc、Enter）',
    ['Q', 'E', '方向键', 'Shift', 'Esc', 'Enter'].every((k) => (guide?.keys ?? []).includes(k)),
    (guide?.keys ?? []).join(' '),
  );

  const statusText = await evaluate(
    `(() => { const el = document.querySelector('.stage-hud .stage-status'); return el ? el.textContent : null; })()`,
  );
  check(
    '画布底部状态条常驻显示位置与影子读数',
    !!statusText && statusText.includes('影子') && statusText.includes('镂空率'),
    statusText ?? 'null',
  );

  // 侧栏可收起：画布必须随之变宽
  const stageBefore = await evaluate(`document.querySelector('.workshop-screen .stage-wrap').getBoundingClientRect().width`);
  await evaluate(
    `(() => { for (const b of document.querySelectorAll('.stage-tools .side-toggle')) b.click(); })()`,
  );
  await sleep(500);
  await waitFrames(10);
  const stageAfter = await evaluate(`document.querySelector('.workshop-screen .stage-wrap').getBoundingClientRect().width`);
  check(
    '收起两侧栏后画布铺满整行（操作区可以更大）',
    stageAfter > stageBefore + 300,
    `${stageBefore.toFixed(0)}px → ${stageAfter.toFixed(0)}px`,
  );
  await evaluate(
    `(() => { for (const b of document.querySelectorAll('.stage-tools .side-toggle')) b.click(); })()`,
  );
  await sleep(500);
  await waitFrames(10);
  const stageBack = await evaluate(`document.querySelector('.workshop-screen .stage-wrap').getBoundingClientRect().width`);
  check('再点一次可还原三栏', Math.abs(stageBack - stageBefore) < 2, `${stageAfter.toFixed(0)}px → ${stageBack.toFixed(0)}px`);


  const ws0 = await evaluate(`window.__lightShadow.workshop.state()`);
  check('默认载入「步步锦」模板', ws0?.patternId === 'step-step-brocade', `patternId=${ws0?.patternId}`);
  check('模板已分解为杆件', (ws0?.strokes ?? 0) >= 8, `笔画数=${ws0?.strokes}`);
  const wsShadow0 = await evaluate(`window.__lightShadow.wallShadowCount()`);
  check('墙面已绘制窗格影子（真实投影）', wsShadow0 >= 8, `墙面影子图元=${wsShadow0}`);
  check(
    '投影掩码非空（投影确实算出来了）',
    (ws0?.maskPixels ?? 0) > 2000,
    `掩码像素=${ws0?.maskPixels}`,
  );
  check(
    '窗棂空隙被真实保留（镂空率 > 25%）',
    (ws0?.voidRatio ?? 0) > 0.25,
    `镂空率=${((ws0?.voidRatio ?? 0) * 100).toFixed(1)}%，包围盒 ${ws0?.bounds?.width?.toFixed(2)}×${ws0?.bounds?.height?.toFixed(2)}`,
  );
  await screenshot('12-workshop-default');

  // 三类纹样都能切换，且都产生真实、互不相同的投影
  console.log('\n[8c-1] 三类纹样切换');
  const wsShapes = {};
  for (const [id, label] of [
    ['step-step-brocade', '步步锦'],
    ['ice-crack-style', '冰裂纹'],
    ['three-cross-six-bowl-diamond', '三交六椀菱花'],
  ]) {
    await evaluate(
      `(() => { const b = document.querySelector('.pattern-list .pattern-card[data-pattern="${id}"]'); if (b) b.click(); })()`,
    );
    await sleep(700);
    await waitFrames(14);
    const st = await evaluate(`window.__lightShadow.workshop.state()`);
    const sh = await evaluate(`window.__lightShadow.wallShadowCount()`);
    wsShapes[id] = { strokes: st?.strokes ?? 0, mask: st?.maskPixels ?? 0, shadow: sh };
    check(
      `${label}：模板已切换且产生真实投影`,
      st?.patternId === id && (st?.maskPixels ?? 0) > 1500 && sh >= 6,
      `笔画=${st?.strokes} · 掩码像素=${st?.maskPixels} · 墙面图元=${sh}`,
    );
    await screenshot(`13-pattern-${id}`);
  }
  check(
    '三类纹样投影结果互不相同（不是同一张固定图）',
    new Set(Object.values(wsShapes).map((s) => s.mask)).size === 3,
    Object.entries(wsShapes)
      .map(([k, v]) => `${k}=${v.mask}px`)
      .join(' / '),
  );

  // 参数滑杆真的会重建杆件
  const beforeParam = await evaluate(`window.__lightShadow.workshop.state()`);
  await evaluate(`window.__lightShadow.workshop.setParams({ rows: 6, columnCount: 6, density: 1 })`);
  await sleep(700);
  await waitFrames(14);
  const afterParam = await evaluate(`window.__lightShadow.workshop.state()`);
  check(
    '修改模板参数会重建杆件（参数真实生效）',
    afterParam.strokes !== beforeParam.strokes || afterParam.segments !== beforeParam.segments,
    `笔画 ${beforeParam.strokes}→${afterParam.strokes}，线段 ${beforeParam.segments}→${afterParam.segments}`,
  );

  // ── 8c-2. 光影随位置变化 ────────────────────────────────
  console.log('\n[8c-2] 光影随位置变化（证明是几何投影而非贴图）');
  await evaluate(`window.__lightShadow.workshop.pickPattern('step-step-brocade')`);
  await sleep(700);
  await waitFrames(14);
  // 注意方向：点光源与墙不同侧，窗格 z 越大 = 离墙越远 = 离光源越近 → 影子越大。
  // 因此 z=6.5 是"贴近光源"，z=2.0 才是"贴近墙面"。
  await evaluate(`window.__lightShadow.workshop.setDepth(6.5)`);
  await sleep(700);
  await waitFrames(14);
  const nearLight = await evaluate(`window.__lightShadow.workshop.state()`);
  await evaluate(`window.__lightShadow.workshop.setDepth(2.0)`);
  await sleep(700);
  await waitFrames(14);
  const farLight = await evaluate(`window.__lightShadow.workshop.state()`);
  check(
    '窗格越靠近点光源（离墙越远），投影越大（几何投影规律）',
    (nearLight?.bounds?.width ?? 0) > (farLight?.bounds?.width ?? 0) * 1.15,
    `贴近光源 z=6.5 → ${nearLight?.bounds?.width?.toFixed(2)}；贴近墙面 z=2.0 → ${farLight?.bounds?.width?.toFixed(2)}`,
  );
  check(
    '移动窗格会改变镂空率（影子形状随位置变化）',
    Math.abs((nearLight?.voidRatio ?? 0) - (farLight?.voidRatio ?? 0)) > 0.005,
    `镂空率 ${((nearLight?.voidRatio ?? 0) * 100).toFixed(1)}% vs ${((farLight?.voidRatio ?? 0) * 100).toFixed(1)}%`,
  );
  await evaluate(`window.__lightShadow.workshop.setDepth(4.2)`);
  await sleep(600);
  await waitFrames(10);

  // ── 8c-3. 引导实验 ──────────────────────────────────────
  console.log('\n[8c-3] 引导实验（对照读数由实时指标推导）');
  const expList = await evaluate(`document.querySelectorAll('.experiment-list .btn').length`);
  check('引导实验面板列出多个实验', expList >= 4, `实验数=${expList}`);
  await evaluate(`(() => { const b = document.querySelector('.experiment-list .btn'); if (b) b.click(); })()`);
  await sleep(800);
  await waitFrames(12);
  const exp = await evaluate(`window.__lightShadow.workshop.state()`);
  const narrative = await evaluate(
    `document.querySelector('.experiment-narrative') ? document.querySelector('.experiment-narrative').textContent : ''`,
  );
  check('进入实验后有对照读数文本', !!exp?.experiment, `当前实验=${exp?.experiment}`);
  check(
    '实验叙述来自实时数据（含百分比变化）',
    /%|倍|像素|面积/.test(narrative ?? ''),
    (narrative ?? '').slice(0, 60) + '…',
  );
  await screenshot('14-workshop-experiment');
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.workshop-dock .btn')].find(x => x.textContent.includes('重置实验')); if (b) b.click(); })()`,
  );
  await sleep(600);

  // ── 8c-4. 自绘窗棂 ──────────────────────────────────────
  console.log('\n[8c-4] 自绘窗棂（用户创作）');
  const beforeDraw = await evaluate(`window.__lightShadow.workshop.state()`);
  const drew = await evaluate(
    `window.__lightShadow.workshop.drawPolyline([{x:-1.2,y:-1.8},{x:0,y:0.9},{x:1.2,y:-1.8}])`,
  );
  await sleep(700);
  await waitFrames(12);
  const afterDraw = await evaluate(`window.__lightShadow.workshop.state()`);
  check(
    '自绘折线被加入文档并可投影',
    drew === true && afterDraw.userStrokes === beforeDraw.userStrokes + 1 && afterDraw.segments > beforeDraw.segments,
    `用户笔画 ${beforeDraw.userStrokes}→${afterDraw.userStrokes}，线段 ${beforeDraw.segments}→${afterDraw.segments}`,
  );
  check(
    '自绘后投影随之更新（新杆件进入投影）',
    afterDraw.maskPixels !== beforeDraw.maskPixels,
    `掩码像素 ${beforeDraw.maskPixels}→${afterDraw.maskPixels}`,
  );
  // 撤销自绘
  await evaluate(`window.__lightShadow.workshop.clickButton('撤销')`);
  await sleep(500);
  await waitFrames(8);
  const afterUndo = await evaluate(`window.__lightShadow.workshop.state()`);
  check(
    '撤销可以回退自绘',
    afterUndo.userStrokes === beforeDraw.userStrokes,
    `用户笔画=${afterUndo.userStrokes}`,
  );
  await screenshot('15-workshop-user-drawn');

  // ── 8c-4b. 绘制模式（真实鼠标事件驱动）────────────────────
  // 这一段是回归测试：绘制模式曾经**退不出去**（退出分支漏掉 drawing.disable()，
  // 于是按钮永远停在「结束绘制」，画布点击还在偷偷塞节点、窗格再也点不中），
  // 而且预览浮层是 300×150 的 SVG 内联默认尺寸（画在窗格位置的节点被自己的
  // viewport 裁掉 = 完全没有预览）。两者都必须真的跑一遍用户路径才能发现。
  console.log('\n[8c-4b] 绘制模式：进入 / 悬停预览 / 节点标识 / 退出');
  const clickDrawBtn = `(() => {
    const b = [...document.querySelectorAll('.workshop-dock .btn')].find(x => /^(画棂条|结束绘制)$/.test(x.textContent.trim()));
    if (!b) return null;
    b.click();
    return b.textContent.trim();
  })()`;
  const drawSnap = `(() => {
    const s = window.__lightShadow.workshop.state();
    const btn = [...document.querySelectorAll('.workshop-dock .btn')].find(x => /^(画棂条|结束绘制)$/.test(x.textContent.trim()));
    const rubber = document.querySelector('.draw-rubber');
    const ghost = document.querySelector('.draw-ghost');
    const stage = document.querySelector('.workshop-screen .stage').getBoundingClientRect();
    const ov = document.querySelector('.draw-overlay').getBoundingClientRect();
    return {
      drawing: s.drawing,
      userStrokes: s.userStrokes,
      btn: btn ? btn.textContent.trim() : null,
      overlayActive: document.querySelector('.draw-overlay').classList.contains('active'),
      overlayFillsStage: Math.abs(ov.width - stage.width) < 2 && Math.abs(ov.height - stage.height) < 2,
      nodes: document.querySelectorAll('.draw-node-dot').length,
      current: document.querySelectorAll('.draw-node-item.is-current').length,
      indices: [...document.querySelectorAll('.draw-node-index')].map(t => t.textContent).join(','),
      rubberVisible: rubber ? !rubber.classList.contains('hidden') : false,
      ghostWidth: Number(ghost ? ghost.getAttribute('stroke-width') : 0),
      ghostPoints: (ghost ? ghost.getAttribute('points') : '') || '',
      hoverLabel: (document.querySelector('.draw-hover-label') || {}).textContent || '',
      status: document.querySelector('.stage-hud .stage-status').textContent,
    };
  })()`;

  const stageBox = JSON.parse(
    await evaluate(
      `JSON.stringify((() => { const r = document.querySelector('.workshop-screen .stage').getBoundingClientRect();
        return { left: r.left, top: r.top, w: r.width, h: r.height }; })())`,
    ),
  );
  /** 舞台上的相对点（比例坐标 → 页面坐标） */
  const wpoint = (fx, fy) => ({ x: stageBox.left + stageBox.w * fx, y: stageBox.top + stageBox.h * fy });

  check('底部「画棂条」可进入绘制模式', (await evaluate(clickDrawBtn)) === '结束绘制');
  await sleep(400);
  await waitFrames(6);
  const drawEnter = await evaluate(drawSnap);
  check(
    '进入绘制模式后浮层与画布同尺寸（预览不会被 SVG 默认 300×150 裁掉）',
    drawEnter?.overlayActive === true && drawEnter?.overlayFillsStage === true,
    `overlayActive=${drawEnter?.overlayActive} · 铺满=${drawEnter?.overlayFillsStage}`,
  );
  check(
    '绘制模式给出可退出提示（状态条写明单击 / 双击 / Enter / Esc）',
    /单击/.test(drawEnter?.status ?? '') && /Esc/.test(drawEnter?.status ?? '') && /退出绘制/.test(drawEnter?.status ?? ''),
    (drawEnter?.status ?? '').slice(0, 70),
  );

  // 只把鼠标移上去（不点击）就应该看到"下一段"的预览
  const h1 = wpoint(0.62, 0.45);
  await mouse('mouseMoved', h1.x, h1.y);
  await sleep(300);
  const hoverOnly = await evaluate(drawSnap);
  check(
    '鼠标移动即显示落点预览（吸附后的窗格坐标）',
    /^-?\d+\.\d\d, -?\d+\.\d\d$/.test(hoverOnly?.hoverLabel ?? ''),
    `标签=${hoverOnly?.hoverLabel}`,
  );
  check(
    '还没有节点时不画橡皮筋（避免凭空出现一条线）',
    hoverOnly?.rubberVisible === false && hoverOnly?.nodes === 0,
  );

  /**
   * 选 3 个"真的能落到窗格上、彼此分得开"的落点。
   * 直接用比例坐标会踩两个坑：① 落在窗格之外会被夹到边界（几个点重合成一个节点）；
   * ② 落在操作指引卡 / 状态条下面的点会被浮层吃掉（事件根本到不了画布）。
   * 所以先用悬停预览反查坐标（pointermove 是同步更新 DOM 的，可在页面内一次扫完），
   * 再要求 `elementFromPoint` 就是画布本身。
   */
  const drawPts = JSON.parse(
    await evaluate(
      `JSON.stringify((() => {
        const stage = document.querySelector('.workshop-screen .stage');
        const canvas = stage.querySelector('canvas');
        const r = stage.getBoundingClientRect();
        const labelOf = () => {
          const t = document.querySelector('.draw-hover-label');
          return ((t && t.textContent) || '').split(',').map(Number);
        };
        const cands = [];
        for (let ix = 2; ix <= 19; ix++) {
          for (let iy = 2; iy <= 19; iy++) {
            const x = r.left + (r.width * ix) / 21, y = r.top + (r.height * iy) / 21;
            if (document.elementFromPoint(x, y) !== canvas) continue;
            stage.dispatchEvent(new PointerEvent('pointermove', {
              clientX: x, clientY: y, pointerId: 21, bubbles: true }));
            const t = labelOf();
            if (t.length !== 2 || !isFinite(t[0]) || !isFinite(t[1])) continue;
            if (cands.some((c) => Math.abs(c.lx - t[0]) < 0.3 && Math.abs(c.ly - t[1]) < 0.3)) continue;
            cands.push({ x, y, lx: t[0], ly: t[1] });
          }
        }
        if (cands.length < 3) return [];
        // 取彼此离得最远的三个，保证画出来的折线形状清楚
        const first = cands[0];
        const second = cands.reduce((a, b) =>
          (b.lx - first.lx) ** 2 + (b.ly - first.ly) ** 2 > (a.lx - first.lx) ** 2 + (a.ly - first.ly) ** 2 ? b : a);
        const third = cands.reduce((a, b) => {
          const d = (q) => Math.min((q.lx - first.lx) ** 2 + (q.ly - first.ly) ** 2,
                                    (q.lx - second.lx) ** 2 + (q.ly - second.ly) ** 2);
          return d(b) > d(a) ? b : a;
        });
        return [first, second, third];
      })())`,
    ),
  );
  check('能在窗格上取到三个互不相同的落点（不会被浮层或夹紧吃掉）', drawPts.length === 3, JSON.stringify(drawPts));

  // 真实鼠标点击落下 3 个节点
  for (const p of drawPts) {
    await mouse('mouseMoved', p.x, p.y);
    await mouse('mousePressed', p.x, p.y);
    await mouse('mouseReleased', p.x, p.y);
    await sleep(260);
  }
  const hover2 = wpoint(0.7, 0.4);
  await mouse('mouseMoved', hover2.x, hover2.y);
  await sleep(320);
  await waitFrames(6);
  const drawn = await evaluate(drawSnap);
  check(
    '三个节点都留下可见标识（带序号）',
    drawn?.nodes === 3 && drawn?.indices === '1,2,3',
    `节点=${drawn?.nodes} 序号=${drawn?.indices}`,
  );
  check(
    '当前节点有专门标识（光晕 + 准星，且只有一个）',
    drawn?.current === 1,
    `is-current=${drawn?.current}`,
  );
  check(
    '绘制过程显示下一段预览（橡皮筋 + 真实粗细的棂条）',
    drawn?.rubberVisible === true && drawn?.ghostWidth > 1 && (drawn?.ghostPoints ?? '').split(' ').length === 3,
    `橡皮筋=${drawn?.rubberVisible} 棂条预览粗细=${drawn?.ghostWidth}px 折线点数=${(drawn?.ghostPoints ?? '').split(' ').length}`,
  );
  await screenshot('15b-工坊-绘制模式');

  // 退出：按钮
  const beforeExit = await evaluate(`window.__lightShadow.workshop.state()`);
  check('再点一次按钮可退出绘制模式', (await evaluate(clickDrawBtn)) === '画棂条');
  await sleep(500);
  await waitFrames(6);
  const exited = await evaluate(drawSnap);
  check(
    '退出后工具状态与浮层一起关闭（按钮回到「画棂条」）',
    exited?.drawing === false && exited?.overlayActive === false && exited?.btn === '画棂条',
    `drawing=${exited?.drawing} 按钮=${exited?.btn} 浮层=${exited?.overlayActive}`,
  );
  check(
    '退出时折线被正常提交（不是丢失）',
    exited?.userStrokes === beforeExit.userStrokes + 1,
    `用户笔画 ${beforeExit.userStrokes}→${exited?.userStrokes}`,
  );
  // 旧 bug 的连坐症状：退出后画布点击还在偷偷往折线里塞节点
  await mouse('mousePressed', wpoint(0.5, 0.5).x, wpoint(0.5, 0.5).y);
  await mouse('mouseReleased', wpoint(0.5, 0.5).x, wpoint(0.5, 0.5).y);
  await sleep(400);
  const afterStray = await evaluate(drawSnap);
  check(
    '退出后画布点击不再偷偷累积节点',
    afterStray?.nodes === 0 && afterStray?.drawing === false && afterStray?.userStrokes === exited?.userStrokes,
    `节点=${afterStray?.nodes} 用户笔画=${afterStray?.userStrokes}`,
  );

  // 退出：Esc（折线为空 → 退出绘制模式）
  await evaluate(clickDrawBtn);
  await sleep(300);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  const escEmpty = await evaluate(drawSnap);
  check(
    '折线为空时按 Esc 直接退出绘制模式',
    escEmpty?.drawing === false && escEmpty?.btn === '画棂条',
    `drawing=${escEmpty?.drawing} 按钮=${escEmpty?.btn}`,
  );

  // 退出：Esc（有节点 → 只取消折线，仍留在绘制模式）
  await evaluate(clickDrawBtn);
  await sleep(300);
  for (const p of drawPts.slice(0, 2)) {
    await mouse('mouseMoved', p.x, p.y);
    await mouse('mousePressed', p.x, p.y);
    await mouse('mouseReleased', p.x, p.y);
    await sleep(240);
  }
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  const escNodes = await evaluate(drawSnap);
  check(
    '折线上已有节点时 Esc 只取消折线（仍留在绘制模式）',
    escNodes?.drawing === true && escNodes?.nodes === 0,
    `drawing=${escNodes?.drawing} 节点=${escNodes?.nodes}`,
  );

  // 退出后窗格必须恢复可点选（旧 bug 下绘制模式的闸门永久卡住：hitTest 恒 false，
  // 点窗格只会转视角、选不中）。同一套采样点跑两次，作为成对对照。
  const sampleHitGrid = `(() => {
    const r = document.querySelector('.workshop-screen .stage').getBoundingClientRect();
    let n = 0;
    for (let ix = 2; ix <= 58; ix += 2) for (let iy = 2; iy <= 58; iy += 2) {
      if (window.__lightShadow.workshop.hitTest(r.left + (r.width * ix) / 60, r.top + (r.height * iy) / 60)) n++;
    }
    return n;
  })()`;
  const hitsWhileDrawing = await evaluate(sampleHitGrid);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  const exitFinal = await evaluate(drawSnap);
  const hitsAfterExit = await evaluate(sampleHitGrid);
  check(
    '绘制模式下点选被关闭，退出后立即恢复（成对对照同一套采样点）',
    exitFinal?.drawing === false && hitsWhileDrawing === 0 && hitsAfterExit > 0,
    `绘制中可点中=${hitsWhileDrawing}，退出后可点中=${hitsAfterExit}`,
  );
  const pickTarget = JSON.parse(
    await evaluate(
      `JSON.stringify((() => {
         const stage = document.querySelector('.workshop-screen .stage');
         const canvas = stage.querySelector('canvas');
         const r = stage.getBoundingClientRect();
         const found = [];
         for (let ix = 2; ix <= 58; ix++) for (let iy = 2; iy <= 58; iy++) {
           const x = r.left + (r.width * ix) / 60, y = r.top + (r.height * iy) / 60;
           // 必须同时满足：① 落在棂条上；② 顶上就是画布本身 ——
           // 操作指引卡等浮层会吃掉事件，只查 hitTest 会选到"点不到"的点（假失败）。
           if (!window.__lightShadow.workshop.hitTest(x, y)) continue;
           if (document.elementFromPoint(x, y) !== canvas) continue;
           found.push({ x, y });
         }
         if (!found.length) return null;
         const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
         return found.reduce((a, b) =>
           (b.x - cx) ** 2 + (b.y - cy) ** 2 < (a.x - cx) ** 2 + (a.y - cy) ** 2 ? b : a);
       })())`,
    ),
  );
  const selBefore = await evaluate(`window.__lightShadow.workshop.state().selectedStrokeId`);
  if (pickTarget) {
    // 真实鼠标点击一次，验证拾取链路（不只是查询函数）
    await mouse('mouseMoved', pickTarget.x, pickTarget.y);
    await mouse('mousePressed', pickTarget.x, pickTarget.y);
    await mouse('mouseReleased', pickTarget.x, pickTarget.y);
    await sleep(400);
  }
  const selAfter = await evaluate(`window.__lightShadow.workshop.state().selectedStrokeId`);
  check(
    '退出绘制后窗格恢复可点选（真实点击能选中棂条）',
    !!pickTarget && !!selAfter && selAfter !== selBefore,
    `命中点=${pickTarget ? `${pickTarget.x.toFixed(0)},${pickTarget.y.toFixed(0)}` : 'null'}，选中 ${selBefore} → ${selAfter}`,
  );

  // ── 8c-5. 作品保存与海报导出 ────────────────────────────
  console.log('\n[8c-5] 作品保存与海报导出');
  const savedList = await evaluate(`window.__lightShadow.workshop.save('E2E 测试作品')`);
  check(
    '作品保存到独立的作品集存储',
    Array.isArray(savedList) && savedList.length >= 1,
    `作品数=${Array.isArray(savedList) ? savedList.length : 'null'}`,
  );
  const poster = await evaluate(`window.__lightShadow.workshop.poster()`);
  check(
    '海报画布为 1920×1080',
    poster?.width === 1920 && poster?.height === 1080,
    `${poster?.width}×${poster?.height}`,
  );
  check(
    '海报确实绘制了内容（非空白画布）',
    typeof poster?.dataUrl === 'string' && poster.dataUrl.length > 20000,
    `dataURL 长度=${poster?.dataUrl?.length ?? 0}`,
  );
  const exp1 = await evaluate(`window.__lightShadow.workshop.exportPng()`);
  check(
    '导出 PNG 海报成功',
    exp1?.ok === true && exp1.size > 8000,
    exp1?.ok ? `${(exp1.size / 1024).toFixed(0)} KB` : (exp1?.message ?? '失败'),
  );
  await screenshot('16-workshop-poster');

  // 关掉作品集弹窗（若被打开）
  await evaluate(
    `(() => { const m = document.querySelector('.modal-mask .modal'); if (!m) return; const b = [...m.querySelectorAll('.btn')].find(x => x.textContent.includes('关闭') || x.textContent.includes('返回')); if (b) b.click(); })()`,
  );
  await sleep(400);

  // ── 8c-6. 刷新后作品仍在 ────────────────────────────────
  console.log('\n[8c-6] 作品持久化');
  await send('Page.navigate', { url: URL_BASE });
  await sleep(RELOAD_WAIT);
  await waitFor(`!!window.__lightShadow`, 20000);
  const reopened = await evaluate(`window.__lightShadow.workshop.open()`);
  await sleep(1800);
  await waitFrames(16);
  check('刷新后可重新进入工坊', reopened === true);
  const savedAfter = await evaluate(`window.__lightShadow.workshop.save()`);
  check(
    '刷新后作品集仍保留（与关卡存档分离）',
    Array.isArray(savedAfter) && savedAfter.length >= 1,
    `作品数=${Array.isArray(savedAfter) ? savedAfter.length : 'null'}`,
  );

  // 返回标题页
  await evaluate(
    `(() => { const b = document.querySelector('.workshop-screen .game-topbar .btn-icon'); if (b) b.click(); })()`,
  );
  await sleep(900);
  check(
    '可从花窗工坊返回标题页',
    (await evaluate(`!!document.querySelector('.title-main')`)) === true,
  );

  // ── 8d. 纹样图鉴与文化来源 ──────────────────────────────
  console.log('\n[8d] 纹样图鉴与文化来源');
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.title-actions .btn')].find(x => x.textContent.includes('纹样图鉴')); if (b) b.click(); })()`,
  );
  await sleep(1200);
  await waitFrames(12);
  const galleryCards = await evaluate(`document.querySelectorAll('.gallery-grid .gallery-card').length`);
  check('纹样图鉴列出纹理卡片', galleryCards >= 3, `卡片数=${galleryCards}`);
  const srcLinks = await evaluate(`document.querySelectorAll('.gallery-sources a').length`);
  check('文化卡片给出可追溯的来源链接', srcLinks >= 3, `来源链接=${srcLinks}`);
  const digitalNote = await evaluate(
    `(() => { const t = document.body.textContent || ''; return t.includes('数字示意') || t.includes('风格化创作'); })()`,
  );
  check('算法产出被标注为「数字示意 / 风格化创作」', digitalNote === true);
  await screenshot('17-pattern-gallery');
  await evaluate(
    `(() => { const m = document.querySelector('.modal-mask .modal'); if (!m) return; const b = [...m.querySelectorAll('.btn')].find(x => x.textContent.includes('关闭')); if (b) b.click(); })()`,
  );
  await sleep(500);

  // ── 8e. 作品与资料 ──────────────────────────────────────
  console.log('\n[8e] 作品与资料');
  const aboutBtn = await evaluate(
    `(() => { const b = [...document.querySelectorAll('.title-actions .btn')].find(x => x.textContent.includes('作品与资料')); if (!b) return false; b.click(); return true; })()`,
  );
  check('标题页存在「作品与资料」入口', aboutBtn === true);
  await sleep(700);
  await waitFrames(8);
  check('资料面板可打开', (await evaluate(`!!document.querySelector('.about-modal')`)) === true);
  const aboutSources = await evaluate(`document.querySelectorAll('.about-modal a').length`);
  check('资料面板列出文化来源链接', aboutSources >= 3, `来源链接=${aboutSources}`);
  const aboutBoundary = await evaluate(
    `(() => { const t = document.querySelector('.about-modal')?.textContent ?? ''; return t.includes('已知边界') && (t.includes('数字示意') || t.includes('风格化创作')); })()`,
  );
  check('资料面板如实写明已知边界（非文物精确复原）', aboutBoundary === true);
  await screenshot('18-about');
  await evaluate(
    `(() => { const m = document.querySelector('.about-modal'); if (!m) return; const b = [...m.querySelectorAll('.btn')].find(x => x.textContent.includes('关闭')); if (b) b.click(); })()`,
  );
  await sleep(400);

  // ── 9. 控制台错误 ───────────────────────────────────────
  console.log('\n[9] 控制台');
  check('无页面异常', pageExceptions.length === 0, pageExceptions.join(' | '));
  check('无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  const failed = results.filter((f) => !f.ok);
  console.log('\n════════════════════════════════════════');
  console.log(`总计 ${results.length} 项检查，通过 ${results.length - failed.length} 项`);
  if (failed.length) {
    console.log('未通过：');
    for (const f of failed) console.log(`  ✗ ${f.label} ${f.detail}`);
  } else {
    console.log('✓ 全部通过');
  }
  console.log('════════════════════════════════════════');

  return failed.length === 0;
}

main()
  .then((ok) => {
    if (ws) ws.close();
    if (chromeProc) chromeProc.kill();
    process.exitCode = ok ? 0 : 1;
  })
  .catch((err) => {
    console.error('\n端到端测试异常：', err);
    if (chromeProc) chromeProc.kill();
    process.exitCode = 1;
  });
