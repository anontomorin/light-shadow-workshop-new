import { h, sliderRow } from './dom';
import { createViewPanel, type ViewPanel } from './viewPanel';
import type { ViewPreset, ViewState } from '../scene/SceneManager';
import type { LevelControls, LevelDefinition, Transform3D } from '../gameplay/LevelData';
import { OBJECT_LIMITS } from '../projection/Projector';
import type { LightState } from '../gameplay/LightController';
import type { ShadowObjectDefinition } from '../gameplay/LevelData';

/** 游戏主界面：三维舞台 + 右侧控制面板 + 底部操作坞 */

/** 面内旋转的单步角度 */
const ROTATE_STEP = 5;

/** 光源滑杆的可用范围 */
export interface LightLimits {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface GameHUDHandlers {
  onBack: () => void;
  onPause: () => void;
  onHint: () => void;
  onReset: () => void;
  onNext: () => void;
  onSelectObject: (id: string) => void;
  onRotate: (delta: number) => void;
  onRotateTo: (deg: number) => void;
  onFlip: (deg: number) => void;
  onDepth: (z: number) => void;
  onLightAxis: (axis: 'x' | 'y' | 'z', value: number) => void;
  onViewChange: (part: Partial<ViewState>) => void;
  onViewPreset: (name: ViewPreset) => void;
  onViewReset: () => void;
}

export class GameHUD {
  readonly root: HTMLElement;
  readonly stageEl: HTMLElement;
  readonly modalHost: HTMLElement;

  private handlers: GameHUDHandlers;
  private level: LevelDefinition | null = null;

  private titleEl: HTMLElement;
  private noEl: HTMLElement;
  private tutorialEl: HTMLElement;

  private chipsEl: HTMLElement;
  private objectPanel: HTMLElement;
  private objectBody: HTMLElement;
  private lightPanel: HTMLElement;
  private lightBody: HTMLElement;
  private hintBox: HTMLElement;

  private matchFill: HTMLElement;
  private matchGoal: HTMLElement;
  private matchReadout: HTMLElement;
  private movesEl: HTMLElement;
  private nextBtn: HTMLButtonElement;
  private hintBtn: HTMLButtonElement;

  private depthSlider: ReturnType<typeof sliderRow> | null = null;
  private flipSlider: ReturnType<typeof sliderRow> | null = null;
  private rotSlider: ReturnType<typeof sliderRow> | null = null;
  private lightSliders: Record<string, ReturnType<typeof sliderRow>> = {};
  private viewPanel: ViewPanel;

  private readoutEls: Record<string, HTMLElement> = {};

  constructor(handlers: GameHUDHandlers) {
    this.handlers = handlers;

    // ---------- 顶部栏 ----------
    this.noEl = h('div', { class: 'lv', text: 'LEVEL 01' });
    this.titleEl = h('div', { class: 'name', text: '' });
    this.tutorialEl = h('div', { class: 'tutorial-bar hidden' });

    const topbar = h('div', { class: 'game-topbar' }, [
      h('button', {
        class: 'btn btn-icon',
        title: '返回关卡选择',
        'aria-label': '返回关卡选择',
        text: '←',
        onclick: handlers.onBack,
      }),
      h('div', { class: 'topbar-seal', text: '影', 'aria-hidden': 'true' }),
      h('div', { class: 'topbar-info' }, [this.noEl, this.titleEl]),
      h('div', { class: 'topbar-spacer' }),
      h('button', {
        class: 'btn btn-icon',
        title: '暂停 (Esc)',
        'aria-label': '暂停',
        text: '❚❚',
        onclick: handlers.onPause,
      }),
    ]);

    // ---------- 舞台 ----------
    this.stageEl = h('div', { class: 'stage' });
    const stageWrap = h('div', { class: 'stage-wrap' }, [
      this.stageEl,
      h('div', { class: 'stage-vignette', 'aria-hidden': 'true' }),
      h('div', { class: 'stage-frame', 'aria-hidden': 'true' }, [
        h('i', { class: 'sf-corner tl' }),
        h('i', { class: 'sf-corner tr' }),
        h('i', { class: 'sf-corner bl' }),
        h('i', { class: 'sf-corner br' }),
      ]),
      h('div', { class: 'stage-burst-layer', 'aria-hidden': 'true' }),
      topbar,
      this.tutorialEl,
    ]);
    this.modalHost = stageWrap;

    // ---------- 底部操作坞 ----------
    this.matchFill = h('div', { class: 'match-fill' });
    this.matchGoal = h('div', { class: 'match-goal' });
    this.matchReadout = h('div', { class: 'match-readout', text: '0%' });
    this.movesEl = h('span', { class: 'badge', text: '操作 0 次' });

    this.hintBtn = h('button', {
      class: 'btn btn-sm',
      text: '提示 (H)',
      onclick: handlers.onHint,
    }) as HTMLButtonElement;
    this.nextBtn = h('button', {
      class: 'btn btn-sm btn-primary',
      text: '下一关',
      disabled: true,
      onclick: handlers.onNext,
    }) as HTMLButtonElement;

    const dock = h('div', { class: 'game-dock' }, [
      h('div', { class: 'match-meter' }, [
        h('span', { class: 'match-label', text: '轮廓匹配度' }),
        h('div', { class: 'match-bar' }, [this.matchFill, this.matchGoal]),
        this.matchReadout,
      ]),
      this.movesEl,
      h('div', { class: 'dock-actions' }, [
        this.hintBtn,
        h('button', { class: 'btn btn-sm', text: '重置 (R)', onclick: handlers.onReset }),
        this.nextBtn,
      ]),
    ]);

    // ---------- 右侧面板 ----------
    this.chipsEl = h('div', { class: 'object-chips' });
    this.objectBody = h('div', {});
    this.objectPanel = h('div', { class: 'side-section' }, [
      h('h3', { text: '选中物体' }),
      this.objectBody,
    ]);
    this.lightBody = h('div', {});
    this.lightPanel = h('div', { class: 'side-section' }, [
      h('h3', { text: '光源控制' }),
      this.lightBody,
    ]);
    this.hintBox = h('div', { class: 'side-section hidden' }, [
      h('h3', { text: '提示' }),
      h('div', { class: 'side-hint' }),
    ]);

    this.viewPanel = createViewPanel({
      onViewChange: handlers.onViewChange,
      onViewPreset: handlers.onViewPreset,
      onViewReset: handlers.onViewReset,
    });

    const sidePanel = h('aside', { class: 'side-panel' }, [
      h('div', { class: 'panel-ornament', 'aria-hidden': 'true' }, [
        h('span', { class: 'panel-ornament-rule' }),
        h('span', { class: 'panel-ornament-cn', text: '观 影' }),
        h('span', { class: 'panel-ornament-rule' }),
      ]),
      h('div', { class: 'side-section' }, [h('h3', { text: '场景物体' }), this.chipsEl]),
      this.objectPanel,
      h('div', { class: 'side-section' }, [h('h3', { text: '观看视角' }), this.viewPanel.root]),
      this.lightPanel,
      this.hintBox,
      h('div', { class: 'side-section' }, [
        h('h3', { text: '操作说明' }),
        h('div', { class: 'keyhint' }, [
          h('div', {}, ['左键点物体 = 选中；按住拖动 = 移动']),
          h('div', {}, [
            h('span', { class: 'kbd', text: 'Q' }),
            ' / ',
            h('span', { class: 'kbd', text: 'E' }),
            ' = 旋转 5°（Shift 加速）',
          ]),
          h('div', {}, ['方向键 = 微调位置（Shift 加速）']),
          h('div', {}, ['左键拖空白处 = 环绕视角；滚轮 = 缩放']),
          h('div', {}, [
            h('span', { class: 'kbd', text: 'R' }),
            ' = 重置关卡　',
            h('span', { class: 'kbd', text: 'H' }),
            ' = 提示',
          ]),
          h('div', {}, [h('span', { class: 'kbd', text: 'Esc' }), ' = 暂停 / 关闭弹窗']),
        ]),
      ]),
    ]);

    this.root = h('section', { class: 'screen game-screen' }, [stageWrap, sidePanel, dock]);
  }

  // ───────────────────────── 关卡 ─────────────────────────

  setLevel(level: LevelDefinition): void {
    this.level = level;
    this.noEl.textContent = `LEVEL ${String(level.id).padStart(2, '0')}`;
    this.titleEl.textContent = level.title;
    this.matchGoal.style.left = `${level.matchThreshold * 100}%`;
    this.nextBtn.disabled = true;

    if (level.tutorial) {
      this.tutorialEl.textContent = level.tutorial;
      this.tutorialEl.classList.remove('hidden');
    } else {
      this.tutorialEl.classList.add('hidden');
    }

    // 物体选择 chips
    this.chipsEl.replaceChildren();
    for (const obj of level.objects) {
      const chip = h(
        'button',
        {
          class: 'chip',
          'aria-pressed': 'false',
          onclick: () => this.handlers.onSelectObject(obj.id),
        },
        [h('span', { class: 'dot', style: { background: obj.color } }), obj.name],
      );
      chip.dataset.id = obj.id;
      this.chipsEl.append(chip);
    }

    this.buildObjectPanel(level.controls);
    this.buildLightPanel(level.controls);
    this.setLight(level.light.initial, {
      minX: -6,
      maxX: 6,
      minY: 2.5,
      maxY: 9.5,
      minZ: 10,
      maxZ: 20,
    });
    this.setHint(null);
    this.setSelected(null);
    this.setMatch(0);
    this.setMoves(0);
  }

  private buildObjectPanel(controls: LevelControls): void {
    this.objectBody.replaceChildren();
    this.depthSlider = null;
    this.flipSlider = null;
    this.rotSlider = null;

    if (!controls.rotate && !controls.depth && !controls.flip) {
      this.objectBody.append(
        h('div', {
          class: 'side-empty',
          text: '本关只需要移动物体：按住左键把它拖到影子与目标轮廓重合的位置。',
        }),
      );
      return;
    }

    // 数值读数
    this.readoutEls = {};
    const grid = h('div', { class: 'readout-grid' });
    const addReadout = (key: string, label: string) => {
      const v = h('span', { class: 'v', text: '—' });
      grid.append(h('span', { text: `${label}：` }), v);
      this.readoutEls[key] = v;
    };
    addReadout('rotZ', '旋转');
    if (controls.flip) addReadout('rotY', '翻转');
    if (controls.depth) addReadout('z', '深度');
    addReadout('xy', '位置');
    this.objectBody.append(grid);

    if (controls.rotate) {
      this.objectBody.append(
        h('h3', { text: '旋转（面内）' }),
        h('div', { class: 'rotate-group' }, [
          h('button', {
            class: 'btn btn-sm',
            text: `↺ ${ROTATE_STEP}°`,
            onclick: () => this.handlers.onRotate(-ROTATE_STEP),
          }),
          h('button', {
            class: 'btn btn-sm',
            text: `↻ ${ROTATE_STEP}°`,
            onclick: () => this.handlers.onRotate(ROTATE_STEP),
          }),
        ]),
      );
      this.rotSlider = sliderRow({
        label: '角度',
        min: -180,
        max: 180,
        step: 1,
        value: 0,
        format: (v) => `${v.toFixed(0)}°`,
        onInput: (v) => this.handlers.onRotateTo(v),
      });
      this.objectBody.append(h('div', { style: { marginTop: '10px' } }), this.rotSlider.row);
    }

    if (controls.flip) {
      this.flipSlider = sliderRow({
        label: '翻转',
        min: -60,
        max: 60,
        step: 1,
        value: 0,
        format: (v) => `${v.toFixed(0)}°`,
        onInput: (v) => this.handlers.onFlip(v),
      });
      this.objectBody.append(h('div', { style: { marginTop: '12px' } }), this.flipSlider.row);
    }

    if (controls.depth) {
      this.depthSlider = sliderRow({
        label: '深度',
        min: OBJECT_LIMITS.minZ,
        max: OBJECT_LIMITS.maxZ,
        step: 0.1,
        value: 4,
        format: (v) => v.toFixed(1),
        onInput: (v) => this.handlers.onDepth(v),
      });
      this.objectBody.append(h('div', { style: { marginTop: '12px' } }), this.depthSlider.row);
    }
  }

  private buildLightPanel(controls: LevelControls): void {
    this.lightBody.replaceChildren();
    this.lightSliders = {};
    this.lightPanel.classList.toggle('disabled', !controls.light);

    if (!controls.light) {
      this.lightBody.append(
        h('div', { class: 'side-empty', text: '本关光源固定，暂不开放调整。' }),
      );
      return;
    }

    const mk = (axis: 'x' | 'y' | 'z', label: string, min: number, max: number) => {
      const s = sliderRow({
        label,
        min,
        max,
        step: 0.1,
        value: axis === 'x' ? 0 : axis === 'y' ? 5.5 : 14,
        onInput: (v) => this.handlers.onLightAxis(axis, v),
      });
      this.lightSliders[axis] = s;
      this.lightBody.append(s.row);
    };

    mk('x', '水平', -6, 6);
    mk('y', '高度', 2.5, 9.5);
    if (controls.lightDistance) {
      mk('z', '距离', 10, 20);
    } else {
      this.lightBody.append(
        h('div', { class: 'tiny muted', style: { marginTop: '6px' } }, [
          '本关光源距离固定，可调整水平位置与高度。',
        ]),
      );
    }
  }

  // ───────────────────────── 状态更新 ─────────────────────────

  setSelected(def: ShadowObjectDefinition | null, t?: Transform3D): void {
    for (const chip of Array.from(this.chipsEl.children) as HTMLElement[]) {
      chip.setAttribute('aria-pressed', String(!!def && chip.dataset.id === def.id));
    }
    if (!def) {
      this.objectPanel.classList.add('disabled');
      return;
    }
    this.objectPanel.classList.remove('disabled');
    if (!t) return;

    if (this.readoutEls.rotZ) this.readoutEls.rotZ.textContent = `${t.rotationZ.toFixed(0)}°`;
    if (this.readoutEls.rotY) this.readoutEls.rotY.textContent = `${t.rotationY.toFixed(0)}°`;
    if (this.readoutEls.z) this.readoutEls.z.textContent = t.z.toFixed(1);
    if (this.readoutEls.xy) this.readoutEls.xy.textContent = `${t.x.toFixed(1)}, ${t.y.toFixed(1)}`;
    this.depthSlider?.set(t.z);
    this.flipSlider?.set(t.rotationY);
    this.rotSlider?.set(t.rotationZ);
  }

  /** 同步观看视角面板的滑杆读数 */
  setView(v: ViewState): void {
    this.viewPanel.setView(v);
  }

  setLight(light: LightState, limits: LightLimits): void {
    this.lightSliders.x?.set(light.x);
    this.lightSliders.y?.set(light.y);
    if (this.lightSliders.z) {
      const s = this.lightSliders.z;
      s.input.min = String(limits.minZ);
      s.input.max = String(limits.maxZ);
      s.set(Math.min(limits.maxZ, Math.max(limits.minZ, light.z)));
    }
  }

  setMatch(iou: number): void {
    const pct = Math.max(0, Math.min(1, iou));
    this.matchFill.style.width = `${pct * 100}%`;
    this.matchReadout.textContent = `${Math.round(pct * 100)}%`;
    if (this.level) {
      this.matchReadout.classList.toggle('is-hit', iou >= this.level.matchThreshold);
    }
  }

  setMoves(n: number): void {
    this.movesEl.textContent = `操作 ${n} 次`;
  }

  setCleared(cleared: boolean): void {
    this.nextBtn.disabled = !cleared;
  }

  /** 通关演出：金色光环与火星从舞台中心炸开（纯装饰，不影响判定） */
  playClearBurst(): void {
    const layer = this.modalHost.querySelector('.stage-burst-layer');
    if (!layer) return;
    layer.replaceChildren();
    this.modalHost.classList.add('is-cleared');
    for (let i = 0; i < 3; i++) {
      const ring = h('i', { class: 'burst-ring' });
      ring.style.setProperty('--ring-delay', `${i * 160}ms`);
      ring.style.setProperty('--ring-size', `${150 + i * 90}px`);
      layer.append(ring);
    }
    for (let i = 0; i < 26; i++) {
      const spark = h('i', { class: 'burst-spark' });
      spark.style.setProperty('--a', `${(360 / 26) * i + (i % 5) * 4}deg`);
      spark.style.setProperty('--d', `${90 + (i % 7) * 26}px`);
      spark.style.setProperty('--spark-delay', `${(i % 6) * 40}ms`);
      layer.append(spark);
    }
    window.setTimeout(() => {
      layer.replaceChildren();
      this.modalHost.classList.remove('is-cleared');
    }, 1900);
  }

  setHint(text: string | null): void {
    const box = this.hintBox;
    if (!text) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const body = box.querySelector('.side-hint');
    if (body) body.textContent = text;
  }

  /** 更新提示按钮的剩余次数（使用提示会计入评价，但不影响通关） */
  setHintRemaining(count: number): void {
    this.hintBtn.disabled = count <= 0;
    this.hintBtn.textContent = count > 0 ? `提示 (H) · 剩 ${count}` : '提示已用完';
  }

  setNextEnabled(v: boolean): void {
    this.nextBtn.disabled = !v;
  }
}
