import { SceneManager, type ViewPreset, type ViewState } from '../scene/SceneManager';
import { StudioScene } from '../scene/StudioScene';
import { SilhouetteRasterizer } from '../projection/SilhouetteRasterizer';
import { LevelManager } from '../gameplay/LevelManager';
import { LightController, type LightState } from '../gameplay/LightController';
import { InteractionController } from '../gameplay/InteractionController';
import { CompletionChecker, type Rank } from '../gameplay/CompletionChecker';
import { LabSession, LAB_CONTROLS } from '../gameplay/LabSession';
import { GameHUD } from '../ui/GameHUD';
import { LabHUD } from '../ui/LabHUD';
import { TitleScreen } from '../ui/TitleScreen';
import { LevelSelect } from '../ui/LevelSelect';
import { ModeSelect } from '../ui/ModeSelect';
import { ResultModal } from '../ui/ResultModal';
import { PausePanel } from '../ui/SettingsPanel';
import { GameState } from './GameState';
import { SoundKit } from './SoundKit';
import { WorkshopController } from '../workshop/WorkshopController';
import { PatternGallery } from '../ui/PatternGallery';
import { AboutPanel } from '../ui/AboutPanel';
import type { PatternKind } from '../patterns/types';
import { h } from '../ui/dom';
import { getLevelById, LEVELS, TOTAL_LEVELS } from '../data/levels';
import type {
  LevelDefinition,
  ShadowObjectDefinition,
  ShapeType,
  Transform3D,
} from '../gameplay/LevelData';

/**
 * 屏幕名称。
 *
 * 「花窗工坊」是主线（title 的一级入口），「影形解谜」与「自由实验室」
 * 收在二级入口页 modes 里，首页不再直接暴露它们。
 */
export type ScreenName = 'title' | 'modes' | 'levels' | 'game' | 'lab' | 'workshop';

/** 匹配度预览的节流间隔（ms） */
const PREVIEW_INTERVAL = 90;
/** 操作结束到"确认校验"的间隔（ms） */
const COMMIT_DEBOUNCE = 160;
/** 首次达标后进行第二次确认校验的间隔（ms） */
const CONFIRM_DELAY = 200;
/** 通关需要连续达标的校验次数：3 次意味着必须"稳住"匹配度，而不是擦过阈值 */
const REQUIRED_CONSECUTIVE_HITS = 3;

/**
 * 应用主控：串联场景、关卡、交互、判定与界面。
 * 自身不实现投影算法，也不直接拼装 DOM，只负责调度。
 */
export class GameApp {
  private root: HTMLElement;
  private state: GameState;
  private sound: SoundKit;

  private sceneManager: SceneManager;
  private studio: StudioScene;
  private rasterizer: SilhouetteRasterizer;
  private levelManager: LevelManager;
  private light: LightController;
  private interaction: InteractionController;
  private checker: CompletionChecker;

  private hud: GameHUD;
  private labHUD: LabHUD;
  private titleScreen: TitleScreen;
  private levelSelect: LevelSelect;
  private modeSelect: ModeSelect;

  private screen: ScreenName = 'title';
  private modal: HTMLElement | null = null;
  private currentLevel: LevelDefinition | null = null;

  private lab: LabSession;
  /** 花窗工坊（懒加载其三维舞台，首屏不付出这部分开销） */
  private workshop!: WorkshopController;
  /** 始终存在的弹窗层：任何界面都能弹出窗口，不受屏幕切换影响 */
  private modalLayer: HTMLElement;

  private cleared = false;
  private hintIndex = 0;
  private projDirty = false;
  private labDirty = false;
  private lastIou = 0;

  private previewTimer: number | null = null;
  private commitTimer: number | null = null;
  private confirmTimer: number | null = null;

  private keyHandler: (e: KeyboardEvent) => void;

  constructor(root: HTMLElement) {
    this.root = root;
    this.state = new GameState();
    this.sound = new SoundKit();
    this.sound.enabled = this.state.soundEnabled;

    // ---- 界面 ----
    const viewHandlers = {
      onViewChange: (part: Partial<ViewState>) => this.sceneManager.setView(part),
      onViewPreset: (name: ViewPreset) => this.sceneManager.setPreset(name),
      onViewReset: () => this.sceneManager.resetView(),
    };

    this.hud = new GameHUD({
      onBack: () => this.goLevels(),
      onPause: () => this.openPause(),
      onHint: () => this.showHint(),
      onReset: () => this.resetLevel(),
      onNext: () => this.nextLevel(),
      onSelectObject: (id) => this.selectObject(id),
      onRotate: (d) => this.rotateSelected(d),
      onRotateTo: (d) => this.interaction.setSelectedRotation(d),
      onFlip: (v) => this.flipSelected(v),
      onDepth: (v) => this.setDepth(v),
      onLightAxis: (axis, v) => this.setLightAxis(axis, v),
      ...viewHandlers,
    });

    this.labHUD = new LabHUD({
      onBack: () => this.leaveLab(),
      onAddShape: (shape) => this.addLabShape(shape),
      onSelectObject: (id) => this.selectObject(id),
      onRotate: (d) => this.rotateSelected(d),
      onRotateTo: (d) => this.interaction.setSelectedRotation(d),
      onFlip: (v) => this.flipSelected(v),
      onDepth: (v) => this.setDepth(v),
      onDeleteObject: () => this.deleteLabObject(),
      onResetScene: () => this.resetLabScene(),
      onLightAxis: (axis, v) => this.setLightAxis(axis, v),
      ...viewHandlers,
    });

    this.modalLayer = h('div', { class: 'modal-layer' });

    this.titleScreen = new TitleScreen(
      {
        onWorkshop: () => this.enterWorkshop(),
        // 「纹样图鉴」= 先看纹样档案，再从卡片里一键进入花窗工坊
        onGallery: () => this.openGallery(),
        // 二级入口：影形解谜 + 自由实验室
        onChallenge: () => this.showScreen('modes'),
        onAbout: () => this.openAbout(),
      },
      'v3.0.0',
    );

    this.levelSelect = new LevelSelect(this.state, {
      onPick: (id) => this.startLevel(id),
      onBack: () => this.showScreen('modes'),
      onLab: () => this.enterLab(),
    });

    this.modeSelect = new ModeSelect(this.state, {
      onLevels: () => this.goLevels(),
      onLab: () => this.enterLab(),
      onBack: () => this.showScreen('title'),
    });

    // ---- 三维场景 ----
    this.sceneManager = new SceneManager(this.hud.stageEl);
    this.studio = new StudioScene();
    this.sceneManager.scene.add(this.studio.root);
    this.sceneManager.onFrame((dt) => this.onFrame(dt));
    this.sceneManager.onViewChange((v) => {
      this.hud.setView(v);
      this.labHUD.setView(v);
    });

    // ---- 玩法 ----
    this.rasterizer = new SilhouetteRasterizer();
    this.levelManager = new LevelManager(this.rasterizer);
    this.lab = new LabSession();
    this.light = new LightController((s) => this.applyLight(s));
    this.checker = new CompletionChecker(REQUIRED_CONSECUTIVE_HITS);
    this.interaction = new InteractionController(
      this.studio,
      this.sceneManager,
      LEVELS[0].controls,
      {
        onSelect: (id) => this.onSelect(id),
        onChange: (id, t) => this.onObjectChange(id, t),
        onCommit: () => this.scheduleCommit(),
      },
    );

    // 左键的归属由"该处是否有可交互物体"决定：
    // 命中物体 → 拖动物体；落在空白 → 环绕视角。
    this.sceneManager.setPickTest((x, y) =>
      this.screen === 'workshop'
        ? this.workshop?.hitTest(x, y) === true
        : this.interaction?.hitTestAt(x, y) === true,
    );

    this.keyHandler = (e: KeyboardEvent) => this.onKeyDown(e);
    window.addEventListener('keydown', this.keyHandler);

    // ---- 花窗工坊（与关卡共用同一个场景与渲染器，不新建第二个 WebGL 上下文）----
    this.workshop = new WorkshopController({
      sceneManager: this.sceneManager,
      studio: this.studio,
      light: this.light,
      rasterizer: this.rasterizer,
      onRequestBack: () => this.showScreen('title'),
      openModal: (el) => this.openModal(el),
      closeModal: () => this.closeModal(),
    });

    this.showScreen('title');
    this.sceneManager.start();

    this.installDebugHook();
  }

  /**
   * 暴露一个只读 + 测试用的调试钩子，便于自动化测试与现场排查。
   * 它不会改变任何判定逻辑：solve() 只是把物体的变换写到目标参数上，
   * 之后的通关仍然要经过正常的投影计算与 IoU 校验。
   *
   * **只在开发 / 测试构建中挂载**（import.meta.env.DEV）。
   * 生产构建里 window.__lightShadow 不存在，快速通关入口不会泄露给玩家。
   */
  private installDebugHook(): void {
    if (!import.meta.env.DEV) return;
    const api = {
      version: '3.0.0',
      getState: () => ({
        screen: this.screen,
        levelId: this.currentLevel?.id ?? null,
        cleared: this.cleared,
        moves: this.levelManager.moves,
        hintsUsed: this.levelManager.hintsUsed,
        light: this.light.get(),
        objects: this.currentLevel
          ? this.currentLevel.objects.map((o) => ({
              id: o.id,
              name: o.name,
              transform: this.levelManager.transforms.get(o.id) ?? null,
            }))
          : [],
        lastIou: this.lastIou,
        unlocked: this.state.unlocked,
        labObjects: this.lab.count,
        matchThreshold: this.currentLevel?.matchThreshold ?? null,
        requiredHits: REQUIRED_CONSECUTIVE_HITS,
        totalLevels: TOTAL_LEVELS,
      }),
      /** 测试用：读取当前观看视角 */
      getView: () => this.sceneManager.getView(),
      /** 测试用：设置观看视角（走与 UI 完全相同的夹紧逻辑） */
      setView: (part: Partial<ViewState>) => {
        this.sceneManager.setView(part);
        return this.sceneManager.getView();
      },
      /** 测试用：把全部物体与光源设置为关卡的目标参数 */
      solve: () => {
        if (!this.currentLevel) return false;
        for (const obj of this.currentLevel.objects) {
          this.levelManager.setTransform(obj.id, { ...obj.target });
          this.studio.updateTransform(obj.id, obj.target);
        }
        this.light.setObjectDepthLimit(this.levelManager.maxObjectZ());
        this.light.set({ ...this.currentLevel.light.target });
        this.markDirty();
        this.scheduleCommit(true);
        return true;
      },
      /** 测试用：当前应当优先挑战的关卡（按解锁与通关进度推算） */
      firstUncleared: () => this.firstUnclearedLevel(),
      /** 测试用：直接进入指定关卡 */
      goToLevel: (id: number) => {
        this.startLevel(id);
        return true;
      },
      /** 测试用：进入自由实验室 */
      goToLab: () => {
        this.enterLab();
        return true;
      },
      /** 测试用：进入二级入口页「光影挑战」 */
      goToModes: () => {
        this.showScreen('modes');
        return true;
      },
      /** 测试用：回到标题页 */
      goToTitle: () => {
        this.showScreen('title');
        return true;
      },
      /** 测试用：在自由实验室添加一个形状 */
      addLabShape: (shape: ShapeType) => {
        this.addLabShape(shape);
        return this.lab.count;
      },
      /**
       * 测试用：把实验室里的物体全部叠到同一处，制造大面积影子重叠。
       * 用于验证"重叠区域颜色均匀、无叠加接缝"。
       */
      overlapProbe: () => {
        const objs = this.lab.objects;
        const base = this.lab.transforms.get(objs[0]?.id ?? '');
        if (!base) return 0;
        objs.forEach((o) => {
          const t = this.lab.transforms.get(o.id);
          if (!t) return;
          const next = { ...t, x: base.x, y: base.y, z: base.z };
          this.lab.transforms.set(o.id, next);
          this.studio.updateTransform(o.id, next);
        });
        this.labDirty = true;
        return objs.length;
      },
      /** 测试用：读取自由实验室的物体与光源状态 */
      getLabState: () => ({
        count: this.lab.count,
        ids: this.lab.objects.map((o) => o.id),
        objects: this.lab.objects.map((o) => ({
          id: o.id,
          name: o.name,
          transform: this.lab.transforms.get(o.id) ?? null,
        })),
        selected: this.lab.selectedId,
        light: this.light.get(),
      }),
      /** 测试用：返回某物体在屏幕上的像素坐标（关卡与实验室通用） */
      screenPos: (id: string) => {
        const t =
          this.screen === 'lab'
            ? this.lab.transforms.get(id)
            : this.levelManager.transforms.get(id);
        if (!t) return null;
        return this.sceneManager.worldToScreen({ x: t.x, y: t.y, z: t.z });
      },
      /** 测试用：墙面上的当前影子图元数量 */
      wallShadowCount: () => this.studio.projection.shadowMeshCount(),
      /**
       * 测试用：返回"影子与目标轮廓重合处"在屏幕上的像素坐标。
       * 取目标多边形顶点的重心（退回质心），用于精确采样该区域的像素颜色，
       * 判断影子是否盖住了示例描边。
       */
      overlapScreenPos: () => {
        const polys = this.levelManager.targetPolygons;
        if (!polys.length || !polys[0].length) return null;
        const pts = polys[0];
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        return this.sceneManager.worldToScreen({ x: cx, y: cy, z: 0 });
      },
      /** 测试用：墙面图层顺序，用于断言影子画在示例图形之上 */
      layerOrder: () => this.studio.projection.layerOrder(),
      /** 测试用：返回某个物体目标位置对应的屏幕像素坐标 */
      targetScreenPos: (id: string) => {
        const obj = this.currentLevel?.objects.find((o) => o.id === id);
        if (!obj) return null;
        return this.sceneManager.worldToScreen({
          x: obj.target.x,
          y: obj.target.y,
          z: obj.target.z,
        });
      },
      /** 测试用：某屏幕点是否落在可交互物体上（等价于左键的归属判断） */
      hitTest: (x: number, y: number) => this.interaction.hitTestAt(x, y),
      // ── 花窗工坊（仅在开发/测试构建中可用）──
      workshop: {
        /** 进入花窗工坊 */
        open: () => {
          this.enterWorkshop();
          return true;
        },
        /** 工坊状态快照 */
        state: () => this.workshop.debugState(),
        /** 切换模板 */
        pickPattern: (id: string) => {
          this.workshop.debugPickPattern(id as PatternKind);
          return true;
        },
        /** 修改模板参数 */
        setParams: (patch: Record<string, unknown>) => {
          this.workshop.debugSetParams(patch as never);
          return true;
        },
        /** 设置窗格深度 */
        setDepth: (z: number) => {
          this.workshop.debugSetDepth(z);
          return true;
        },
        /** 模拟一条自绘折线（窗格局部坐标） */
        drawPolyline: (pts: Array<{ x: number; y: number }>) =>
          this.workshop.debugDrawPolyline(pts),
        /**
         * 工坊自己的拾取判定（等价于左键落点归属：点在棂条上 ⇒ 选中而非环绕）。
         * 注意与顶层 `hitTest` 的区别：顶层那个走的是关卡 / 实验室的交互控制器，
         * 在工坊里它是 disabled 的，恒返回 false。
         */
        hitTest: (x: number, y: number) => this.workshop.hitTest(x, y),
        /** 解析式重算的投影多边形（用于与渲染路径比对） */
        polygons: () => this.workshop.debugPolygons(),
        /** 走完整导出路径但不下载，返回 PNG 字节数 */
        exportPng: () => this.workshop.debugExport(),
        /** 渲染海报并返回 dataURL（用于校验导出内容） */
        poster: () => this.workshop.debugRenderPoster(),
        /** 保存作品并返回作品集 */
        save: (name?: string) => this.workshop.debugSave(name),
        /** 打开指定作品 */
        load: (id: string) => this.workshop.debugLoad(id),
        /** 点击工具条上的按钮（按文本匹配），用于验证界面按钮真的挂上了逻辑 */
        clickButton: (text: string) => {
          const btns = Array.from(document.querySelectorAll('.workshop-screen button'));
          const norm = (b: Element) => (b.textContent ?? '').replace(/\s+/g, ' ').trim();
          // 先精确匹配，再退回包含匹配：否则 "撤销" 会先命中工具条上排在更前面的 "撤销节点"。
          const hit = btns.find((b) => norm(b) === text) ?? btns.find((b) => norm(b).includes(text));
          if (!hit) return false;
          (hit as HTMLButtonElement).click();
          return true;
        },
      },
      /** 测试用：读取当前掩码与目标掩码的 IoU */
      score: () =>
        CompletionChecker.scoreOf(
          this.levelManager.currentMask(),
          this.levelManager.targetMask,
        ),
    };
    (window as unknown as { __lightShadow?: typeof api }).__lightShadow = api;
  }

  // ───────────────────────── 屏幕切换 ─────────────────────────

  private showScreen(name: ScreenName): void {
    this.screen = name;
    this.closeModal();
    // 离开工坊时收拾好舞台（移除窗格、光路线、清空墙面影子），避免污染其它界面
    if (name !== 'workshop') this.workshop?.leave();
    this.root.replaceChildren();
    this.root.append(this.modalLayer);
    // 弹窗层不在 .game-screen 内部，靠这个类决定用"夜色漆画"还是"纸面"样式
    this.modalLayer.classList.toggle('is-night', name === 'game' || name === 'lab');
    // 左键环绕只在真正可交互的玩法界面开放
    this.sceneManager.setLeftOrbitEnabled(name === 'game' || name === 'lab' || name === 'workshop');
    // 游戏 / 实验室是暖调夜色工坊（漆墙 + 鎏金）；花窗工坊仍是亮色纸面工作室
    this.sceneManager.setBackdrop(name === 'workshop' ? '#f6efe3' : '#0b0806');
    if (name === 'title') {
      this.interaction.setEnabled(false);
      this.root.append(this.titleScreen.root);
      this.sceneManager.stop();
    } else if (name === 'modes') {
      this.interaction.setEnabled(false);
      this.modeSelect.refresh();
      this.root.append(this.modeSelect.root);
      this.sceneManager.stop();
    } else if (name === 'levels') {
      this.interaction.setEnabled(false);
      this.levelSelect.refresh();
      this.root.append(this.levelSelect.root);
      this.sceneManager.stop();
    } else if (name === 'workshop') {
      this.interaction.setEnabled(false);
      this.root.append(this.workshop.hud.root);
      this.workshop.hud.setView(this.sceneManager.getView());
      this.sceneManager.mount(this.workshop.hud.stageEl);
      this.sceneManager.start();
      this.sceneManager.resize();
    } else if (name === 'lab') {
      this.root.append(this.labHUD.root);
      this.labHUD.setView(this.sceneManager.getView());
      this.sceneManager.mount(this.labHUD.stageEl);
      this.sceneManager.start();
      this.sceneManager.resize();
    } else {
      this.root.append(this.hud.root);
      this.hud.setView(this.sceneManager.getView());
      this.sceneManager.mount(this.hud.stageEl);
      this.sceneManager.start();
      this.sceneManager.resize();
    }
  }

  private firstUnclearedLevel(): number {
    for (let i = 1; i <= TOTAL_LEVELS; i++) {
      if (!this.state.getRecord(i).cleared) return Math.min(i, this.state.unlocked);
    }
    return TOTAL_LEVELS;
  }

  private goLevels(): void {
    this.showScreen('levels');
  }

  // ───────────────────────── 花窗工坊 ─────────────────────────

  private enterWorkshop(): void {
    this.clearTimers();
    this.currentLevel = null;
    this.cleared = false;
    this.projDirty = false;
    this.labDirty = false;
    this.interaction.setEnabled(false);
    // 关卡/实验室的物体与目标轮廓不能留在工坊场景里
    this.studio.setObjects([], []);
    this.showScreen('workshop');
    this.workshop.enter();
    this.sound.click();
  }

  /** 模式 A：窗棂初识 / 纹样档案 */
  private openGallery(): void {
    const gallery = new PatternGallery({
      onPickPattern: (id: PatternKind) => {
        this.closeModal();
        this.enterWorkshop();
        this.workshop.onPickPattern(id);
      },
      onClose: () => this.closeModal(),
    });
    this.openModal(gallery.root);
  }

  /** 模式 E 的「资料」部分：项目说明与文化来源清单 */
  private openAbout(): void {
    const panel = new AboutPanel({
      onClose: () => this.closeModal(),
      onOpenLibrary: () => {
        this.closeModal();
        this.enterWorkshop();
        this.workshop.openLibrary();
      },
    });
    this.openModal(panel.root);
  }

  // ───────────────────────── 自由实验室 ─────────────────────────

  private enterLab(): void {
    this.clearTimers();
    this.currentLevel = null;
    this.cleared = false;
    this.projDirty = false;
    this.labDirty = false;

    this.showScreen('lab');

    this.studio.projection.setTarget([]);
    this.lab.reset();
    this.interaction.setControls(LAB_CONTROLS);
    this.light.setObjectDepthLimit(this.lab.maxObjectZ());
    this.light.set({ ...this.lab.light });
    this.labHUD.setLight(this.light.get(), this.light.limits());
    this.labHUD.setView(this.sceneManager.getView());
    this.rebuildLab();
    this.sound.click();
  }

  private leaveLab(): void {
    this.interaction.setEnabled(false);
    this.sceneManager.setLeftOrbitEnabled(false);
    // 实验室在二级入口里，返回就回到「光影挑战」而不是直接跳回首页
    this.showScreen('modes');
  }

  /** 重建自由实验室的三维物体与界面列表 */
  private rebuildLab(keepSelection?: string | null): void {
    const defs = this.lab.objects;
    this.studio.setObjects(
      defs,
      defs.map((o) => this.lab.transforms.get(o.id) ?? o.initial),
    );
    this.interaction.setControls(LAB_CONTROLS);
    this.interaction.syncTransforms(this.lab.transforms);
    this.labHUD.setObjects(defs);
    this.labHUD.setLight(this.light.get(), this.light.limits());

    const wanted = keepSelection !== undefined ? keepSelection : this.lab.selectedId;
    const id = wanted && defs.some((o) => o.id === wanted) ? wanted : defs[0]?.id ?? null;
    this.lab.selectedId = id;
    this.interaction.select(id);
    this.markLabDirty();
  }

  private addLabShape(shape: ShapeType): void {
    if (this.screen !== 'lab') return;
    const def = this.lab.add(shape);
    if (!def) {
      this.sound.hint();
      return;
    }
    this.light.setObjectDepthLimit(this.lab.maxObjectZ());
    this.rebuildLab(def.id);
    this.sound.click();
  }

  private deleteLabObject(): void {
    if (this.screen !== 'lab') return;
    const id = this.lab.selectedId;
    if (!id) return;
    this.lab.remove(id);
    this.light.setObjectDepthLimit(this.lab.maxObjectZ());
    this.rebuildLab();
    this.sound.click();
  }

  private resetLabScene(): void {
    if (this.screen !== 'lab') return;
    this.lab.reset();
    this.light.setObjectDepthLimit(this.lab.maxObjectZ());
    this.light.set({ ...this.lab.light });
    this.labHUD.setLight(this.light.get(), this.light.limits());
    this.rebuildLab();
    this.sound.click();
  }

  private markLabDirty(): void {
    this.labDirty = true;
  }

  // ───────────────────────── 关卡流程 ─────────────────────────

  private startLevel(id: number): void {
    const level = getLevelById(id);
    if (!level) return;
    this.currentLevel = level;
    this.cleared = false;
    this.hintIndex = 0;
    this.labDirty = false;
    this.checker.reset();
    this.clearTimers();

    this.levelManager.load(level);
    this.light.setObjectDepthLimit(this.levelManager.maxObjectZ());
    this.light.set(level.light.initial);
    this.studio.setObjects(
      level.objects,
      level.objects.map((o) => o.initial),
    );
    this.studio.projection.setTarget(this.levelManager.targetPolygons);
    this.interaction.setControls(level.controls);
    this.interaction.syncTransforms(this.levelManager.transforms);
    this.interaction.setEnabled(true);

    this.hud.setLevel(level);
    this.hud.setMoves(0);
    this.hud.setCleared(false);
    this.hud.setHintRemaining(level.hintSteps.length);

    this.showScreen('game');
    // 选中第一个物体，降低上手成本
    if (level.objects.length > 0) this.selectObject(level.objects[0].id);
    this.markDirty();
    this.refreshScore();
  }

  private resetLevel(): void {
    if (!this.currentLevel) return;
    const level = this.currentLevel;
    this.levelManager.reset();
    this.light.setObjectDepthLimit(this.levelManager.maxObjectZ());
    this.light.set(level.light.initial);
    this.interaction.syncTransforms(this.levelManager.transforms);
    for (const obj of level.objects) {
      const t = this.levelManager.transforms.get(obj.id);
      if (t) this.studio.updateTransform(obj.id, t);
    }
    this.cleared = false;
    this.checker.reset();
    this.clearTimers();
    this.hud.setMoves(0);
    this.hud.setCleared(false);
    this.hud.setMatch(0);
    this.markDirty();
    this.sound.click();
    this.refreshScore();
  }

  private nextLevel(): void {
    if (!this.currentLevel) return;
    const nextId = this.currentLevel.id + 1;
    if (nextId > TOTAL_LEVELS) {
      this.goLevels();
      return;
    }
    this.startLevel(nextId);
  }

  // ───────────────────────── 交互回调 ─────────────────────────

  private defOf(id: string): ShadowObjectDefinition | null {
    return this.currentLevel?.objects.find((o) => o.id === id) ?? null;
  }

  private selectObject(id: string): void {
    this.interaction.select(id);
  }

  private onSelect(id: string | null): void {
    if (this.screen === 'lab') {
      const def = id ? this.lab.defOf(id) : null;
      const t = id ? this.lab.transforms.get(id) : undefined;
      this.labHUD.setSelected(def, t);
      if (id) this.sound.click();
      return;
    }
    const def = id ? this.defOf(id) : null;
    const t = id ? this.levelManager.transforms.get(id) : undefined;
    this.hud.setSelected(def, t);
    if (id) this.sound.click();
  }

  private rotateSelected(delta: number): void {
    this.interaction.rotateSelected(delta);
    this.sound.rotate();
  }

  private flipSelected(deg: number): void {
    this.interaction.setSelectedFlip(deg);
  }

  private setDepth(z: number): void {
    this.interaction.setSelectedDepth(z);
  }

  private setLightAxis(axis: 'x' | 'y' | 'z', value: number): void {
    this.clearTimers();
    this.light.setAxis(axis, value);
    const limits = this.light.limits();
    if (this.screen === 'lab') this.labHUD.setLight(this.light.get(), limits);
    else this.hud.setLight(this.light.get(), limits);
  }

  private applyLight(s: LightState): void {
    if (this.screen === 'lab') {
      this.lab.light = { ...s };
      this.studio.setLightPosition(s);
      this.markLabDirty();
      return;
    }
    this.levelManager.setLight(s);
    this.studio.setLightPosition(s);
    this.markDirty();
    this.scheduleCommit();
  }

  private onObjectChange(id: string, t: Transform3D): void {
    if (this.screen === 'lab') {
      this.lab.setTransform(id, t);
      this.labHUD.setSelected(this.lab.defOf(id), t);
      this.markLabDirty();
      return;
    }
    this.levelManager.setTransform(id, t);
    this.hud.setSelected(this.defOf(id), t);
    this.markDirty();
  }

  // ───────────────────────── 渲染与匹配调度 ─────────────────────────

  private markDirty(): void {
    this.projDirty = true;
    if (this.previewTimer === null) {
      this.previewTimer = window.setTimeout(() => {
        this.previewTimer = null;
        this.updatePreviewScore();
      }, PREVIEW_INTERVAL);
    }
  }

  /** 只刷新匹配度显示，不计入操作次数，也不触发通关判定 */
  private refreshScore(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.updatePreviewScore();
  }

  private updatePreviewScore(): void {
    if (!this.currentLevel) return;
    const iou = CompletionChecker.scoreOf(
      this.levelManager.currentMask(),
      this.levelManager.targetMask,
    );
    this.lastIou = iou;
    this.hud.setMatch(iou);
  }

  private scheduleCommit(immediate = false): void {
    if (this.commitTimer !== null) window.clearTimeout(this.commitTimer);
    if (immediate) {
      this.runCommit();
      return;
    }
    this.commitTimer = window.setTimeout(() => {
      this.commitTimer = null;
      this.runCommit();
    }, COMMIT_DEBOUNCE);
  }

  private runCommit(): void {
    if (!this.currentLevel || this.cleared) return;
    const level = this.currentLevel;
    this.levelManager.countMove();
    this.hud.setMoves(this.levelManager.moves);

    const current = this.levelManager.currentMask();
    const result = this.checker.evaluate(
      current,
      this.levelManager.targetMask,
      level.matchThreshold,
      level.excellentThreshold,
      level.masterThreshold,
      this.levelManager.moves,
      this.levelManager.hintsUsed,
      level.recommendedMoves,
    );
    this.lastIou = result.iou;
    this.hud.setMatch(result.iou);

    if (result.cleared) {
      this.onCleared(result.iou, result.rank);
      return;
    }
    // 首次达标不立即结算：稍后再做一次确认校验，避免拖动擦过阈值就弹窗
    if (result.iou >= level.matchThreshold) {
      if (this.confirmTimer !== null) window.clearTimeout(this.confirmTimer);
      this.confirmTimer = window.setTimeout(() => {
        this.confirmTimer = null;
        this.scheduleCommit(true);
      }, CONFIRM_DELAY);
    }
  }

  private onCleared(iou: number, rank: Rank): void {
    if (!this.currentLevel || rank === 'none') return;
    this.cleared = true;
    this.clearTimers();
    this.interaction.setEnabled(false);
    this.studio.projection.flash();
    this.hud.playClearBurst();
    this.sound.success();

    const level = this.currentLevel;
    const newRecord = this.state.recordClear(
      level.id,
      iou,
      rank,
      this.levelManager.moves,
      this.levelManager.hintsUsed,
    );
    this.hud.setCleared(true);
    this.hud.setNextEnabled(level.id < TOTAL_LEVELS);

    const modal = new ResultModal(
      {
        levelId: level.id,
        levelTitle: level.title,
        iou,
        rank,
        moves: this.levelManager.moves,
        hintsUsed: this.levelManager.hintsUsed,
        isLast: level.id >= TOTAL_LEVELS,
        newRecord,
      },
      {
        onNext: () => {
          this.closeModal();
          this.nextLevel();
        },
        onRetry: () => {
          this.closeModal();
          this.startLevel(level.id);
        },
        onBack: () => {
          this.closeModal();
          this.goLevels();
        },
      },
    );
    this.openModal(modal.root);
  }

  // ───────────────────────── 提示 ─────────────────────────

  private showHint(): void {
    if (!this.currentLevel) return;
    const level = this.currentLevel;
    if (this.hintIndex >= level.hintSteps.length) return;
    const text = level.hintSteps[this.hintIndex];
    this.hintIndex++;
    this.levelManager.hintsUsed++;
    this.hud.setHint(text);
    this.hud.setHintRemaining(level.hintSteps.length - this.hintIndex);
    this.sound.hint();
  }

  // ───────────────────────── 弹窗 ─────────────────────────

  private openModal(el: HTMLElement): void {
    this.closeModal();
    this.modal = el;
    this.modalLayer.append(el);
    if (this.screen === 'workshop') this.workshop.setInteractionEnabled(false);
    else this.interaction.setEnabled(false);
  }

  private closeModal(): void {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
    if (this.screen === 'workshop') {
      this.workshop?.setInteractionEnabled(true);
      this.workshop?.onModalClosed();
      return;
    }
    if ((this.screen === 'game' && !this.cleared) || this.screen === 'lab') {
      this.interaction.setEnabled(true);
    }
  }

  private openPause(): void {
    const panel = new PausePanel(
      {
        onResume: () => this.closeModal(),
        onRestart: () => {
          this.closeModal();
          this.startLevel(this.currentLevel?.id ?? 1);
        },
        onHome: () => {
          this.closeModal();
          this.showScreen('title');
        },
        onToggleSound: (v) => {
          this.state.soundEnabled = v;
          this.sound.enabled = v;
        },
        onResetProgress: () => {
          this.state.resetProgress();
          this.closeModal();
          this.showScreen('title');
        },
      },
      this.state.soundEnabled,
    );
    this.openModal(panel.root);
  }

  // ───────────────────────── 键盘 ─────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    if (this.screen === 'workshop') {
      if (e.key === 'Escape' && this.modal) this.closeModal();
      return;
    }
    if (this.screen === 'lab') {
      if (e.key === 'Escape') this.leaveLab();
      else if (e.key === 'r' || e.key === 'R') this.resetLabScene();
      return;
    }
    if (this.screen !== 'game') return;
    if (e.key === 'Escape') {
      if (this.modal) this.closeModal();
      else this.openPause();
      return;
    }
    if (this.modal) return;
    if (e.key === 'r' || e.key === 'R') {
      this.resetLevel();
    } else if (e.key === 'h' || e.key === 'H') {
      this.showHint();
    }
  }

  // ───────────────────────── 每帧 ─────────────────────────

  private onFrame(dt: number): void {
    if (this.screen === 'game' && this.projDirty) {
      this.studio.projection.setCurrent(this.levelManager.currentPolygons());
      this.projDirty = false;
    } else if (this.screen === 'lab' && this.labDirty) {
      this.studio.projection.setCurrent(this.lab.polygons());
      this.labDirty = false;
    } else if (this.screen === 'workshop') {
      this.workshop.onFrame();
    }
    this.studio.update(dt);
  }

  private clearTimers(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    if (this.commitTimer !== null) {
      window.clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    if (this.confirmTimer !== null) {
      window.clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
  }

  dispose(): void {
    this.clearTimers();
    window.removeEventListener('keydown', this.keyHandler);
    this.interaction.dispose();
    this.studio.dispose();
    this.sceneManager.dispose();
    this.rasterizer.dispose();
    this.sound.dispose();
  }
}
