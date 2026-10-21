import * as THREE from 'three';
import { WALL_Z, type Point2 } from '../projection/Projector';

/**
 * 把投影多边形渲染到投影墙上。
 *
 * 关键约束：当前影子与目标轮廓使用完全相同的墙面坐标映射，
 * 因此玩家在屏幕上看到的位置关系与 IoU 判定结果必然一致。
 *
 * 重叠处理（重要）：
 *   墙上每个多边形都是**半透明**的，如果逐个叠加，重叠处会因为 alpha 复合而
 *   明显变深，出现一圈"补丁"般的接缝。这里改成 **模板缓冲并集填充**：
 *   先把前景（当前影子 / 目标填充）的多边形只写模板缓冲、不写颜色不写深度，
 *   再把一个与墙面等大的矩形按模板测试铺上颜色。
 *   于是无论多少个多边形重叠，整块并集区域都只被填充**一次**，
 *   颜色完全均匀，看不出任何重叠痕迹。
 *
 * 层次顺序（由 renderOrder 钉死，见下方 ORDER_* 常量）：
 *   目标填充 → 目标描边 → 当前影子
 *
 * 影子刻意放在**最上层**：它代表玩家此刻的实际成果，压住示例图形后
 * 玩家看到的形状就是自己摆出来的结果。示例的淡填充与轮廓线都在影子之下，
 * 因此影子边缘与目标轮廓的重合程度才是判断"贴没贴合"的依据。
 *
 * 注意：**不要用 z 值或加入顺序来决定层序**。墙上这些 Mesh 都是透明材质、
 * 贴在同一个平面上，three 的透明通道按相机距离排序，距离并列时结果不稳定，
 * 层序会随机翻转。详见 ORDER_* 常量的注释。
 */

const Z_TARGET_FILL = WALL_Z + 0.01;
const Z_TARGET_STROKE = WALL_Z + 0.02;
const Z_SHADOW = WALL_Z + 0.04;

/**
 * 显式绘制顺序（renderOrder）。这是本文件**唯一**能可靠决定层序的机制。
 *
 * 为什么不能只靠 z / 加入顺序：
 *   three 会把 `transparent: true` 的对象放进**单独的透明通道**，按"离相机距离
 *   从远到近"排序后再画，这个排序**完全无视** z 值与组内加入顺序。
 *   而墙上的这些 Mesh 都是贴在同一个墙面上的薄片，z 只差 0.01~0.04，
 *   换算成相机距离差不到 0.03，几个对象常常算出**完全相同的 camDist**。
 *   距离并列时排序结果不稳定 → 谁最后画谁就压在上面 → 层序会随机翻转，
 *   表现为"影子有时候在示例上面、有时候在下面"。
 *
 * renderOrder 的优先级高于深度排序，所以用它把顺序钉死。
 * 数值必须与 z 的语义一致：小的先画（在下），大的后画（在上）。
 */
const ORDER_TARGET_FILL = 10;
const ORDER_TARGET_STROKE = 20;
const ORDER_SHADOW = 30;

/** 单次绘制需要 2 个模板位（0 基准一个、1 基准一个），用位掩码彼此隔离 */
const GROUP_TARGET_FILL = 1;
const GROUP_SHADOW = 2;

const COLOR_SHADOW = 0x31455a;
const COLOR_TARGET_FILL = 0x2f8fa8;
const COLOR_TARGET_STROKE = 0x1f7f96;

/**
 * 铺满整个墙面的矩形。它必须比墙面**略小**：
 * 矩形与墙面共面且同为 DoubleSide 时会互相闪烁，
 * 而任意方向略微内缩都不会影响观感（溢出部分本来就被裁掉了）。
 */
const FILL_INSET = 0.05;

function buildWallSizedPlane(z: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(
    WALL_SIZE.x - FILL_INSET * 2,
    WALL_SIZE.y - FILL_INSET * 2,
  );
  geo.translate(WALL_CENTER.x, WALL_CENTER.y, z);
  return geo;
}

const WALL_SIZE = { x: 18, y: 10 };
const WALL_CENTER = { x: 0, y: 5.5 };

export class ProjectionRenderer {
  readonly group = new THREE.Group();

  private shadowGroup = new THREE.Group();
  private targetFillGroup = new THREE.Group();
  private targetStrokeGroup = new THREE.Group();

  private shadowMaterial: THREE.MeshBasicMaterial;
  private targetFillMaterial: THREE.MeshBasicMaterial;
  private targetStrokeMaterial: THREE.LineBasicMaterial;

  /** 只写模板、不写颜色：把该组的形状"烙"进模板缓冲 */
  private shadowStampMaterial: THREE.MeshBasicMaterial;
  private targetFillStampMaterial: THREE.MeshBasicMaterial;

  /** 按模板测试把并集区域一次性铺色 */
  private shadowFill: THREE.Mesh;
  private targetFill: THREE.Mesh;

  private shadowFillGeometry: THREE.BufferGeometry;
  private targetFillGeometry: THREE.BufferGeometry;

  private highlight = 0;

  constructor() {
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(COLOR_SHADOW),
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      side: THREE.DoubleSide,
      // 只有模板缓冲被"烙"过的像素（即并集区域）才会被填充
      stencilWrite: true,
      stencilFunc: THREE.EqualStencilFunc,
      stencilRef: GROUP_SHADOW,
      stencilFuncMask: GROUP_SHADOW,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    });
    this.targetFillMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(COLOR_TARGET_FILL),
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilFunc: THREE.EqualStencilFunc,
      stencilRef: GROUP_TARGET_FILL,
      stencilFuncMask: GROUP_TARGET_FILL,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    });

    // 写模板但不写颜色，也不写深度 —— 纯"形状印章"
    const stampCommon = {
      colorWrite: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      // ReplaceStencilOp 在 stencilZPass 生效；同时覆盖 zFail 以防被深度判定拦下
      stencilZPass: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilFail: THREE.ReplaceStencilOp,
    } as const;
    this.shadowStampMaterial = new THREE.MeshBasicMaterial({
      ...stampCommon,
      stencilRef: GROUP_SHADOW,
    });
    this.targetFillStampMaterial = new THREE.MeshBasicMaterial({
      ...stampCommon,
      stencilRef: GROUP_TARGET_FILL,
    });

    this.targetStrokeMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(COLOR_TARGET_STROKE),
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });

    this.targetFillGeometry = buildWallSizedPlane(Z_TARGET_FILL);
    this.shadowFillGeometry = buildWallSizedPlane(Z_SHADOW);
    this.targetFill = new THREE.Mesh(this.targetFillGeometry, this.targetFillMaterial);
    this.shadowFill = new THREE.Mesh(this.shadowFillGeometry, this.shadowMaterial);

    // 层序由 renderOrder 钉死（见文件头 ORDER_* 常量说明）。
    // 加入顺序仅作可读性表达，不承担正确性。
    // 注意：印章（写模板）必须**先于**同组的铺色平面绘制，否则模板还没写好。
    this.targetFillGroup.renderOrder = ORDER_TARGET_FILL;
    this.shadowGroup.renderOrder = ORDER_SHADOW;
    this.targetStrokeGroup.renderOrder = ORDER_TARGET_STROKE;
    this.targetFill.renderOrder = ORDER_TARGET_FILL + 1;
    this.shadowFill.renderOrder = ORDER_SHADOW + 1;

    // 加入顺序 = 目标填充 → 目标描边 → 影子（可读性；真正的层序看 renderOrder）
    this.group.add(
      this.targetFillGroup,
      this.targetFill,
      this.targetStrokeGroup,
      this.shadowGroup,
      this.shadowFill,
    );
  }

  /**
   * 更新当前影子。
   * 多个物体的影子重叠时会被合并为一块均匀的实心区域（模板并集）。
   */
  setCurrent(polygons: Point2[][]): void {
    this.rebuildShapes(this.shadowGroup, polygons, Z_SHADOW, this.shadowStampMaterial, ORDER_SHADOW);
  }

  /** 更新目标轮廓（淡填充 + 描边，固定在墙上，不随玩家操作变化） */
  setTarget(polygons: Point2[][]): void {
    this.rebuildShapes(
      this.targetFillGroup,
      polygons,
      Z_TARGET_FILL,
      this.targetFillStampMaterial,
      ORDER_TARGET_FILL,
    );
    this.rebuildStroke(this.targetStrokeGroup, polygons, Z_TARGET_STROKE, ORDER_TARGET_STROKE);
  }

  /**
   * 用同一个材质重建一组多边形（材质由调用方提供，以便共用模板印章材质）。
   * `order` 显式写入每个 Mesh 的 renderOrder —— 子对象的 renderOrder 默认是 0，
   * 不会从父组继承，所以必须逐个设置，否则透明通道里又会被相机距离排序打乱。
   */
  private rebuildShapes(
    group: THREE.Group,
    polygons: Point2[][],
    z: number,
    material: THREE.Material,
    order: number,
  ): void {
    disposeChildren(group);
    for (const poly of polygons) {
      if (!poly || poly.length < 3) continue;
      const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, p.y)));
      const geo = new THREE.ShapeGeometry(shape);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.z = z;
      mesh.renderOrder = order;
      group.add(mesh);
    }
  }

  private rebuildStroke(group: THREE.Group, polygons: Point2[][], z: number, order: number): void {
    disposeChildren(group);
    for (const poly of polygons) {
      if (!poly || poly.length < 3) continue;
      const loop = poly.map((p) => new THREE.Vector3(p.x, p.y, z));
      loop.push(loop[0].clone());
      const geo = new THREE.BufferGeometry().setFromPoints(loop);
      const line = new THREE.Line(geo, this.targetStrokeMaterial);
      line.renderOrder = order;
      group.add(line);
    }
  }

  /** 通关演出：让目标轮廓短暂发亮 */
  flash(duration = 1.1): void {
    this.highlight = duration;
  }

  /** 当前影子在墙面上的图元数量（供自动化测试确认影子确实被绘制） */
  shadowMeshCount(): number {
    return this.shadowGroup.children.length;
  }


  /**
   * 图层层级快照（供自动化测试断言"影子画在示例图形之上"）。
   *
   * 断言的是 **renderOrder**，而不是组内下标或 z 值 —— 后两者都不是真正决定
   * 透明通道层序的机制（three 按相机距离排序，距离并列时结果不稳定）。
   * 只有 renderOrder 能稳定地决定谁后画、谁压在上面。
   *
   * 同时校验"印章先于铺色"：同组内印章的 renderOrder 必须小于铺色平面，
   * 否则模板还没写入就去铺色，影子/目标会整块消失。
   */
  layerOrder(): {
    targetFill: number;
    targetStroke: number;
    shadow: number;
    shadowIsTop: boolean;
    stampBeforeFill: boolean;
  } {
    const zOk = Z_SHADOW > Z_TARGET_STROKE && Z_TARGET_STROKE > Z_TARGET_FILL;
    const fillStamps = this.targetFillGroup.children;
    const shadowStamps = this.shadowGroup.children;
    // 印章对象（若存在）的 renderOrder 必须 < 对应铺色平面
    const stampOrderOk = (stamps: THREE.Object3D[], fill: THREE.Object3D) =>
      stamps.length === 0 || stamps.every((s) => s.renderOrder < fill.renderOrder);
    return {
      targetFill: this.targetFill.renderOrder,
      targetStroke: this.targetStrokeGroup.children[0]?.renderOrder ?? ORDER_TARGET_STROKE,
      shadow: this.shadowFill.renderOrder,
      shadowIsTop:
        this.shadowFill.renderOrder > (this.targetStrokeGroup.children[0]?.renderOrder ?? ORDER_TARGET_STROKE) &&
        this.shadowFill.renderOrder > this.targetFill.renderOrder &&
        zOk,
      stampBeforeFill:
        stampOrderOk(fillStamps, this.targetFill) && stampOrderOk(shadowStamps, this.shadowFill),
    };
  }

  update(dt: number): void {
    if (this.highlight > 0) {
      this.highlight = Math.max(0, this.highlight - dt);
      const k = Math.sin((this.highlight / 1.1) * Math.PI);
      this.targetStrokeMaterial.opacity = 0.7 + k * 0.3;
      this.targetFillMaterial.opacity = 0.16 + k * 0.3;
      this.shadowMaterial.color.setHex(k > 0.01 ? 0x3f6d84 : COLOR_SHADOW);
      return;
    }
    // 待贴合的目标轮廓缓慢呼吸，暗示"这里是可以对上的位置"
    const k = Math.sin(performance.now() * 0.00125) * 0.5 + 0.5;
    this.targetStrokeMaterial.opacity = 0.66 + k * 0.1;
    this.targetFillMaterial.opacity = 0.14 + k * 0.035;
    if (this.shadowMaterial.color.getHex() !== COLOR_SHADOW) {
      this.shadowMaterial.color.setHex(COLOR_SHADOW);
    }
  }

  dispose(): void {
    disposeChildren(this.shadowGroup);
    disposeChildren(this.targetFillGroup);
    disposeChildren(this.targetStrokeGroup);
    this.shadowFillGeometry.dispose();
    this.targetFillGeometry.dispose();
    this.shadowMaterial.dispose();
    this.targetFillMaterial.dispose();
    this.targetStrokeMaterial.dispose();
    this.shadowStampMaterial.dispose();
    this.targetFillStampMaterial.dispose();
  }
}

function disposeChildren(group: THREE.Group): void {
  for (const child of group.children.slice()) {
    group.remove(child);
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  }
}
