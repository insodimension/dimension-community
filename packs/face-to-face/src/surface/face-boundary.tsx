import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
	children: ReactNode;
	/** Rendered instead of the face when drawing it threw (no WebGL2, a lost context at creation). */
	fallback: (message: string) => ReactNode;
}

/** The renderer creates its GL context in an effect, so a machine without WebGL2 throws there: catch it and say so. */
export class FaceBoundary extends Component<Props, { message: string | null }> {
	override state = { message: null as string | null };

	static getDerivedStateFromError(error: unknown) {
		return { message: error instanceof Error ? error.message : String(error) };
	}

	override componentDidCatch(error: unknown, info: ErrorInfo) {
		console.warn("[face-to-face] the face could not be drawn", error, info.componentStack);
	}

	override render() {
		return this.state.message === null ? this.props.children : this.props.fallback(this.state.message);
	}
}
