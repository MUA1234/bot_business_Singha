"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { EmptyState } from "@/components/ui";

interface Props {
  windowId: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Per-window error boundary. A crash inside one window must never bring down the
 * whole workspace.
 */
export class WindowErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // In production this would be sent to a logging service.
    // eslint-disable-next-line no-console
    console.error("spatial window crashed", this.props.windowId, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <EmptyState
          title="This window could not be displayed"
          description={this.state.error.message || "An unexpected error occurred."}
          icon="alert-triangle"
        />
      );
    }
    return this.props.children;
  }
}
