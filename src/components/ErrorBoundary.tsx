import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  private isChunkError(): boolean {
    const err = this.state.error;
    if (!err) return false;
    const msg = err.message || '';
    return (
      err.name === 'ChunkLoadError' ||
      /Failed to fetch dynamically imported module/i.test(msg) ||
      /Importing a module script failed/i.test(msg) ||
      /Loading chunk [\w-]+ failed/i.test(msg) ||
      /error loading dynamically imported module/i.test(msg)
    );
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    const chunkError = this.isChunkError();
    const handleRetry = chunkError
      ? () => window.location.reload()
      : () => this.setState({ hasError: false, error: null });

    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 p-8 text-center">
        <AlertTriangle className="h-12 w-12 text-warning" />
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-muted-foreground max-w-md">
          {chunkError
            ? 'A new version of the app is available. Reload to continue.'
            : this.state.error?.message || 'An unexpected error occurred.'}
        </p>
        <button
          onClick={handleRetry}
          className="mt-2 px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {chunkError ? 'Reload' : 'Try again'}
        </button>
      </div>
    );
  }
}
