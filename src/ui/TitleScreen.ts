import { h } from './dom';
import { patternSvgElement } from './patternSvg';
import { buildDocumentFromPattern } from '../window-builder/WindowDocument';
import { clampPatternParameters } from '../window-builder/GeometryLimits';
import { patternDisplayName } from '../patterns/PatternRegistry';
import type { PatternKind, PatternParameters } from '../patterns/types';

/**
 * 首页（中国风 · 以花窗工坊为主线）。
 *
 * 设计要点
 *  1. **主视觉是真实产物**：右侧那扇花窗不是图片素材，而是调用纹样生成器的
 *     同一份 `WindowDocument` 画出来的 SVG；影子是同一张图的一次深色重绘
 *     （改填充 + 模糊 + 偏移），所以首页展示的正是工坊里能编出来的东西。
 *  2. **三扇花窗轮播**：步步锦 / 冰裂纹 / 三交六椀菱花依次交叉淡入，
 *     朱砂印章上的题名与底部说明行随之切换——三种都是工坊里可选的经典纹样，
 *     不是预制动画。轮播只切换 `is-active`，三份 SVG 一次生成、常驻 DOM。
 *  3. **入口分层**：一级入口只有「花窗工坊」；原有的「影形解谜」与「自由实验室」
 *     收进二级入口「光影挑战」（见 ModeSelect），首页因此保持单一主线。
 *  4. 装饰全部由 CSS 生成（宣纸底、回纹边、印章、窗棂暗纹），不含任何位图，
 *     也就没有外部资源依赖。
 *
 * 按钮顺序（`.title-actions .btn`）：
 *   0 进入花窗工坊   1 纹样图鉴   2 光影挑战（二级入口）   3 作品与资料
 */

export interface TitleHandlers {
  /** 一级入口：花窗工坊 */
  onWorkshop: () => void;
  /** 纹样图鉴（窗棂初识） */
  onGallery: () => void;
  /** 二级入口：光影挑战（影形解谜 + 自由实验室） */
  onChallenge: () => void;
  /** 作品与资料 */
  onAbout: () => void;
}

/** 主视觉画布尺寸（与 `.title-hero` 的 5:6 比例一致） */
const HERO_SIZE = { w: 300, h: 452 };
/** 棂条墨色 / 影子墨色 */
const BAR_INK = '#7d5230';
const SHADOW_INK = '#1d2b34';
/** 轮播停留时长；印章换字时的淡出时长 */
const HERO_INTERVAL_MS = 4200;
const SEAL_SWAP_MS = 220;

interface HeroSlide {
  /** 纹样 id：与工坊共用同一份生成器，所以首页画的就是工坊能编的 */
  kind: PatternKind;
  /** 印章上的题名。文化卡片里的全名带括号注解（如「三交六椀菱花式（数字示意）」），
   *  竖排印章放不下，这里用可辨识的短名。 */
  sealName: string;
  parameters: PatternParameters;
}

/**
 * 三扇窗共用同一副窗框尺寸（与「纹样图鉴」的默认参数一致），
 * 只有行列数与种子不同 —— 切换时窗框大小不会跳变。
 *
 * barWidth 必须留在 0.09：三交六椀菱花生成器里有 `r < barWidth * 1.2` 就丢弃花心的门槛，
 * 用 0.1 时 r=0.108 < 0.12，整片六椀花心会被静默跳过，只剩三角格网。
 */
const HERO_BASE = { width: 3.2, height: 4.6, frameWidth: 0.2, barWidth: 0.09 };

const heroParameters = (
  rowCount: number,
  columnCount: number,
  seed: number,
  density = 0.85,
): PatternParameters => clampPatternParameters({ ...HERO_BASE, rowCount, columnCount, seed, density });

/**
 * 轮播的三扇窗。三者的行列参数各自适配自己的构造方式：
 *  - 步步锦看 rowCount / columnCount（3×3 的方形锦格，与原首页一致）；
 *  - 冰裂纹同样吃网格，但竖长的窗心用 5 行 3 列更接近细碎冰裂；
 *  - 三交六椀菱花由等距三角格网推出，4×4 时格面尺度才容得下六椀花心。
 * 种子固定，所以每次打开首页看到的是同一扇窗，不会闪烁变化。
 */
const HERO_SLIDES: HeroSlide[] = [
  {
    kind: 'step-step-brocade',
    sealName: '步步锦',
    parameters: heroParameters(3, 3, 20261015),
  },
  {
    kind: 'ice-crack-style',
    sealName: '冰裂纹',
    parameters: heroParameters(5, 3, 19870, 0.86),
  },
  {
    kind: 'three-cross-six-bowl-diamond',
    sealName: '三交六椀菱花',
    parameters: heroParameters(4, 4, 20261015),
  },
];

/** 确定性伪随机：装饰粒子的位置每次打开都一样，不会闪烁重排 */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 流萤：金色微光从画面下缘缓缓升起 */
function moteField(): HTMLElement {
  const rand = seeded(20261021);
  const field = h('div', { class: 'mote-field', 'aria-hidden': 'true' });
  for (let i = 0; i < 28; i++) {
    const mote = h('i', { class: 'mote' });
    mote.style.setProperty('--x', `${rand() * 100}%`);
    mote.style.setProperty('--y', `${45 + rand() * 55}%`);
    mote.style.setProperty('--size', `${1.5 + rand() * 3.4}px`);
    mote.style.setProperty('--delay', `${rand() * 14}s`);
    mote.style.setProperty('--dur', `${9 + rand() * 11}s`);
    mote.style.setProperty('--mote-op', `${0.35 + rand() * 0.5}`);
    mote.style.setProperty('--mote-sway', `${-60 + rand() * 120}px`);
    field.append(mote);
  }
  return field;
}

/** 落英：极淡的纸色花瓣，只在右侧留白处飘过 */
function petalField(): HTMLElement {
  const rand = seeded(19870);
  const field = h('div', { class: 'petal-field', 'aria-hidden': 'true' });
  for (let i = 0; i < 14; i++) {
    const petal = h('i', { class: 'petal' });
    petal.style.setProperty('--x', `${18 + rand() * 78}%`);
    petal.style.setProperty('--delay', `${rand() * 18}s`);
    petal.style.setProperty('--dur', `${16 + rand() * 12}s`);
    petal.style.setProperty('--petal-sway', `${-80 + rand() * 200}px`);
    petal.style.setProperty('--petal-size', `${5 + rand() * 6}px`);
    field.append(petal);
  }
  return field;
}

export class TitleScreen {
  readonly root: HTMLElement;

  private readonly frames: HTMLElement[] = [];
  private readonly dots: HTMLElement[] = [];
  private readonly sealEl: HTMLElement;
  private readonly captionEl: HTMLElement;
  private heroIndex = 0;
  private rotateTimer: number | null = null;
  private swapTimer: number | null = null;

  constructor(handlers: TitleHandlers, version = 'v3.0.0') {
    // ── 三扇窗：各自生成一份 SVG，影子由窗格克隆改色而来（省一次几何重算） ──
    HERO_SLIDES.forEach((slide, i) => {
      const doc = buildDocumentFromPattern({
        patternId: slide.kind,
        name: patternDisplayName(slide.kind),
        parameters: slide.parameters,
      });
      const windowSvg = patternSvgElement(doc, {
        width: HERO_SIZE.w,
        height: HERO_SIZE.h,
        ink: BAR_INK,
        // 纸底直接画在 SVG 里，与窗格共用同一套坐标 / 同一个 3D 变换，
        // 窗框与它后面的"白纸"因此严丝合缝，不会再错位出一圈白边。
        background: '#fbf1dc',
      });
      windowSvg.classList.add('hero-svg');
      // 影子 = 同一份窗格换墨色，所以"影子就是这扇窗投出来的"在数据上成立。
      // 影子只要棂条，不要那张纸。
      const shadowSvg = windowSvg.cloneNode(true) as SVGSVGElement;
      shadowSvg.querySelector('rect')?.remove();
      shadowSvg.querySelectorAll('polygon').forEach((poly) => poly.setAttribute('fill', SHADOW_INK));

      const frame = h(
        'div',
        { class: `hero-frame${i === 0 ? ' is-active' : ''}`, 'aria-hidden': i === 0 ? 'false' : 'true' },
        [
          h('div', { class: 'hero-shadow' }, [shadowSvg]),
          h('div', { class: 'hero-window' }, [windowSvg]),
        ],
      );
      this.frames.push(frame);
    });

    const hero = h('div', { class: 'title-hero' }, [
      ...this.frames,
      h(
        'div',
        { class: 'hero-dots', role: 'tablist', 'aria-label': '花窗样式' },
        HERO_SLIDES.map((slide, i) => {
          const dot = h('button', {
            class: `hero-dot${i === 0 ? ' is-current' : ''}`,
            type: 'button',
            role: 'tab',
            title: `${slide.sealName}（点击切换）`,
            'aria-label': slide.sealName,
            'aria-selected': i === 0 ? 'true' : 'false',
            onclick: () => this.goToHero(i),
          });
          this.dots.push(dot);
          return dot;
        }),
      ),
      (this.captionEl = h('div', {
        class: 'hero-caption tiny',
        text: `${patternDisplayName(HERO_SLIDES[0].kind)} · 窗格示意图由纹样生成器实时绘制`,
      })),
    ]);

    // 朱砂印章：题名随轮播切换（第一帧先落位，避免开场空一瞬）
    this.sealEl = h('div', {
      class: 'title-seal',
      text: HERO_SLIDES[0].sealName,
      'aria-hidden': 'true',
    });

    const content = h('div', { class: 'title-content' }, [
      h('div', { class: 'title-mark' }, [
        h('span', { class: 'mark-rule' }),
        h('span', { text: '中国传统建筑窗棂 · 光影创作' }),
      ]),
      h(
        'h1',
        { class: 'title-main', 'aria-label': '光影工坊' },
        [...'光影工坊'].map((ch, i) => {
          const span = h('span', { class: 'title-char', text: ch, 'aria-hidden': 'true' });
          span.style.setProperty('--i', String(i));
          return span;
        }),
      ),
      h('div', { class: 'title-sub', text: '窗 棂 之 間' }),
      this.sealEl,
      h('p', {
        class: 'title-desc',
        text: '认识传统窗棂的构成，编出一扇自己的花窗，再调节灯光与位置 —— 让墙上那一片影子，成为一件作品。',
      }),
      h('div', { class: 'title-actions' }, [
        h('button', {
          class: 'btn btn-primary btn-lg',
          text: '进入花窗工坊',
          title: '参数化花窗编辑，实时真实投影',
          onclick: handlers.onWorkshop,
        }),
        h('button', {
          class: 'btn btn-lg btn-workshop',
          text: '纹样图鉴',
          title: '认识传统纹样与它们的文化来源',
          onclick: handlers.onGallery,
        }),
        h('button', {
          class: 'btn btn-lg btn-challenge',
          text: '光影挑战',
          title: '影形解谜（关卡）与自由实验室',
          onclick: handlers.onChallenge,
        }),
        h('button', {
          class: 'btn btn-lg btn-ghost',
          text: '作品与资料',
          title: '我的作品、文化来源与项目说明',
          onclick: handlers.onAbout,
        }),
      ]),
    ]);

    this.root = h('section', { class: 'screen title-screen' }, [
      h('div', { class: 'title-decor' }, [
        h('div', { class: 'title-photo', 'aria-hidden': 'true' }),
        h('div', { class: 'title-moon' }),
        h('div', { class: 'title-lattice-bg' }),
        h('div', { class: 'title-mist title-mist-1' }),
        h('div', { class: 'title-mist title-mist-2' }),
        h('div', { class: 'title-mist title-mist-3' }),
        h('div', { class: 'title-ridge' }),
        h('div', { class: 'title-ridge title-ridge-2' }),
        moteField(),
        petalField(),
      ]),
      content,
      hero,
      h('div', { class: 'title-footer', text: `光影工坊 · 窗棂之间 ${version}` }),
    ]);

    this.startRotation();
  }

  // ───────────────────────── 花窗轮播 ─────────────────────────

  /**
   * 启动自动轮播。
   * 若用户开启了「减少动态效果」，则不做自动切换，静态停在第一扇窗上
   * （印章与说明行仍是第一扇的题名，信息不缺失）。
   */
  private startRotation(): void {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    this.rotateTimer = window.setInterval(() => this.advanceHero(), HERO_INTERVAL_MS);
  }

  /** 点击指示点：立即切到指定窗并重置计时，避免刚点完就被自动轮播抢走 */
  private goToHero(index: number): void {
    if (index === this.heroIndex) return;
    this.heroIndex = index;
    this.paintHero();
    if (this.rotateTimer !== null) {
      window.clearInterval(this.rotateTimer);
      this.rotateTimer = null;
      this.startRotation();
    }
  }

  private advanceHero(): void {
    // 首页被切走（root 已脱离文档）或标签页隐藏时，跳过这一拍
    if (!this.root.isConnected || document.hidden) return;
    this.heroIndex = (this.heroIndex + 1) % this.frames.length;
    this.paintHero();
  }

  /** 把当前帧同步到 DOM：窗格交叉淡入 + 指示点高亮 + 印章与说明行换字 */
  private paintHero(): void {
    this.frames.forEach((frame, i) => {
      const active = i === this.heroIndex;
      frame.classList.toggle('is-active', active);
      frame.setAttribute('aria-hidden', active ? 'false' : 'true');
    });
    this.dots.forEach((dot, i) => {
      const current = i === this.heroIndex;
      dot.classList.toggle('is-current', current);
      dot.setAttribute('aria-selected', current ? 'true' : 'false');
    });

    // 文字没法做过渡，改成一次短暂淡出再落新字
    this.sealEl.classList.add('is-swapping');
    if (this.swapTimer !== null) window.clearTimeout(this.swapTimer);
    const index = this.heroIndex;
    this.swapTimer = window.setTimeout(() => {
      const slide = HERO_SLIDES[index];
      this.sealEl.textContent = slide.sealName;
      this.captionEl.textContent = `${patternDisplayName(slide.kind)} · 窗格示意图由纹样生成器实时绘制`;
      this.sealEl.classList.remove('is-swapping');
      this.swapTimer = null;
    }, SEAL_SWAP_MS);
  }
}
