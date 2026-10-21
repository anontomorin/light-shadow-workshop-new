import * as THREE from 'three';

/**
 * 负责 WebGL 渲染器、场景、相机与渲染循环。
 *
 * 相机在固定的观察中心周围做**受约束的环绕观察**：可以改变水平角、俯仰角与距离，
 * 也可以小幅平移中心。约束的目的不是限制玩家，而是避免把视角转到难以理解投影
 * 关系（甚至看不到影子）的位置：相机始终位于投影墙前方的正 Z 侧、地面之上。
 */

export const CAMERA_BASE_POSITION = new THREE.Vector3(15, 9, 17);
export const CAMERA_TARGET = new THREE.Vector3(0, 4.6, 0.5);

/** 视角状态：围绕 CAMERA_TARGET 的球坐标（角度制 / 世界单位） */
export interface ViewState {
  /** 水平角：0 表示正对投影墙，正值为向 +X 一侧绕行 */
  azimuth: number;
  /** 俯仰角：0 为与观察中心等高，90 为正上方俯视 */
  elevation: number;
  /** 相机到观察中心的距离 */
  distance: number;
}

export type ViewPreset = 'three-quarter' | 'front' | 'top' | 'left' | 'right';

const BASE_OFFSET = CAMERA_BASE_POSITION.clone().sub(CAMERA_TARGET);

/** 默认三分之四视角（由基准机位反算得到，保证与历史观感一致） */
export const BASE_VIEW: ViewState = {
  azimuth: THREE.MathUtils.radToDeg(Math.atan2(BASE_OFFSET.x, BASE_OFFSET.z)),
  elevation: THREE.MathUtils.radToDeg(Math.asin(BASE_OFFSET.y / BASE_OFFSET.length())),
  distance: BASE_OFFSET.length(),
};

/**
 * 环绕视角的合法范围。
 * 以 azimuth ∈ [-62°, 80°]、elevation ∈ [8°, 70°]、distance ∈ [13, 40] 计，
 * 相机 z 坐标恒为正（即使在最近的 13 单位与最偏的 80° 组合下仍有 2.7 > 0），
 * 因此玩家不会看到投影墙的背面。
 */
export const VIEW_LIMITS = {
  minAzimuth: -62,
  maxAzimuth: 80,
  minElevation: 8,
  maxElevation: 70,
  minDistance: 13,
  maxDistance: 40,
};

export const VIEW_PRESETS: Record<ViewPreset, { label: string; view: ViewState }> = {
  'three-quarter': { label: '三分之四', view: { ...BASE_VIEW } },
  front: { label: '正视', view: { azimuth: 0, elevation: 9, distance: BASE_VIEW.distance } },
  top: { label: '俯视', view: { azimuth: BASE_VIEW.azimuth, elevation: 62, distance: BASE_VIEW.distance } },
  left: { label: '左侧', view: { azimuth: -55, elevation: 14, distance: BASE_VIEW.distance } },
  right: { label: '右侧', view: { azimuth: 76, elevation: 14, distance: BASE_VIEW.distance } },
};

/** 观察中心的平移范围 */
const PAN_LIMIT = { x: 6, y: 3.5, z: 6 };

function safeClamp(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

export class SceneManager {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private container: HTMLElement;

  private view: ViewState = { ...BASE_VIEW };
  private pan = new THREE.Vector3();
  private viewListeners: Array<(v: ViewState) => void> = [];
  /** 由 GameApp 提供：判断某个屏幕点是否落在可交互物体上（决定左键是拖物体还是转视角） */
  private pickTest: ((clientX: number, clientY: number) => boolean) | null = null;
  /** 是否允许左键环绕（标题/选关等只读界面关闭，避免误转视角） */
  private leftOrbitEnabled = false;

  private onFrameCallbacks: Array<(dt: number) => void> = [];
  private running = false;
  private lastTime = 0;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private cleanupFns: Array<() => void> = [];

  constructor(container: HTMLElement) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#f5efe4');
    this.scene.fog = new THREE.Fog('#f5efe4', 40, 90);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.applyCameraTransform();

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      // 墙面影子靠模板缓冲合并重叠区域（否则半透明叠加会露出接缝）
      stencil: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('studio-canvas');

    this.resize();
    this.setupResize();
    this.setupViewControls();
  }

  /** 切换场景底色（游戏 / 实验室用深夜色，工坊保留亮色纸面） */
  setBackdrop(color: string): void {
    if (this.disposed) return;
    const c = new THREE.Color(color);
    this.scene.background = c;
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.copy(c);
  }

  // ───────────────────────── 相机与视角 ─────────────────────────

  private applyCameraTransform(): void {
    const e = THREE.MathUtils.degToRad(this.view.elevation);
    const a = THREE.MathUtils.degToRad(this.view.azimuth);
    const dir = new THREE.Vector3(
      Math.cos(e) * Math.sin(a),
      Math.sin(e),
      Math.cos(e) * Math.cos(a),
    );
    const target = CAMERA_TARGET.clone().add(this.pan);
    this.camera.position.copy(target).add(dir.multiplyScalar(this.view.distance));
    this.camera.lookAt(target);
    // 立即刷新世界矩阵，使 worldToScreen / 拾取在下一帧渲染前就已正确
    this.camera.updateMatrixWorld(true);
  }

  private clampView(v: ViewState): ViewState {
    return {
      azimuth: safeClamp(v.azimuth, VIEW_LIMITS.minAzimuth, VIEW_LIMITS.maxAzimuth, this.view.azimuth),
      elevation: safeClamp(
        v.elevation,
        VIEW_LIMITS.minElevation,
        VIEW_LIMITS.maxElevation,
        this.view.elevation,
      ),
      distance: safeClamp(v.distance, VIEW_LIMITS.minDistance, VIEW_LIMITS.maxDistance, this.view.distance),
    };
  }

  getView(): ViewState {
    return { ...this.view };
  }

  onViewChange(cb: (v: ViewState) => void): void {
    this.viewListeners.push(cb);
  }

  /**
   * 注册"命中测试"回调：给定屏幕坐标，返回该处是否是可交互物体。
   * 有了它，左键才能既拖动物体（点在物体上）又环绕视角（点在空白处）。
   */
  setPickTest(fn: ((clientX: number, clientY: number) => boolean) | null): void {
    this.pickTest = fn;
  }

  /** 开启/关闭左键环绕（在标题、选关等非交互界面关闭，防止误操作） */
  setLeftOrbitEnabled(v: boolean): void {
    this.leftOrbitEnabled = v;
  }

  /** 局部更新视角（未提供的字段保持不变），越界值会被夹紧 */
  setView(part: Partial<ViewState>): void {
    if (this.disposed) return;
    this.view = this.clampView({ ...this.view, ...part });
    this.applyCameraTransform();
    this.emitView();
  }

  /** 切换到预设视角（同时复位平移） */
  setPreset(name: ViewPreset): void {
    if (this.disposed) return;
    const preset = VIEW_PRESETS[name];
    if (!preset) return;
    this.pan.set(0, 0, 0);
    this.view = this.clampView({ ...preset.view });
    this.applyCameraTransform();
    this.emitView();
  }

  /** 复位到默认三分之四视角并清除平移 */
  resetView(): void {
    if (this.disposed) return;
    this.pan.set(0, 0, 0);
    this.view = { ...BASE_VIEW };
    this.applyCameraTransform();
    this.emitView();
  }

  private emitView(): void {
    const v = this.getView();
    for (const cb of this.viewListeners) cb(v);
  }

  private setupViewControls(): void {
    const el = this.renderer.domElement;
    let mode: 'orbit' | 'pan' | null = null;
    let lastX = 0;
    let lastY = 0;
    let pointerId = -1;

    // 拖动手感：细微抖动不算拖动，只有超过阈值才吸附为环绕
    const DRAG_THRESHOLD = 3;
    let pendingOrbit = false;
    let startX = 0;
    let startY = 0;

    // 右键用于环绕，需要屏蔽默认的上下文菜单
    const onContextMenu = (e: Event) => e.preventDefault();

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0) {
        // 左键：点在可交互物体上 → 交给物体交互；点在空白处 → 环绕视角
        if (!this.leftOrbitEnabled) return;
        if (this.pickTest && this.pickTest(e.clientX, e.clientY)) return;
        mode = e.ctrlKey || e.metaKey ? 'pan' : 'orbit';
        el.style.cursor = mode === 'pan' ? 'move' : 'grabbing';
      } else if (e.button === 2) {
        mode = e.shiftKey ? 'pan' : 'orbit';
      } else if (e.button === 1) {
        mode = 'pan';
      } else {
        return;
      }
      pointerId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      startX = e.clientX;
      startY = e.clientY;
      pendingOrbit = true;
      el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!mode || e.pointerId !== pointerId) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;

      // 拖动阈值：位移超过阈值后才开始真正转动，避免"想点击却轻微转了视角"
      if (pendingOrbit) {
        const moved = Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY);
        if (moved < DRAG_THRESHOLD) return;
        pendingOrbit = false;
      }

      lastX = e.clientX;
      lastY = e.clientY;
      if (mode === 'orbit') {
        // 俯仰方向：向下拖动 = 抬高相机（视角更俯视），与多数三维软件的手感一致
        this.setView({
          azimuth: this.view.azimuth - dx * 0.22,
          elevation: this.view.elevation + dy * 0.22,
        });
      } else {
        this.panBy(dx, dy);
      }
      e.preventDefault();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!mode) return;
      mode = null;
      pendingOrbit = false;
      el.style.cursor = '';
      el.releasePointerCapture?.(e.pointerId);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.06 : 1 / 1.06;
      this.setView({ distance: this.view.distance * factor });
    };

    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });

    this.cleanupFns.push(
      () => el.removeEventListener('contextmenu', onContextMenu),
      () => el.removeEventListener('pointerdown', onPointerDown),
      () => window.removeEventListener('pointermove', onPointerMove),
      () => window.removeEventListener('pointerup', onPointerUp),
      () => el.removeEventListener('wheel', onWheel),
    );
  }

  private panBy(dx: number, dy: number): void {
    const scale = this.view.distance * 0.0016;
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const forward = new THREE.Vector3();
    this.camera.matrixWorld.extractBasis(right, up, forward);
    this.pan.addScaledVector(right, -dx * scale);
    this.pan.addScaledVector(up, dy * scale);
    this.pan.x = safeClamp(this.pan.x, -PAN_LIMIT.x, PAN_LIMIT.x, 0);
    this.pan.y = safeClamp(this.pan.y, -PAN_LIMIT.y, PAN_LIMIT.y, 0);
    this.pan.z = safeClamp(this.pan.z, -PAN_LIMIT.z, PAN_LIMIT.z, 0);
    this.applyCameraTransform();
    this.emitView();
  }

  // ───────────────────────── 容器与尺寸 ─────────────────────────

  /** 把渲染画布挂到新的容器（关卡界面与自由实验室共用同一套渲染资源） */
  mount(container: HTMLElement): void {
    if (this.disposed) return;
    if (this.container !== container) {
      this.container = container;
      this.resizeObserver?.disconnect();
      container.appendChild(this.renderer.domElement);
      if (this.resizeObserver) this.resizeObserver.observe(container);
    }
    this.resize();
  }

  private setupResize(): void {
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    this.cleanupFns.push(() => window.removeEventListener('resize', onResize));

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
      this.cleanupFns.push(() => this.resizeObserver?.disconnect());
    }
  }

  resize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  // ───────────────────────── 渲染循环 ─────────────────────────

  onFrame(cb: (dt: number) => void): void {
    this.onFrameCallbacks.push(cb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = () => {
      if (!this.running) return;
      const now = performance.now();
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      for (const cb of this.onFrameCallbacks) cb(dt);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** 世界坐标 → 视口像素坐标（用于自动化测试与命中提示） */
  worldToScreen(v: THREE.Vector3Like): { x: number; y: number } {
    const p = new THREE.Vector3(v.x, v.y, v.z).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((p.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - p.y) / 2) * rect.height,
    };
  }

  /** 屏幕坐标 → 归一化设备坐标 */
  toNDC(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];
    this.onFrameCallbacks = [];
    this.viewListeners = [];
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}

/** 检测 WebGL 是否可用，用于友好降级 */
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl2') || canvas.getContext('webgl'))
    );
  } catch {
    return false;
  }
}
