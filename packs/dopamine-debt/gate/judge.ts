import { existsSync } from "node:fs";
import * as path from "node:path";
import { type AssistantMessage, completeSimple, type JudgmentState, type Question, type Tool } from "@oh-my-pi/pi-ai";
import { discoverAuthStorage, loadCliExtensionProviders } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	expandRoleAlias,
	getModelMatchPreferences,
	resolveModelFromString,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveJudge, sharedJudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

const JUDGE_CONCURRENCY = 16;
const RESPOND_TOOL = "respond";

export interface JudgeAnswer {
	answers?: Record<string, unknown>;
	model?: string;
	error?: string;
}

export interface Completion {
	data?: unknown;
	text?: string;
	model: string;
}

export interface HostJudge {
	readonly agentDir: string;
	readonly ownHome: boolean;
	readonly primary: string | undefined;
	readonly answered: Map<string, number>;
	readonly jurors: Map<string, number>;
	judgeItems(items: Record<string, JudgmentState>, questions: Record<string, CellQuestion>): Promise<Record<string, JudgeAnswer>>;
	complete(prompt: string, role: string, schema: Record<string, unknown> | undefined): Promise<Completion>;
	close(): void;
}

export interface CellQuestion {
	type: "bool" | "choice" | "score";
	instructions: string;
	criteria?: unknown;
}

function toQuestion(q: CellQuestion): Question {
	if (q.type === "bool") return { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) } as Question;
	return { type: q.type, instructions: q.instructions, criteria: q.criteria } as Question;
}

function count(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function replyText(reply: AssistantMessage): string {
	return reply.content
		.map(part => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

function structured(reply: AssistantMessage): unknown {
	for (const part of reply.content) if (part.type === "toolCall" && part.name === RESPOND_TOOL) return part.arguments;
	const text = replyText(reply);
	const json = text.match(/\{[\s\S]*\}/);
	if (!json) throw new Error("the juror returned no structured answer");
	return JSON.parse(json[0]);
}

export async function openHostJudge(engineHome: string, cwd: string): Promise<HostJudge> {
	const agentDir = path.join(engineHome, "agent");
	const ownHome = existsSync(agentDir);
	if (ownHome && path.resolve(getAgentDir()) !== path.resolve(agentDir)) setAgentDir(agentDir);
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage(undefined, { settings });
	try {
		const registry = new ModelRegistry(authStorage);
		await registry.refresh();
		await loadCliExtensionProviders(registry, settings, cwd);
		const sessionId = Bun.randomUUIDv7();
		const judge = resolveJudge({ settings, registry, sessionId, purpose: "dopamine_debt_gate", cache: sharedJudgmentCache() });
		const primaryModel = judge.primaryModel();
		const answered = new Map<string, number>();
		const jurors = new Map<string, number>();
		return {
			agentDir: getAgentDir(),
			ownHome,
			primary: primaryModel ? `${primaryModel.provider}/${primaryModel.id}` : undefined,
			answered,
			jurors,
			async judgeItems(items, cellQuestions) {
				const questions: Record<string, Question> = {};
				for (const [id, q] of Object.entries(cellQuestions)) questions[id] = toQuestion(q);
				const keys = Object.keys(items);
				const out: Record<string, JudgeAnswer> = {};
				let next = 0;
				const worker = async (): Promise<void> => {
					while (next < keys.length) {
						const key = keys[next++];
						try {
							const result = await judge.judge({ state: items[key], questions });
							const model = `${result.provider}/${result.model}`;
							const answers: Record<string, unknown> = {};
							for (const [id, answer] of Object.entries(result.answers)) {
								answers[id] = answer.type === "noul" ? { type: "bool", bool: answer.noul } : answer;
							}
							count(answered, model);
							out[key] = { answers, model };
						} catch (error) {
							out[key] = { error: error instanceof Error ? error.message : String(error) };
						}
					}
				};
				await Promise.all(Array.from({ length: Math.min(JUDGE_CONCURRENCY, keys.length) }, worker));
				return out;
			},
			async complete(prompt, role, schema) {
				const selector = expandRoleAlias(`@${role}`, settings);
				const model = resolveModelFromString(selector, registry.getAvailable(), getModelMatchPreferences(settings));
				if (!model) throw new Error(`the "${role}" model role resolves to no available model`);
				if (!(await registry.getApiKey(model, sessionId))) throw new Error(`no API key for ${model.provider}/${model.id}`);
				const tools: Tool[] | undefined = schema
					? [{ name: RESPOND_TOOL, description: "Return your answer by calling this tool.", parameters: schema, strict: false }]
					: undefined;
				const reply = await completeSimple(
					model,
					{
						systemPrompt: ["You are a helpful assistant."],
						messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
						tools,
					},
					{
						apiKey: registry.resolver(model, sessionId),
						toolChoice: schema ? { type: "tool", name: RESPOND_TOOL } : undefined,
					},
				);
				if (reply.stopReason === "error" || reply.stopReason === "aborted") {
					throw new Error(reply.errorMessage ?? `completion ${reply.stopReason}`);
				}
				const label = `${model.provider}/${model.id}`;
				count(jurors, label);
				return schema ? { data: structured(reply), model: label } : { text: replyText(reply), model: label };
			},
			close: () => authStorage.close(),
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}
