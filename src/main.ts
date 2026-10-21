import './styles/fonts.css';
import './styles/global.css';
import './styles/screens.css';
import './styles/components.css';
import './styles/workshop.css';

import { GameApp } from './app/GameApp';
import { isWebGLAvailable } from './scene/SceneManager';

/** 显示可读的致命错误页，而不是空白屏幕 */
function showFatal(title: string, detail: string): void {
  const root = document.getElementById('app');
  if (!root) return;
  root.replaceChildren();
  const box = document.createElement('div');
  box.className = 'fatal-error';
  box.innerHTML = `<h1></h1><p></p>`;
  (box.querySelector('h1') as HTMLElement).textContent = title;
  (box.querySelector('p') as HTMLElement).textContent = detail;
  root.append(box);
}

function boot(): void {
  const root = document.getElementById('app');
  if (!root) {
    document.body.textContent = '页面容器缺失，无法启动。';
    return;
  }

  if (!isWebGLAvailable()) {
    showFatal(
      '无法启动三维场景',
      '《光影工坊：窗棂之间》需要 WebGL 支持。请使用较新版本的 Chrome、Edge、Firefox 或 Safari，并确认浏览器已启用硬件加速。',
    );
    return;
  }

  try {
    new GameApp(root);
  } catch (err) {
    console.error(err);
    showFatal(
      '启动失败',
      `游戏初始化时发生错误：${err instanceof Error ? err.message : String(err)}。刷新页面或重启浏览器后重试。`,
    );
  }
}

// 运行期未捕获错误：给出可理解的提示，避免白屏
window.addEventListener('error', (e) => {
  console.error('[光影工坊] 未捕获错误：', e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[光影工坊] 未处理的 Promise 拒绝：', e.reason);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
