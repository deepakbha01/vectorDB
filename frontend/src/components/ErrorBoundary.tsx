import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defense: if any page throws during render (the exact failure
 * mode a malformed API error response once caused - see extractErrorMessage
 * in api/client.ts), show a recoverable message instead of a blank page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, maxWidth: 560, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
          <h2>Something went wrong</h2>
          <p style={{ color: '#5a6472' }}>
            This page hit an unexpected error and couldn't render. Reloading usually fixes it; if it keeps happening,
            check the browser console for details.
          </p>
          <pre style={{ background: '#f5f6f8', padding: 12, borderRadius: 6, fontSize: 12, overflowX: 'auto' }}>
            {this.state.error.message}
          </pre>
          <button
            className="primary-btn"
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
