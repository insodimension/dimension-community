// `bun run dev`: the design harness (./main.tsx) on its own port, the real kit
// resolved from source, the repo root readable so Traction's contributed faces
// load over the real presence bridge. A contributed face boots in a sandboxed
// frame that navigates to the engine's `/pack-shell` document; the harness
// answers that route with the engine's own response, so the frame is the real one.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { PACK_SHELL_PATH, packShellResponse } from "../../../../packages/engine/src/acp-ws/pack-shell";
import { PAGE_ALIASES } from "../vite.config";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));

function packShell(): Plugin {
	return {
		name: "general-agents-harness:pack-shell",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (req.url?.split("?")[0] !== PACK_SHELL_PATH) {
					next();
					return;
				}
				const answer = packShellResponse(req.method ?? "GET");
				res.statusCode = answer.status;
				answer.headers.forEach((value, key) => res.setHeader(key, value));
				void answer.arrayBuffer().then(body => res.end(Buffer.from(body)));
			});
		},
	};
}

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [packShell(), react(), tailwindcss()],
	resolve: { alias: PAGE_ALIASES, dedupe: ["react", "react-dom"] },
	server: { port: Number(process.env.GA_HARNESS_PORT ?? 5198), strictPort: true, fs: { allow: [repo] } },
});
