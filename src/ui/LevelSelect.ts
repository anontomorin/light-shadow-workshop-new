import { LEVELS, TOTAL_LEVELS } from '../data/levels';
import { h, RANK_LABEL, stars } from './dom';
import type { GameState } from '../app/GameState';
import type { LevelDefinition } from '../gameplay/LevelData';

/**
 * 关卡选择页：展示全部关卡卡片与解锁 / 通关状态。
 *
 * 关卡分两组呈现，让"题目取自经典花窗"这件事一眼可见：
 *   第一组 几何初阶（第 1–6 关）：从方块到城市天际线，认识投影的基本规律；
 *   第二组 花窗影谜（第 7–10 关）：题目是经典花窗的剪影，物体是棂条拼成的构件。
 */

export interface LevelSelectHandlers {
  onPick: (id: number) => void;
  onBack: () => void;
  onLab: () => void;
}

/** 分组边界：第 7 关起进入花窗题目 */
const LATTICE_FROM = 7;

export class LevelSelect {
  readonly root: HTMLElement;
  private state: GameState;
  private handlers: LevelSelectHandlers;

  constructor(state: GameState, handlers: LevelSelectHandlers) {
    this.state = state;
    this.handlers = handlers;

    const header = h('div', { class: 'screen-header' }, [
      h('div', {}, [
        h('h1', { text: '影形解谜' }),
        h('div', {
          class: 'sub',
          text: `共 ${TOTAL_LEVELS} 关：前 ${LATTICE_FROM - 1} 关由几何体入门，第 ${LATTICE_FROM} 关起题目取自经典花窗。通关后可以重玩争取更高评价。`,
        }),
      ]),
      h('div', { class: 'header-actions' }, [
        h('button', { class: 'btn btn-sm', text: '自由实验室', onclick: handlers.onLab }),
        h('button', { class: 'btn btn-sm', text: '返回光影挑战', onclick: handlers.onBack }),
      ]),
    ]);

    this.root = h('section', { class: 'screen level-screen' }, [
      h('div', { class: 'mode-decor' }),
      header,
      this.group('几何初阶 · 认识真实投影', LEVELS.filter((l) => l.id < LATTICE_FROM)),
      this.group('花窗影谜 · 题目取自经典花窗', LEVELS.filter((l) => l.id >= LATTICE_FROM)),
    ]);
    this.refresh();
  }

  private group(title: string, levels: LevelDefinition[]): HTMLElement {
    const grid = h('div', { class: 'level-grid' });
    grid.dataset.group = title;
    for (const level of levels) grid.append(this.card(level.id));
    return h('section', { class: 'level-group' }, [
      h('div', { class: 'level-group-title' }, [
        h('span', { class: 'level-group-rule' }),
        h('span', { text: title }),
      ]),
      grid,
    ]);
  }

  private card(id: number): HTMLElement {
    const level = LEVELS.find((l) => l.id === id);
    if (!level) return h('div');
    const unlocked = this.state.isUnlocked(level.id);
    const rec = this.state.getRecord(level.id);
    const isLattice = level.id >= LATTICE_FROM;
    const objectCount = level.objects.length;
    const partCount = level.objects.reduce((s, o) => s + (o.parts?.length ?? 1), 0);

    const foot = unlocked
      ? h('div', { class: 'lv-foot' }, [
          rec.cleared
            ? h('span', { class: 'badge badge-success', text: `最佳 ${RANK_LABEL[rec.bestRank]}` })
            : h('span', { class: 'badge', text: '未通关' }),
          stars(rec.bestRank),
        ])
      : h('div', { class: 'lv-foot' }, [h('span', { class: 'badge', text: '🔒 通关前一关解锁' })]);

    const card = h(
      'button',
      {
        class: `level-card${unlocked ? '' : ' locked'}${isLattice ? ' lattice' : ''}`,
        disabled: !unlocked,
        onclick: () => {
          if (unlocked) this.handlers.onPick(level.id);
        },
      },
      [
        h('div', { class: 'lv-no', text: `LEVEL ${String(level.id).padStart(2, '0')}` }),
        h('div', { class: 'lv-title', text: level.title }),
        h('div', { class: 'lv-desc', text: level.description }),
        h('div', { class: 'lv-meta tiny' }, [
          isLattice ? h('span', { class: 'lv-tag', text: '花窗题目' }) : h('span', { class: 'lv-tag ghost', text: '几何入门' }),
          h('span', { text: `${objectCount} 个物体 / ${partCount} 个构件零件` }),
        ]),
        foot,
      ],
    );
    // 入场错峰：花窗组从 0 重新计时，两排卡片各自成浪
    card.style.setProperty('--i', String(isLattice ? level.id - LATTICE_FROM : level.id - 1));
    return card;
  }

  /** 根据存档刷新卡片状态 */
  refresh(): void {
    const groups = Array.from(this.root.querySelectorAll('.level-grid')) as HTMLElement[];
    groups.forEach((grid) => grid.replaceChildren());
    const lists = [LEVELS.filter((l) => l.id < LATTICE_FROM), LEVELS.filter((l) => l.id >= LATTICE_FROM)];
    groups.forEach((grid, gi) => {
      for (const level of lists[gi] ?? []) grid.append(this.card(level.id));
    });
  }
}
