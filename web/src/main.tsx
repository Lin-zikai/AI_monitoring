import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { StrictMode, useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth';
import './global.css';
import { useIsMobile } from './responsive';

dayjs.locale('zh-cn');

const BASE_TOKEN = { colorPrimary: '#2a78d6', borderRadius: 6 };

// 主输入方式是触摸的设备（含横屏手机、平板：宽度 ≥ 768px，走桌面布局）。设备属性不会中途变化，读一次即可
const TOUCH = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

/** 手机 / 触屏上把默认控件高度提到 40px（按钮、输入框、下拉框的触控目标），小号控件 32px；用鼠标的桌面端保持 antd 默认值 */
function Themed({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const theme = useMemo(() => (isMobile || TOUCH
    ? {
      token: { ...BASE_TOKEN, controlHeight: 40, controlHeightSM: 32 },
      // 日期面板的格子尺寸由 controlHeightSM 推出来，跟着变大后面板会比 360px 的屏幕还宽：窄屏上单独定回能放下的尺寸（7 × 40 + 边距 ≈ 316px）
      components: isMobile ? { DatePicker: { cellWidth: 40, cellHeight: 32, textHeight: 40 } } : undefined,
    }
    : { token: BASE_TOKEN }), [isMobile]);
  return <ConfigProvider locale={zhCN} theme={theme}>{children}</ConfigProvider>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Themed>
      <AntApp>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </AntApp>
    </Themed>
  </StrictMode>,
);
