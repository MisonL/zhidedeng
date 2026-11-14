import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface State { error?: Error }

/**
 * 渲染异常的兜底。
 *
 * 之前任何一个页面组件在渲染时抛错（脏数据、未预期的形状），React 会把
 * 整棵树卸载，用户看到白屏且无从恢复。包住路由出口之后，崩溃只影响当前页，
 * 其余区域还能用，并给一条能操作的重试路径。
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 保留组件栈，方便从用户报错截图定位到具体组件。
    console.error('页面渲染出错', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="module" role="alert" style={{ margin: '2rem auto', maxWidth: 640, padding: '1.5rem' }}>
        <h2>这个页面出错了</h2>
        <p>页面渲染时遇到意外问题。可以刷新重试；如果反复出现，请把下面的信息反馈给我们。</p>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--surface-muted, #f5f5f5)', padding: '0.75rem', borderRadius: 8 }}>
          {this.state.error.message}
        </pre>
        <button type="button" onClick={() => { this.setState({ error: undefined }); window.location.reload(); }}>刷新页面</button>
      </div>
    );
  }
}
