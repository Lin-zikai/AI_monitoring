import { Button, Result } from 'antd';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode; /** 变化时清除错误状态（例如路由路径），让用户点别的菜单就能离开出错的页面 */ resetKey?: string }
interface State { error: Error | null; resetKey?: string }

/** 渲染出错（或页面代码块加载失败，例如发布新版本后旧标签页）时给出可恢复的提示，而不是整页白屏。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('页面渲染出错', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Result
        status="error" title="页面出错了"
        subTitle={<>可能是平台刚刚更新，或遇到了意外的数据。刷新页面通常可以恢复；如果反复出现，请把下面的信息发给管理员。<div style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{this.state.error.message}</div></>}
        extra={<Button type="primary" onClick={() => location.reload()}>刷新页面</Button>}
      />
    );
  }
}
