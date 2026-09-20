import { Grid } from 'antd';

// 与 antd 的断点一致（md = 768，lg = 992）。
// Grid.useBreakpoint 在订阅之前的首帧返回空对象：这一帧用 matchMedia 读一次当前值兜底，
// 否则桌面端会先按“手机”渲染一遍再切回来。之后的变化（缩放窗口、横竖屏切换）全部由 antd 的响应式观察器驱动。
const below = (px: number) => typeof window !== 'undefined' && Boolean(window.matchMedia) && !window.matchMedia(`(min-width: ${px}px)`).matches;

/** 手机竖屏 / 小屏：宽度 < 768px（antd 的 md 断点以下）。表格改卡片、表单纵排、工具栏堆叠等都以它为准。 */
export function useIsMobile(): boolean {
  const screens = Grid.useBreakpoint();
  return screens.md === undefined ? below(768) : !screens.md;
}

/** 侧边菜单收进抽屉：宽度 < 992px（手机 + 小平板）。≥ 992px 的桌面布局保持原样。 */
export function useNavCollapsed(): boolean {
  const screens = Grid.useBreakpoint();
  return screens.lg === undefined ? below(992) : !screens.lg;
}

/** Drawer 的宽度：手机上占满屏幕 */
export const drawerSize = (isMobile: boolean, desktop: number): number | string => (isMobile ? '100%' : desktop);
