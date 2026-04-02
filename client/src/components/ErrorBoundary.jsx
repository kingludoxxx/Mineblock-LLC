import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] p-8 text-center">
          <div className="bg-red-950 border border-red-500/30 rounded-xl p-6 max-w-lg w-full">
            <h2 className="text-lg font-semibold text-red-200 mb-2">Something went wrong</h2>
            <p className="text-sm text-red-300/80 mb-4">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            {this.state.errorInfo?.componentStack && (
              <pre className="text-[11px] text-red-400/60 bg-black/30 rounded-lg p-3 overflow-auto max-h-48 text-left mb-4">
                {this.state.errorInfo.componentStack}
              </pre>
            )}
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
              className="px-4 py-2 text-sm font-medium bg-red-500/20 text-red-200 rounded-lg hover:bg-red-500/30 transition-colors cursor-pointer"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
