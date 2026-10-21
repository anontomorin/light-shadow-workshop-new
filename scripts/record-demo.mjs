/**
 * 演示视频录制脚本（真实操作 + 中文配音 + 字幕）。
 *
 * 流程：
 *   1. 先用 Edge 神经网络语音合成 11 段旁白（正常语速，rate=+0%），缓存到临时目录；
 *   2. 用无头 Chrome + CDP 打开真实页面，注入可见光标；
 *   3. 按分镜做真实鼠标操作（点击 / 环绕 / 拖拽通关 / 自绘棂条），
 *      每段镜头停留时间 = 该段旁白时长 + 0.6s；
 *   4. Page.startScreencast 逐帧抓取 1920×1080 画面；
 *   5. ffmpeg：concat 成 30fps 视频 → 按场景起点对齐旁白 → loudnorm → 烧字幕 → 淡入淡出。
 *
 * 运行（开发服务器需已启动，默认 http://localhost:5183/）：
 *   node scripts/record-demo.mjs
 * 可选环境变量：
 *   DEMO_URL=http://localhost:5183/   页面地址
 *   DEMO_CAPTURE=shots                低帧率时改用固定间隔截图
 *   DEMO_KEEP_FRAMES=1                保留临时帧，便于排查
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { synthesize } from './tts-edge.mjs';

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'submission', '演示视频');
const OUT_FILE = join(OUT_DIR, '光影工坊-演示视频-2026-10-21.mp4');
// 固定工作目录：旁白可跨次复用，重跑时不必重新合成
const WORK_DIR = join(tmpdir(), 'lsw-demo');
const FRAME_DIR = join(WORK_DIR, 'frames');
const VOICE_DIR = join(WORK_DIR, 'voice');
const FFMPEG = 'D:/download/ffmpeg-8.0.1-essentials_build/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe';
const FFPROBE = 'D:/download/ffmpeg-8.0.1-essentials_build/ffmpeg-8.0.1-essentials_build/bin/ffprobe.exe';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(process.env.DEMO_CDP_PORT ?? 9337);
const URL_BASE = process.env.DEMO_URL ?? 'http://localhost:5183/';
const W = 1920;
const H = 1080;
const CAPTURE_MODE = process.env.DEMO_CAPTURE === 'shots' ? 'shots' : 'screencast';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

// ───────────────────────── 旁白 ─────────────────────────
const VOICE = 'zh-CN-XiaoxiaoNeural';
const NARRATION = [
  { key: 'v1', text: '这是一座可以亲手推开的花窗工坊：光穿过窗棂，在墙上留下真实的影子。' },
  { key: 'v2', text: '先环绕看看。左键拖动空白处转动视角，滚轮可以拉近或推远。' },
  { key: 'v3', text: '步步锦、冰裂纹、三交六椀菱花，三种传统纹样都由生成器实时绘制，调一下参数，影子立刻重算。' },
  { key: 'v4', text: '也可以自己画。点下第一个节点，再点第二个，节点会带上序号，新画的棂条立刻并入投影。' },
  { key: 'v5', text: '墙上的影子不是贴图，而是逐块凸包投影的结果；窗格之间的空隙，会被如实保留。' },
  { key: 'v6', text: '首页的工坊负责创作，光影挑战负责闯关。十道影形解谜，从方块一路走到经典花窗。' },
  { key: 'v7', text: '前六关认识投影的规律，第七关起，题目来自方格窗、菱花窗、冰裂纹和圆光窗。' },
  { key: 'v8', text: '选中方块，按住左键拖动。影子与目标轮廓的匹配度实时刷新——完全重合，本关百分之百。' },
  { key: 'v9', text: '第八关是菱花窗。拖动由棂条拼成的构件，让影子复现三交六椀的格眼。' },
  { key: 'v10', text: '自由实验室里有十三种形状，包括十字、五角星和圆环这些带镂空的凹形，中空同样会被投影。' },
  { key: 'v11', text: '所有读数与判定都可以复跑验证。在线就能打开，欢迎亲手推开这扇窗。' },
];

const voiceDur = {};
async function prepareVoice() {
  mkdirSync(VOICE_DIR, { recursive: true });
  for (const seg of NARRATION) {
    const file = join(VOICE_DIR, `${seg.key}.mp3`);
    if (!existsSync(file) || statSync(file).size < 1024) {
      process.stdout.write(`  合成 ${seg.key} … `);
      await synthesize(seg.text, { outPath: file, voice: VOICE, rate: '+0%' });
    }
    const d = probeDuration(file);
    voiceDur[seg.key] = d;
    console.log(`  ${seg.key}  ${d.toFixed(2)}s  ${seg.text.slice(0, 18)}…`);
  }
  const total = NARRATION.reduce((s, x) => s + voiceDur[x.key], 0);
  console.log(`旁白总时长 ${total.toFixed(1)}s`);
}

function probeDuration(file) {
  const r = spawnSync(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const v = Number(String(r.stdout ?? '').trim());
  return Number.isFinite(v) ? v : 0;
}

// ───────────────────────── CDP ─────────────────────────
let chromeProc = null;
function cleanup() {
  try {
    chromeProc?.kill();
  } catch {
    /* ignore */
  }
}

async function main() {
  // 重跑时先清掉上一轮的帧，避免 concat 混入旧图
  rmSync(FRAME_DIR, { recursive: true, force: true });
  mkdirSync(FRAME_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  console.log('\n[0] 生成旁白');
  await prepareVoice();

  console.log('\n[1] 启动浏览器');
  if (!existsSync(CHROME)) throw new Error('未找到 Chrome');
  const userDataDir = join(WORK_DIR, 'profile');
  // 默认有头：SwiftShader 无头渲染 1080p 只有 ~3fps，会把每次鼠标操作拖慢到几百毫秒；
  // 有头走真实 GPU，帧率与操作延迟都正常。需要无头时设 DEMO_HEADLESS=1。
  const headless = process.env.DEMO_HEADLESS === '1';
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--hide-scrollbars',
    `--window-size=${W},${H}`,
    '--window-position=0,0',
    '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-http-cache',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ];
  if (headless) {
    chromeArgs.unshift('--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader');
  }
  chromeProc = spawn(CHROME, chromeArgs, { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) {
        version = await r.json();
        break;
      }
    } catch {
      /* retry */
    }
    await sleep(400);
  }
  if (!version) throw new Error('Chrome 调试端口未就绪');
  console.log(`  ${version.Browser}`);

  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let msgId = 0;
  const pending = new Map();
  const pageErrors = [];
  const frames = []; // { file, ts }
  let frameWrites = Promise.resolve();

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result ?? {});
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'unknown');
      return;
    }
    if (msg.method === 'Page.screencastFrame') {
      const { data, metadata, sessionId } = msg.params;
      const idx = frames.length;
      const file = join(FRAME_DIR, `f${String(idx).padStart(5, '0')}.jpg`);
      frames.push({ file, ts: metadata.timestamp });
      frameWrites = frameWrites.then(() =>
        writeFile(file, Buffer.from(data, 'base64')).catch((e) => console.log('  ! 写帧失败', e.message)),
      );
      send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    }
  });

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  };
  const waitFor = async (expr, timeoutMs = 20000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await evaluate(expr)) return true;
      } catch {
        /* navigating */
      }
      await sleep(200);
    }
    return false;
  };

  // ── 真实鼠标 ──
  const mouseMove = (x, y, buttons = 0) =>
    send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons });
  const mouseDown = (x, y) =>
    send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  const mouseUp = (x, y) =>
    send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });

  async function moveTo(from, to, ms = 500, buttons = 0) {
    // 每次 dispatchMouseEvent 都有往返延迟，步数过多会把一次移动拖成好几秒，
    // 进而让点击比旁白晚很多；按 ~110ms 一步（最少 4 步）既顺滑又不失真。
    const steps = Math.max(4, Math.round(ms / 110));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t * t * (3 - 2 * t);
      await mouseMove(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e, buttons);
      await sleep(ms / steps);
    }
    await mouseMove(to.x, to.y, buttons);
    return to;
  }

  async function clickPoint(p, hold = 90) {
    if (!p) return false;
    await mouseMove(p.x, p.y);
    await sleep(120);
    await mouseDown(p.x, p.y);
    await sleep(hold);
    await mouseUp(p.x, p.y);
    await sleep(180);
    return true;
  }

  async function orbit(from, to, ms = 2200) {
    await mouseMove(from.x, from.y);
    await sleep(120);
    await mouseDown(from.x, from.y);
    await sleep(120);
    await moveTo(from, to, ms, 1);
    await sleep(120);
    await mouseUp(to.x, to.y);
    await sleep(200);
  }

  async function wheel(x, y, deltaY) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
    await sleep(160);
  }

  /**
   * 回到默认视角：点右侧面板的「复位视角」。
   * 每进入一个可交互界面都先做这一步，保证镜头从同一机位开始。
   */
  async function resetView(screenSel) {
    const btn = await centerOf(`${screenSel} button`, '复位视角');
    if (!btn) {
      console.log('  ! 未找到「复位视角」');
      return false;
    }
    await moveTo({ x: W * 0.8, y: H * 0.5 }, btn, 450);
    await clickPoint(btn);
    await sleep(400);
    return true;
  }

  async function keyEscape() {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(220);
  }

  // ── DOM 定位 ──
  const centerOf = (selector, text) =>
    evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const clean = (e) => (e.textContent || '').replace(/\\s+/g, ' ').trim();
      const el = ${text
        ? `els.find((e) => clean(e) === ${JSON.stringify(text)}) || els.find((e) => clean(e).includes(${JSON.stringify(text)}))`
        : 'els[0]'};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);

  const canvasPoint = (selector, fx, fy) =>
    evaluate(`(() => {
      const cv = document.querySelector(${JSON.stringify(selector)});
      if (!cv) return null;
      const r = cv.getBoundingClientRect();
      const px = r.left + r.width * ${fx};
      const py = r.top + r.height * ${fy};
      for (let ring = 0; ring < 16; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const x = px + dx * 16;
            const y = py + dy * 16;
            if (x < 4 || y < 4 || x > ${W - 4} || y > ${H - 4}) continue;
            if (document.elementFromPoint(x, y) === cv) return { x, y };
          }
        }
      }
      return null;
    })()`);

  // ── 页面准备 ──
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: false,
  });

  console.log('\n[2] 打开页面并预置存档');
  await send('Page.navigate', { url: URL_BASE });
  await sleep(3000);
  await waitFor('!!window.__lightShadow', 30000);
  const save = {
    version: 1,
    unlocked: 8,
    levels: Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7].map((id) => [
        id,
        { cleared: true, bestIou: 0.9 + id * 0.01, bestRank: 'excellent', bestMoves: 12 + id, hintsUsed: 0 },
      ]),
    ),
    soundEnabled: false,
    labUnlocked: true,
  };
  await evaluate(
    `localStorage.setItem('light-shadow-workshop.save.v1', ${JSON.stringify(JSON.stringify(save))})`,
  );
  await send('Page.reload', { ignoreCache: false });
  await sleep(3200);
  if (!(await waitFor('!!window.__lightShadow', 30000))) throw new Error('页面未就绪');
  await evaluate('document.fonts.ready.then(() => true)');

  // ── 光标浮层 ──
  await evaluate(`(() => {
    if (window.__demoCursor) return;
    const style = document.createElement('style');
    style.textContent = [
      '#__demo-cursor{position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;',
      'border:2px solid rgba(255,255,255,.95);',
      'background:radial-gradient(circle, rgba(255,255,255,.95) 0 20%, rgba(217,164,65,.72) 21% 100%);',
      'box-shadow:0 0 0 1px rgba(0,0,0,.55), 0 0 16px rgba(217,164,65,.9);',
      'pointer-events:none;z-index:2147483647;opacity:0;transform:translate(-200px,-200px);transition:opacity .3s}',
      '.demo-ripple{position:fixed;width:26px;height:26px;margin:-13px 0 0 -13px;border:1px solid rgba(255,255,255,.9);',
      'border-radius:50%;pointer-events:none;z-index:2147483646;animation:__demorip .55s ease-out forwards}',
      '@keyframes __demorip{from{transform:scale(.55);opacity:.9}to{transform:scale(4.4);opacity:0}}',
    ].join('');
    document.head.appendChild(style);
    const c = document.createElement('div');
    c.id = '__demo-cursor';
    document.documentElement.appendChild(c);
    window.__demoCursor = c;
    window.addEventListener('mousemove', (e) => {
      c.style.opacity = '1';
      c.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
    }, true);
    window.addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = 'demo-ripple';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 650);
    }, true);
  })()`);

  // ── 开始抓帧 ──
  console.log(`\n[3] 开始录制（${CAPTURE_MODE}）`);
  const marks = [];
  let stopShots = false;
  let shotLoop = null;
  if (CAPTURE_MODE === 'screencast') {
    await send('Page.startScreencast', {
      format: 'jpeg',
      quality: 90,
      maxWidth: W,
      maxHeight: H,
      everyNthFrame: 1,
    });
  } else {
    shotLoop = (async () => {
      let i = 0;
      while (!stopShots) {
        try {
          const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
          const file = join(FRAME_DIR, `f${String(i++).padStart(5, '0')}.jpg`);
          frames.push({ file, ts: now() });
          await writeFile(file, Buffer.from(r.data, 'base64'));
        } catch {
          /* ignore */
        }
        await sleep(70);
      }
    })();
  }

  // ── 分镜 ──
  let sceneStart = 0;
  /**
   * 把当前这一幕的旁白起点挪到"界面真正出现"的时刻。
   * 点击→转场有真实延迟，若按幕开始计时，旁白会早于画面好几秒。
   */
  const markNow = () => {
    const m = marks[marks.length - 1];
    if (m) m.t = now();
  };
  const scene = async (name, voiceKey, fn) => {
    sceneStart = now();
    marks.push({ name, t: sceneStart, voice: voiceKey });
    console.log(`\n▶ ${name}  (${voiceKey})`);
    try {
      await fn();
    } catch (e) {
      // 单幕失败不中断整条录制，日志里能一次看到所有问题
      console.warn(`  ⚠ ${name} 失败：${e.message}`);
    }
    const mark = marks[marks.length - 1];
    const target = mark.t + (voiceDur[voiceKey] ?? 0) + 0.6;
    const remain = target - now();
    if (remain > 0) await sleep(remain * 1000);
    console.log(`  ${name} 用时 ${(now() - sceneStart).toFixed(1)}s（旁白起点 +${(mark.t - sceneStart).toFixed(1)}s）`);
  };

  await sleep(900);

  // S1 首屏
  await scene('首屏', 'v1', async () => {
    // reload 后先等标题页的按钮真正挂上，避免在 DOM 还没渲染完时点空气
    await waitFor(`!!document.querySelector('.title-actions .btn')`, 15000);
    const btn = await centerOf('.title-actions .btn', '花窗工坊');
    const start = { x: W * 0.86, y: H * 0.9 };
    await mouseMove(start.x, start.y);
    await sleep(300);
    await moveTo(start, { x: W * 0.3, y: H * 0.62 }, 1300);
    await sleep(700);
    if (!btn) throw new Error('未找到「进入花窗工坊」');
    await moveTo({ x: W * 0.3, y: H * 0.62 }, btn, 900);
    await sleep(600);
    const probe = await evaluate(`(() => {
      const el = document.elementFromPoint(${btn.x}, ${btn.y});
      return el ? el.tagName + '.' + (el.className || '') : null;
    })()`);
    console.log(`  按钮中心命中：${probe}`);
    await clickPoint(btn);
    if (!(await waitFor(`!!document.querySelector('.workshop-screen')`, 4000))) {
      console.log('  ! 首次点击未进入工坊，重点一次');
      await clickPoint(btn);
      if (!(await waitFor(`!!document.querySelector('.workshop-screen')`, 4000))) {
        console.log('  ! 仍未进入，调用 workshop.open() 兜底');
        await evaluate('window.__lightShadow.workshop.open()');
      }
    }
    await waitFor(`!!document.querySelector('.workshop-screen')`, 8000);
  });

  // S2 工坊环绕
  await scene('工坊-载入与环绕', 'v2', async () => {
    if (!(await waitFor(`!!document.querySelector('.workshop-screen')`, 15000))) {
      throw new Error('花窗工坊未打开');
    }
    await sleep(900);
    markNow();
    await resetView('.workshop-screen');
    await sleep(400);
    const a = await canvasPoint('.workshop-screen .stage canvas', 0.79, 0.6);
    const b = await canvasPoint('.workshop-screen .stage canvas', 0.72, 0.58);
    if (a && b) await orbit(a, b, 2000);
  });

  // S3 纹样切换
  await scene('工坊-纹样切换', 'v3', async () => {
    await resetView('.workshop-screen');
    for (const id of ['ice-crack-style', 'three-cross-six-bowl-diamond', 'step-step-brocade']) {
      const p = await centerOf(`.pattern-card[data-pattern="${id}"]`);
      if (!p) {
        console.log(`  ! 未找到纹样 ${id}`);
        continue;
      }
      await moveTo({ x: W * 0.1, y: H * 0.5 }, p, 600);
      await clickPoint(p);
      await sleep(1050);
    }
  });

  // S4 自绘棂条
  await scene('工坊-自绘棂条', 'v4', async () => {
    await resetView('.workshop-screen');
    const drawBtn = await centerOf('.workshop-dock .btn', '画棂条');
    if (drawBtn) {
      await moveTo({ x: W * 0.5, y: H * 0.9 }, drawBtn, 700);
      await clickPoint(drawBtn);
    }
    await sleep(700);
    // 在窗格内部探测 3 个合法落点（用页内 hover 标签反查局部坐标）
    const pts = await evaluate(`(() => {
      const stage = document.querySelector('.workshop-screen .stage');
      const canvas = stage && stage.querySelector('canvas');
      if (!stage || !canvas) return [];
      const r = stage.getBoundingClientRect();
      const label = () => ((document.querySelector('.draw-hover-label') || {}).textContent || '').split(',').map(Number);
      const cands = [];
      for (let ix = 2; ix <= 19; ix++) {
        for (let iy = 2; iy <= 19; iy++) {
          const x = r.left + (r.width * ix) / 21;
          const y = r.top + (r.height * iy) / 21;
          if (document.elementFromPoint(x, y) !== canvas) continue;
          stage.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, pointerId: 21, bubbles: true }));
          const t = label();
          if (t.length !== 2 || !isFinite(t[0]) || !isFinite(t[1])) continue;
          if (cands.some((c) => Math.abs(c.lx - t[0]) < 0.4 && Math.abs(c.ly - t[1]) < 0.4)) continue;
          cands.push({ x, y, lx: t[0], ly: t[1] });
        }
      }
      if (cands.length < 3) return [];
      const maxX = Math.max(...cands.map((c) => Math.abs(c.lx)));
      const maxY = Math.max(...cands.map((c) => Math.abs(c.ly)));
      const inner = cands.filter((c) => Math.abs(c.lx) < maxX * 0.8 && Math.abs(c.ly) < maxY * 0.8);
      const pool = inner.length >= 3 ? inner : cands;
      const left = pool.reduce((a, b) => (b.lx < a.lx ? b : a));
      const right = pool.reduce((a, b) => (b.lx > a.lx ? b : a));
      const mid = pool.reduce((a, b) => (Math.abs(b.lx) < Math.abs(a.lx) ? b : a));
      return [left, mid, right].map((p) => ({ x: p.x, y: p.y }));
    })()`);
    if (!pts.length) {
      console.log('  ! 未探测到可用落点，跳过绘制');
      return;
    }
    let cursor = { x: W * 0.5, y: H * 0.52 };
    for (const p of pts) {
      await moveTo(cursor, p, 550);
      cursor = p;
      await clickPoint(p);
      await sleep(350);
    }
    // 悬停出橡皮筋与真实粗细的棂条预览
    const hover = await canvasPoint('.workshop-screen .stage canvas', 0.54, 0.42);
    if (hover) {
      await moveTo(cursor, hover, 700);
      await sleep(600);
    }
    const finish = await centerOf('.workshop-dock .btn', '完成线条');
    if (finish) {
      await moveTo(hover ?? cursor, finish, 500);
      await clickPoint(finish);
      await sleep(600);
    }
    await keyEscape();
    const drawing = await evaluate('window.__lightShadow.workshop.state().drawing');
    console.log(`  绘制模式退出：drawing=${drawing}`);
  });

  // S5 工坊收尾
  await scene('工坊-投影读数', 'v5', async () => {
    await resetView('.workshop-screen');
    const p = await canvasPoint('.workshop-screen .stage canvas', 0.55, 0.5);
    if (p) {
      await moveTo({ x: W * 0.5, y: H * 0.3 }, p, 700);
      await wheel(p.x, p.y, -120);
      await sleep(500);
      await wheel(p.x, p.y, -120);
    }
  });

  // S6 首页 → 光影挑战
  await scene('进入光影挑战', 'v6', async () => {
    const back = await centerOf('.workshop-screen .game-topbar .btn-icon');
    if (back) await clickPoint(back);
    await waitFor(`!!document.querySelector('.title-screen')`, 10000);
    markNow();
    await sleep(800);
    const ch = await centerOf('.title-actions .btn', '光影挑战');
    if (!ch) throw new Error('未找到「光影挑战」入口');
    await moveTo({ x: W * 0.5, y: H * 0.8 }, ch, 900);
    await sleep(500);
    await clickPoint(ch);
    await waitFor(`!!document.querySelector('.mode-screen')`, 10000);
    await sleep(1400);
    const enter = await centerOf('.mode-card.mode-levels .mode-actions .btn', '进入关卡');
    if (enter) {
      await moveTo({ x: W * 0.4, y: H * 0.5 }, enter, 700);
      await clickPoint(enter);
    }
    await waitFor(`!!document.querySelector('.level-screen')`, 10000);
    await sleep(1200);
  });

  // S7 关卡列表
  await scene('关卡列表', 'v7', async () => {
    await sleep(400);
    for (const idx of [2, 6, 8]) {
      const p = await evaluate(`(() => {
        const cards = [...document.querySelectorAll('.level-card')];
        const el = cards[${idx}];
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (p) await moveTo({ x: W * 0.5, y: H * 0.5 }, p, 600);
    }
    await sleep(600);
    const first = await centerOf('.level-card', '光的初遇');
    if (!first) throw new Error('未找到第 1 关');
    await moveTo({ x: W * 0.5, y: H * 0.55 }, first, 700);
    await sleep(500);
    await clickPoint(first);
    await waitFor(`!!document.querySelector('.game-screen')`, 10000);
    await sleep(1800);
  });

  // S8 第 1 关：真实拖拽通关
  await scene('第 1 关-拖拽通关', 'v8', async () => {
    await resetView('.game-screen');
    markNow();
    const c = await canvasPoint('.studio-canvas', 0.86, 0.7);
    const c2 = await canvasPoint('.studio-canvas', 0.8, 0.68);
    if (c && c2) await orbit(c, c2, 1900);

    const pos = await evaluate(`(() => {
      const api = window.__lightShadow;
      return { from: api.screenPos('block'), to: api.targetScreenPos('block'), hit: api.hitTest(api.screenPos('block').x, api.screenPos('block').y) };
    })()`);
    console.log(`  方块 ${JSON.stringify(pos.from)} → ${JSON.stringify(pos.to)}  hit=${pos.hit}`);
    if (pos.hit) {
      await moveTo({ x: W * 0.8, y: H * 0.5 }, pos.from, 600);
      await sleep(250);
      await mouseDown(pos.from.x, pos.from.y);
      await sleep(200);
      await moveTo(pos.from, pos.to, 2800, 1);
      await sleep(150);
      await mouseUp(pos.to.x, pos.to.y);
    } else {
      const alt = await evaluate(`(() => {
        const p = window.__lightShadow.screenPos('block');
        for (const [dx, dy] of [[0,0],[18,0],[-18,0],[0,18],[0,-18]]) {
          if (window.__lightShadow.hitTest(p.x + dx, p.y + dy)) return { x: p.x + dx, y: p.y + dy };
        }
        return null;
      })()`);
      console.log(`  ! 未命中，改用 ${JSON.stringify(alt)}`);
      if (alt) {
        await moveTo({ x: W * 0.8, y: H * 0.5 }, alt, 500);
        await mouseDown(alt.x, alt.y);
        await sleep(200);
        await moveTo(alt, pos.to, 2800, 1);
        await mouseUp(pos.to.x, pos.to.y);
      }
    }

    const ok = await waitFor(`!!document.querySelector('.modal-mask .modal')`, 9000);
    const state = await evaluate('window.__lightShadow.getState()');
    console.log(`  通关弹窗=${ok}  IoU=${state.lastIou}  moves=${state.moves}`);
    await sleep(1500);
  });

  // S9 第 8 关
  await scene('第 8 关', 'v9', async () => {
    const back = await centerOf('.modal-mask .btn', '返回关卡选择');
    if (back) await clickPoint(back);
    await waitFor(`!!document.querySelector('.level-screen')`, 10000);
    await sleep(1000);
    const card8 = await evaluate(`(() => {
      const el = [...document.querySelectorAll('.level-card')][7];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!card8) throw new Error('未找到第 8 关');
    await moveTo({ x: W * 0.5, y: H * 0.6 }, card8, 800);
    await sleep(500);
    await clickPoint(card8);
    await waitFor(`!!document.querySelector('.game-screen')`, 10000);
    await sleep(1400);
    markNow();
    await resetView('.game-screen');
    const c = await canvasPoint('.studio-canvas', 0.86, 0.7);
    const c2 = await canvasPoint('.studio-canvas', 0.78, 0.66);
    if (c && c2) await orbit(c, c2, 2600);
  });

  // S10 自由实验室
  await scene('自由实验室', 'v10', async () => {
    const back = await centerOf('.game-screen .game-topbar .btn-icon');
    if (back) await clickPoint(back);
    await waitFor(`!!document.querySelector('.level-screen')`, 10000);
    await sleep(900);
    const lab = await centerOf('.level-screen .header-actions .btn', '自由实验室');
    if (!lab) throw new Error('未找到「自由实验室」');
    await moveTo({ x: W * 0.4, y: H * 0.2 }, lab, 700);
    await clickPoint(lab);
    if (!(await waitFor(`!!document.querySelector('.lab-screen')`, 12000))) throw new Error('实验室未打开');
    await sleep(900);
    markNow();
    await resetView('.lab-screen');
    for (const name of ['十字形', '五角星', '圆环']) {
      const p = await centerOf('.lab-add-grid .btn', name);
      if (!p) {
        console.log(`  ! 未找到形状 ${name}`);
        continue;
      }
      await moveTo({ x: W * 0.86, y: H * 0.4 }, p, 500);
      await clickPoint(p);
      await sleep(450);
    }
    const c = await canvasPoint('.studio-canvas', 0.8, 0.7);
    const c2 = await canvasPoint('.studio-canvas', 0.72, 0.66);
    if (c && c2) await orbit(c, c2, 2000);
  });

  // S11 回到首页
  await scene('回到首页', 'v11', async () => {
    const back = await centerOf('.lab-screen .game-topbar .btn-icon');
    if (back) await clickPoint(back);
    await waitFor(`!!document.querySelector('.mode-screen')`, 10000);
    await sleep(900);
    const title = await centerOf('.mode-screen .header-actions .btn', '返回标题页');
    if (title) {
      await moveTo({ x: W * 0.5, y: H * 0.2 }, title, 700);
      await clickPoint(title);
    }
    await waitFor(`!!document.querySelector('.title-screen')`, 10000);
    markNow();
    await sleep(1200);
    await moveTo({ x: W * 0.62, y: H * 0.45 }, { x: W * 0.42, y: H * 0.33 }, 1400);
    await sleep(2500);
  });

  const endTime = now();
  await sleep(1200);

  // ── 停止抓帧 ──
  if (CAPTURE_MODE === 'screencast') {
    await send('Page.stopScreencast').catch(() => {});
  } else {
    stopShots = true;
    await shotLoop;
  }
  await sleep(600);
  await frameWrites;
  ws.close();

  // screencast 帧可能乱序到达（重负载时旧帧晚到）：先按时间戳排序，
  // 否则拼接时会把旧画面放到后面，造成画面比旁白晚好几秒。
  let unordered = 0;
  for (let i = 1; i < frames.length; i++) if (frames[i].ts < frames[i - 1].ts) unordered++;
  frames.sort((a, b) => a.ts - b.ts);
  console.log(`  乱序帧：${unordered}`);

  console.log(`\n[4] 抓帧完成：${frames.length} 帧，录制 ${(endTime - frames[0].ts).toFixed(1)}s`);
  if (frames.length < 30) throw new Error('抓到的帧太少，录制失败');
  const fps = frames.length / (frames[frames.length - 1].ts - frames[0].ts);
  console.log(`  平均 ${fps.toFixed(1)} fps`);

  // ── 编码 ──
  console.log('\n[5] 生成字幕与混音');
  const t0 = frames[0].ts;
  const captions = buildAss(marks, t0, endTime - t0 + 1.2, marks);
  writeFileSync(join(WORK_DIR, 'captions.ass'), captions, 'utf8');

  const audioFile = join(WORK_DIR, 'narration.wav');
  const audioArgs = [];
  const filters = [];
  NARRATION.forEach((seg, i) => {
    audioArgs.push('-i', join(VOICE_DIR, `${seg.key}.mp3`));
    const mark = marks.find((m) => m.voice === seg.key);
    const delay = Math.max(0, Math.round(((mark?.t ?? t0) - t0) * 1000));
    filters.push(`[${i}:a]adelay=${delay}:all=1[a${i}]`);
  });
  const mixIn = NARRATION.map((_, i) => `[a${i}]`).join('');
  filters.push(
    `${mixIn}amix=inputs=${NARRATION.length}:normalize=0:dropout_transition=0,` +
      'loudnorm=I=-16:TP=-1.5:LRA=11[voice]',
  );
  runFfmpeg(['-y', ...audioArgs, '-filter_complex', filters.join(';'), '-map', '[voice]', '-c:a', 'pcm_s16le', audioFile], '混音');

  console.log('\n[6] 编码视频');
  const concatFile = join(WORK_DIR, 'frames.txt');
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < frames.length; i++) {
    // 页面静止时 screencast 不会出新帧，间隔可能就是真实的停留时长：
    // 允许较长的单帧显示时间（最多 12s）。下限必须取真实值（只防 0），
    // 否则每帧都被抬到 22ms 以上，几千帧累加会把整片拉长好几秒、画面越来越落后于旁白。
    const next = i + 1 < frames.length ? frames[i + 1].ts : frames[i].ts + 0.45;
    const dur = Math.min(12, Math.max(0.002, next - frames[i].ts));
    lines.push(`file '${frames[i].file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${dur.toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file.replace(/\\/g, '/')}'`);
  lines.push('duration 0.45');
  writeFileSync(concatFile, lines.join('\n'), 'utf8');

  const videoDur = endTime - t0 + 1.2;
  const vf =
    `fps=30,ass=captions.ass,fade=t=in:st=0:d=0.7,` +
    `fade=t=out:st=${(videoDur - 1.1).toFixed(2)}:d=1.1`;

  runFfmpeg(
    [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-i', audioFile,
      '-vf', vf,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '19',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-c:a', 'aac',
      '-b:a', '192k',
      // 旁白比画面略短时用静音补齐，避免 -shortest 把结尾淡出截掉
      '-af', 'apad=pad_dur=6',
      '-shortest',
      '-movflags', '+faststart',
      OUT_FILE,
    ],
    '编码',
    WORK_DIR,
  );

  console.log(`\n✅ ${OUT_FILE}`);
  if (!process.env.DEMO_KEEP_FRAMES) {
    try {
      rmSync(FRAME_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  if (pageErrors.length) console.log(`页面异常：${pageErrors.slice(0, 3).join(' | ')}`);
  console.log(`临时目录：${WORK_DIR}`);
}

/** 运行 ffmpeg，把输出透传到控制台 */
function runFfmpeg(args, label, cwd) {
  console.log(`  ffmpeg ${label} …`);
  const r = spawnSync(FFMPEG, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg ${label} 失败（exit ${r.status}）`);
}

/** 由场景打点生成 ASS 字幕（每个场景一条，最多两行） */
function buildAss(marks, t0, totalDur, allMarks) {
  const assTime = (s) => {
    const v = Math.max(0, s);
    const h = Math.floor(v / 3600);
    const m = Math.floor((v % 3600) / 60);
    const sec = v % 60;
    return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
  };
  const split = (text) => {
    const max = 17;
    if (text.length <= max) return text;
    const mid = Math.floor(text.length / 2);
    let cut = -1;
    for (let d = 0; d < 9 && cut < 0; d++) {
      for (const i of [mid - d, mid + d]) {
        if (i > 4 && i < text.length - 4 && /[，。；：、！？—]/.test(text[i])) {
          cut = i + 1;
          break;
        }
      }
    }
    if (cut < 0) cut = mid;
    return `${text.slice(0, cut)}\\N${text.slice(cut)}`;
  };

  const events = [];
  for (const mark of allMarks) {
    const seg = NARRATION.find((x) => x.key === mark.voice);
    if (!seg) continue;
    const start = mark.t - t0;
    const next = allMarks.find((m) => m.t > mark.t);
    const end = Math.min(start + (voiceDur[seg.key] ?? 0) + 0.35, (next ? next.t - t0 : totalDur) - 0.05);
    events.push({ start, end, text: split(seg.text) });
  }
  // 结尾补一条可验证入口
  const tailStart = Math.max(totalDur - 4.2, 0);
  events.push({
    start: tailStart,
    end: totalDur - 0.2,
    text: '在线试玩　anontomorin.github.io/light-shadow-workshop-new',
  });

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,KaiTi,42,&H00FFFFFF,&H00FFFFFF,&H00202020,&H78000000,0,0,0,0,100,100,1.2,0,3,2,0,2,160,160,96,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const body = events.map(
    (e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Default,,0,0,0,,${e.text}`,
  );
  return `${header.concat(body).join('\n')}\n`;
}

main()
  .catch((e) => {
    console.error('\n❌', e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
