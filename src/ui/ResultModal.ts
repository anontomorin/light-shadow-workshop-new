import { h, RANK_LABEL, stars } from './dom';
import type { Rank } from '../gameplay/CompletionChecker';

/** 通关结算弹窗 */

export interface ResultData {
  levelId: number;
  levelTitle: string;
  iou: number;
  rank: Rank;
  moves: number;
  hintsUsed: number;
  isLast: boolean;
  newRecord: boolean;
}

export interface ResultHandlers {
  onNext: () => void;
  onRetry: () => void;
  onBack: () => void;
}

const RANK_TIP: Record<Rank, string> = {
  none: '再试一次，让影子更贴近轮廓。',
  complete: '轮廓已经吻合，继续精修可以获得更高评价。',
  excellent: '影子几乎与目标重合，非常漂亮！',
  master: '零提示、操作精炼，这是大师级的光影作品。',
};

export class ResultModal {
  readonly root: HTMLElement;

  constructor(data: ResultData, handlers: ResultHandlers) {
    const stats = h('div', { class: 'result-stats' }, [
      h('div', { class: 'result-stat' }, [
        h('div', { class: 'k', text: '匹配度' }),
        h('div', { class: 'v', text: `${Math.round(data.iou * 100)}%` }),
      ]),
      h('div', { class: 'result-stat' }, [
        h('div', { class: 'k', text: '操作次数' }),
        h('div', { class: 'v', text: String(data.moves) }),
      ]),
      h('div', { class: 'result-stat' }, [
        h('div', { class: 'k', text: '提示使用' }),
        h('div', { class: 'v', text: String(data.hintsUsed) }),
      ]),
    ]);

    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
      h('div', { class: 'result-seal', text: '通关', 'aria-hidden': 'true' }),
      h('div', { class: 'badge badge-success', text: '通关' }),
      h('h2', { style: { marginTop: '10px' }, text: `第 ${data.levelId} 关 · ${data.levelTitle}` }),
      h('div', { class: 'modal-sub', text: RANK_TIP[data.rank] }),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        [
          h('span', { class: 'badge badge-accent', text: `评价：${RANK_LABEL[data.rank]}` }),
          stars(data.rank),
          data.newRecord ? h('span', { class: 'badge badge-primary', text: '刷新最佳' }) : null,
        ],
      ),
      stats,
      h('div', { class: 'modal-actions' }, [
        data.isLast
          ? null
          : h('button', {
              class: 'btn btn-primary',
              text: '下一关',
              onclick: handlers.onNext,
            }),
        h('button', { class: 'btn', text: '重玩本关', onclick: handlers.onRetry }),
        h('button', { class: 'btn btn-ghost', text: '返回关卡选择', onclick: handlers.onBack }),
      ]),
    ]);

    this.root = h('div', { class: 'modal-mask' }, [modal]);
  }
}
