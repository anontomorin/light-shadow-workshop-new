import * as THREE from 'three';
import {
  WALL_HEIGHT,
  WALL_MAX_X,
  WALL_MAX_Y,
  WALL_MIN_X,
  WALL_MIN_Y,
  WALL_WIDTH,
  WALL_Z,
} from '../projection/Projector';
import { getObjectPartGeometries } from './GeometryFactory';
import { ProjectionRenderer } from './ProjectionRenderer';
import type { ShadowObjectDefinition, Transform3D } from '../gameplay/LevelData';

/**
 * 三维工作室场景：投影墙、地面、灯架、可操作几何体、光源可视化。
 * 只负责"呈现"，不含任何关卡与判定逻辑。
 */

const COLOR_WALL = '#fdf9f1';
const COLOR_FLOOR = '#3a2a1f';
const COLOR_FRAME_WOOD = '#2f2118';
const COLOR_GOLD = '#c9a227';
const COLOR_LAMP = '#fff2cf';

/** 画框宽度 / 厚度 */
const FRAME_W = 0.46;
const FRAME_D = 0.26;

/**
 * 一个可操作物体在场景中的呈现。
 *
 * 物体由"一组零件网格"构成（见 GeometryFactory 的零件模型）：
 *   凸形状 = 1 个网格；十字 = 3 个；五角星 = 6 个；圆环 = 18 个；
 *   花窗关卡的"外框""十字棂""菱花心"等构件则各自是一组棂条。
 * `group` 承担物体的世界变换（位置 / 姿态 / 选中脉动），零件网格只负责自身
 * 在物体局部坐标下的摆放（缩放 / 面内旋转 / 平移）。
 */
interface ObjectEntry {
  def: ShadowObjectDefinition;
  group: THREE.Group;
  meshes: THREE.Mesh[];
  outlines: THREE.LineSegments[];
  transform: Transform3D;
}

export class StudioScene {
  readonly root = new THREE.Group();
  readonly projection = new ProjectionRenderer();

  private objectGroup = new THREE.Group();
  private entries: ObjectEntry[] = [];
  private selectedId: string | null = null;

  private lampGroup = new THREE.Group();
  private lampStand: THREE.Mesh;
  private lampBulb: THREE.Mesh;
  private lampLight: THREE.PointLight;
  private lightPos = new THREE.Vector3(0, 5.5, 14);

  private disposables: Array<{ dispose(): void }> = [];
  private outlineMaterial: THREE.LineBasicMaterial;

  constructor() {
    this.root.add(this.objectGroup, this.projection.group, this.lampGroup);

    this.buildWall();
    this.buildFloor();
    this.buildLights();

    // 灯架
    const standGeo = new THREE.CylinderGeometry(0.07, 0.09, 1, 12);
    this.lampStand = new THREE.Mesh(
      standGeo,
      new THREE.MeshStandardMaterial({ color: '#6e5c46', roughness: 0.45, metalness: 0.55 }),
    );
    this.disposables.push(standGeo, this.lampStand.material as THREE.Material);

    const bulbGeo = new THREE.SphereGeometry(0.34, 20, 14);
    this.lampBulb = new THREE.Mesh(
      bulbGeo,
      new THREE.MeshBasicMaterial({ color: COLOR_LAMP }),
    );
    this.disposables.push(bulbGeo, this.lampBulb.material as THREE.Material);

    const shadeGeo = new THREE.ConeGeometry(0.62, 0.7, 20, 1, true);
    const shade = new THREE.Mesh(
      shadeGeo,
      new THREE.MeshStandardMaterial({
        color: '#d9b56e',
        roughness: 0.36,
        metalness: 0.45,
        side: THREE.DoubleSide,
      }),
    );
    shade.position.y = 0.42;
    this.disposables.push(shadeGeo, shade.material as THREE.Material);
    this.lampBulb.add(shade);

    this.lampLight = new THREE.PointLight('#fff0d0', 90, 60, 2);
    this.lampBulb.add(this.lampLight);

    this.lampGroup.add(this.lampStand, this.lampBulb);

    this.outlineMaterial = new THREE.LineBasicMaterial({
      color: '#e8cd86',
      transparent: true,
      opacity: 0.95,
    });
    this.disposables.push(this.outlineMaterial);
  }

  // ───────────────────────── 环境 ─────────────────────────

  private buildWall(): void {
    const wallGeo = new THREE.PlaneGeometry(WALL_WIDTH, WALL_HEIGHT);
    // 墙面是"投影幕布"：用不受光材质保证整面亮度绝对均匀，
    // 否则灯光造成的空间渐变会渗进影子颜色，出现肉眼可见的接缝色阶。
    const wallMat = new THREE.MeshBasicMaterial({ color: COLOR_WALL });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set((WALL_MIN_X + WALL_MAX_X) / 2, (WALL_MIN_Y + WALL_MAX_Y) / 2, WALL_Z);
    this.root.add(wall);
    this.disposables.push(wallGeo, wallMat);

    this.buildRoomBackdrop();

    // 深木画框：四条框料把明亮的墙面"装裱"起来
    const woodMat = new THREE.MeshStandardMaterial({
      color: COLOR_FRAME_WOOD,
      roughness: 0.62,
      metalness: 0.12,
    });
    this.disposables.push(woodMat);

    const bar = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      mat: THREE.Material,
    ) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      this.root.add(mesh);
      this.disposables.push(geo);
    };

    const frameZ = WALL_Z + FRAME_D / 2;
    // 上下两条横档
    bar(
      WALL_WIDTH + FRAME_W * 2,
      FRAME_W,
      FRAME_D,
      0,
      WALL_MAX_Y + FRAME_W / 2,
      frameZ,
      woodMat,
    );
    bar(
      WALL_WIDTH + FRAME_W * 2,
      FRAME_W,
      FRAME_D,
      0,
      WALL_MIN_Y - FRAME_W / 2,
      frameZ,
      woodMat,
    );
    // 左右两条立档
    bar(
      FRAME_W,
      WALL_HEIGHT,
      FRAME_D,
      WALL_MIN_X - FRAME_W / 2,
      5.5,
      frameZ,
      woodMat,
    );
    bar(
      FRAME_W,
      WALL_HEIGHT,
      FRAME_D,
      WALL_MAX_X + FRAME_W / 2,
      5.5,
      frameZ,
      woodMat,
    );

    // 鎏金内线
    const goldMat = new THREE.MeshStandardMaterial({
      color: COLOR_GOLD,
      roughness: 0.3,
      metalness: 0.85,
      emissive: new THREE.Color('#3a2a08'),
      emissiveIntensity: 0.5,
    });
    this.disposables.push(goldMat);
    const trimZ = WALL_Z + FRAME_D + 0.02;
    bar(WALL_WIDTH, 0.05, 0.02, 0, WALL_MAX_Y + 0.025, trimZ, goldMat);
    bar(WALL_WIDTH, 0.05, 0.02, 0, WALL_MIN_Y - 0.025, trimZ, goldMat);
    bar(0.05, WALL_HEIGHT, 0.02, WALL_MIN_X - 0.025, 5.5, trimZ, goldMat);
    bar(0.05, WALL_HEIGHT, 0.02, WALL_MAX_X + 0.025, 5.5, trimZ, goldMat);

    // 四角金饰
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const geo = new THREE.BoxGeometry(0.3, 0.3, 0.06);
        const orn = new THREE.Mesh(geo, goldMat);
        orn.position.set(
          sx * (WALL_MAX_X + FRAME_W / 2),
          sy < 0 ? WALL_MIN_Y - FRAME_W / 2 : WALL_MAX_Y + FRAME_W / 2,
          WALL_Z + FRAME_D + 0.05,
        );
        orn.rotation.z = Math.PI / 4;
        this.root.add(orn);
        this.disposables.push(geo);
      }
    }

    // 墙面刻度网格（浅色，帮助玩家判断位置）
    const gridPts: THREE.Vector3[] = [];
    for (let x = WALL_MIN_X + 3; x < WALL_MAX_X; x += 3) {
      gridPts.push(new THREE.Vector3(x, WALL_MIN_Y, WALL_Z + 0.005));
      gridPts.push(new THREE.Vector3(x, WALL_MAX_Y, WALL_Z + 0.005));
    }
    for (let y = WALL_MIN_Y + 2.5; y < WALL_MAX_Y; y += 2.5) {
      gridPts.push(new THREE.Vector3(WALL_MIN_X, y, WALL_Z + 0.005));
      gridPts.push(new THREE.Vector3(WALL_MAX_X, y, WALL_Z + 0.005));
    }
    const gridGeo = new THREE.BufferGeometry().setFromPoints(gridPts);
    const gridMat = new THREE.LineBasicMaterial({
      color: '#e4dac6',
      transparent: true,
      opacity: 0.6,
    });
    this.root.add(new THREE.LineSegments(gridGeo, gridMat));
    this.disposables.push(gridGeo, gridMat);
  }

  /**
   * 影壁（深漆背板）：把明亮的投影墙"嵌"进一面暗色漆墙里。
   *
   * 除了氛围，它还有一个工程作用：明亮的墙面与深色背景之间的锯齿过渡像素
   * 会污染墙面颜色采样；换成暖色暗漆背板后，过渡色始终是"暖"的（蓝通道低于红通道），
   * 与影子（#31455a，蓝通道高于红通道）在色相上彻底分开。
   */
  private buildRoomBackdrop(): void {
    const w = 64;
    const h = 30;
    const geo = new THREE.PlaneGeometry(w, h);
    // 顶亮底暗的微弱渐变，模拟高处油灯洒下来的余晖
    const top = new THREE.Color('#241a10');
    const bottom = new THREE.Color('#0a0705');
    const colors = new Float32Array([
      top.r, top.g, top.b,
      top.r, top.g, top.b,
      bottom.r, bottom.g, bottom.b,
      bottom.r, bottom.g, bottom.b,
    ]);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    const backdrop = new THREE.Mesh(geo, mat);
    backdrop.position.set(0, h / 2 - 2, WALL_Z - 0.55);
    this.root.add(backdrop);
    this.disposables.push(geo, mat);

    // 画框背后的鎏金余晖：只在墙面之外露出一圈暖光
    const haloSize = 64;
    const haloCanvas = document.createElement('canvas');
    haloCanvas.width = haloCanvas.height = haloSize;
    const ctx = haloCanvas.getContext('2d');
    if (ctx) {
      const g = ctx.createRadialGradient(32, 32, 8, 32, 32, 32);
      g.addColorStop(0, 'rgba(214, 176, 96, 0.30)');
      g.addColorStop(0.45, 'rgba(196, 152, 64, 0.10)');
      g.addColorStop(1, 'rgba(196, 152, 64, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, haloSize, haloSize);
    }
    const haloTex = new THREE.CanvasTexture(haloCanvas);
    haloTex.colorSpace = THREE.SRGBColorSpace;
    const haloGeo = new THREE.PlaneGeometry(34, 21);
    const haloMat = new THREE.MeshBasicMaterial({
      map: haloTex,
      transparent: true,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.position.set(0, 5.5, WALL_Z - 0.5);
    this.root.add(halo);
    this.disposables.push(haloTex, haloGeo, haloMat);
  }

  private buildFloor(): void {
    const floorGeo = new THREE.PlaneGeometry(46, 40);
    const floorMat = new THREE.MeshStandardMaterial({
      color: COLOR_FLOOR,
      roughness: 0.86,
      metalness: 0.04,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 10);
    this.root.add(floor);
    this.disposables.push(floorGeo, floorMat);

    // 地板拼缝：细木纹，让暗色地面不显得是一块空板
    const seamPts: THREE.Vector3[] = [];
    for (let x = -22; x <= 22; x += 2.3) {
      seamPts.push(new THREE.Vector3(x, 0.004, -9), new THREE.Vector3(x, 0.004, 29));
    }
    const seamGeo = new THREE.BufferGeometry().setFromPoints(seamPts);
    const seamMat = new THREE.LineBasicMaterial({
      color: '#1c140e',
      transparent: true,
      opacity: 0.75,
    });
    this.root.add(new THREE.LineSegments(seamGeo, seamMat));
    this.disposables.push(seamGeo, seamMat);
  }

  private buildLights(): void {
    // 墙面保持明亮（影子仍是画面主角），但环境光偏暖、补光偏冷，
    // 让几何体有"暖前冷后"的体积感。
    const ambient = new THREE.AmbientLight('#f6ede0', 0.6);
    const hemi = new THREE.HemisphereLight('#ffeed2', '#26343c', 0.6);
    const dir = new THREE.DirectionalLight('#ffe9c8', 0.8);
    dir.position.set(6, 16, 12);
    const fill = new THREE.DirectionalLight('#cfe6f0', 0.38);
    fill.position.set(-10, 6, 8);
    const rim = new THREE.DirectionalLight('#8fc3d4', 0.3);
    rim.position.set(-8, 7, -10);
    this.root.add(ambient, hemi, dir, fill, rim);
  }

  // ───────────────────────── 物体 ─────────────────────────

  /** 根据关卡定义重建全部可操作物体 */
  setObjects(defs: ShadowObjectDefinition[], transforms: Transform3D[]): void {
    this.clearObjects();
    defs.forEach((def, i) => {
      const objectScale = def.scale ?? 1;
      const material = new THREE.MeshStandardMaterial({
        color: def.color,
        roughness: 0.55,
        metalness: 0.05,
        emissive: new THREE.Color(def.color).multiplyScalar(0.06),
      });
      this.disposables.push(material);

      const group = new THREE.Group();
      group.userData.objectId = def.id;
      const meshes: THREE.Mesh[] = [];
      const outlines: THREE.LineSegments[] = [];

      for (const placement of getObjectPartGeometries(def)) {
        const mesh = new THREE.Mesh(placement.geometry, material);
        mesh.position.set(placement.dx, placement.dy, 0);
        mesh.rotation.z = THREE.MathUtils.degToRad(placement.rot);
        mesh.scale.set(
          objectScale * placement.sx,
          objectScale * placement.sy,
          objectScale,
        );
        mesh.userData.objectId = def.id;
        // 描边随零件自身缩放，稍微外扩一点避免与实体共面闪烁
        const outlineGeo = new THREE.EdgesGeometry(placement.geometry, 25);
        const outline = new THREE.LineSegments(outlineGeo, this.outlineMaterial);
        outline.visible = false;
        outline.scale.setScalar(1.06);
        mesh.add(outline);
        meshes.push(mesh);
        outlines.push(outline);
        group.add(mesh);
      }

      this.objectGroup.add(group);
      const entry: ObjectEntry = { def, group, meshes, outlines, transform: { ...transforms[i] } };
      this.entries.push(entry);
      this.applyTransform(entry);
    });
  }

  private clearObjects(): void {
    for (const e of this.entries) {
      this.objectGroup.remove(e.group);
      // 几何体由 GeometryFactory 缓存并共享，这里只回收描边几何体（材质是共享的）
      for (const outline of e.outlines) outline.geometry.dispose();
      e.group.clear();
    }
    this.entries = [];
    this.selectedId = null;
  }

  private applyTransform(entry: ObjectEntry): void {
    const t = entry.transform;
    entry.group.position.set(t.x, t.y, t.z);
    entry.group.rotation.set(
      THREE.MathUtils.degToRad(t.rotationX),
      THREE.MathUtils.degToRad(t.rotationY),
      THREE.MathUtils.degToRad(t.rotationZ),
    );
  }

  updateTransform(id: string, t: Transform3D): void {
    const entry = this.entries.find((e) => e.def.id === id);
    if (!entry) return;
    entry.transform = { ...t };
    this.applyTransform(entry);
  }

  getObjectIds(): string[] {
    return this.entries.map((e) => e.def.id);
  }

  getPickables(): THREE.Object3D[] {
    return this.entries.flatMap((e) => e.meshes);
  }

  getObjectName(id: string): string {
    return this.entries.find((e) => e.def.id === id)?.def.name ?? '';
  }

  /** 设置选中物体，显示描边 */
  setSelected(id: string | null): void {
    this.selectedId = id;
    for (const e of this.entries) {
      const on = e.def.id === id;
      for (const outline of e.outlines) outline.visible = on;
    }
  }

  getSelected(): string | null {
    return this.selectedId;
  }

  // ───────────────────────── 光源 ─────────────────────────

  setLightPosition(p: { x: number; y: number; z: number }): void {
    this.lightPos.set(p.x, p.y, p.z);
    this.lampBulb.position.set(p.x, p.y, p.z);
    const standHeight = Math.max(0.2, p.y - 0.5);
    this.lampStand.scale.y = standHeight;
    this.lampStand.position.set(p.x, standHeight / 2, p.z);
  }

  // ───────────────────────── 每帧更新 ─────────────────────────

  update(dt: number): void {
    this.projection.update(dt);
    const t = performance.now() * 0.001;

    // 选中物体轻微脉动缩放，提供"已选中"的视觉反馈
    for (const e of this.entries) {
      if (e.def.id === this.selectedId) {
        e.group.scale.setScalar(1 + Math.sin(performance.now() * 0.004) * 0.015);
      } else if (e.group.scale.x !== 1) {
        e.group.scale.setScalar(1);
      }
    }

    // 灯光轻微呼吸，营造"影棚"氛围
    this.lampLight.intensity = 88 + Math.sin(t * 1.2) * 6;

    // 选中描边呼吸
    if (this.selectedId) {
      this.outlineMaterial.opacity = 0.68 + (Math.sin(t * 3.2) * 0.5 + 0.5) * 0.29;
    } else if (this.outlineMaterial.opacity !== 0.95) {
      this.outlineMaterial.opacity = 0.95;
    }
  }

  dispose(): void {
    this.clearObjects();
    this.projection.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
