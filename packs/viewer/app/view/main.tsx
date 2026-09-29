// The View's entry: the standard handshake through the kit's seat, then the viewer.
import { McpAppShell } from "@dimension/mcp-app-kit/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { actionFromResult } from "./result";
import { createViewerStore } from "./tabs";
import { ViewerApp } from "./viewer-app";
import "./app.css";

// Module scope, not component state: the tool result that MOUNTED this View lands
// before React's first effect, and a store owned by a component would drop it.
const store = createViewerStore();

function Root() {
	return (
		<McpAppShell appInfo={{ name: "viewer", version: "0.1.0" }} onToolResult={result => store.dispatch(actionFromResult(result))}>
			{app => <ViewerApp app={app} store={store} />}
		</McpAppShell>
	);
}

const container = document.getElementById("root");
if (!container) throw new Error("viewer view: missing #root");
createRoot(container).render(
	<StrictMode>
		<Root />
	</StrictMode>,
);
