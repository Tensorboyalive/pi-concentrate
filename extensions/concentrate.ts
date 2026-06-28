import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROVIDER_ID = "concentrate";
const PROVIDER_NAME = "Concentrate";
const DEFAULT_BASE_URL = "https://api.concentrate.ai/v1";
const MODELS_URL = `${DEFAULT_BASE_URL}/models`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

type ConcentrateListModel = {
	id: string;
	display_name?: string;
	owned_by?: string;
	max_input_tokens?: number;
	max_tokens?: number;
	capabilities?: {
		effort?: {
			supported?: boolean;
			low?: { supported?: boolean };
			medium?: { supported?: boolean };
			high?: { supported?: boolean };
			xhigh?: { supported?: boolean };
		};
		thinking?: { supported?: boolean };
		image_input?: { supported?: boolean };
	};
};

type ConcentrateListResponse = {
	data?: ConcentrateListModel[];
};

type CachedModels = {
	fetchedAt: number;
	models: ConcentrateListModel[];
};

type PiModelConfig = {
	id: string;
	name: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	thinkingLevelMap?: Record<string, string | null>;
};

const FALLBACK_MODELS: ConcentrateListModel[] = [
	{
		id: "glm-5.2",
		display_name: "GLM-5.2",
		owned_by: "zai",
		max_input_tokens: 1_048_576,
		max_tokens: 256_000,
		capabilities: {
			effort: {
				supported: true,
				low: { supported: true },
				medium: { supported: true },
				high: { supported: true },
				xhigh: { supported: false },
			},
			thinking: { supported: true },
			image_input: { supported: false },
		},
	},
	{
		id: "gpt-5.5",
		display_name: "GPT-5.5",
		owned_by: "openai",
		max_input_tokens: 400_000,
		max_tokens: 128_000,
	},
	{
		id: "claude-opus-4-8",
		display_name: "Claude Opus 4.8",
		owned_by: "anthropic",
		max_input_tokens: 1_000_000,
		max_tokens: 128_000,
	},
];

function cachePath() {
	return join(getAgentDir(), "cache", "pi-concentrate-provider", "models.json");
}

function readCache(): CachedModels | undefined {
	const path = cachePath();
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as CachedModels;
		if (!Array.isArray(parsed.models)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function writeCache(models: ConcentrateListModel[]) {
	const path = cachePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), models } satisfies CachedModels, null, 2));
}

async function fetchModels(): Promise<ConcentrateListModel[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(MODELS_URL, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Concentrate model catalog returned HTTP ${response.status}`);
		}
		const payload = (await response.json()) as ConcentrateListResponse;
		if (!Array.isArray(payload.data) || payload.data.length === 0) {
			throw new Error("Concentrate model catalog did not include models");
		}
		return payload.data;
	} finally {
		clearTimeout(timeout);
	}
}

async function loadModels(forceRefresh = false): Promise<ConcentrateListModel[]> {
	const cached = readCache();
	if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return cached.models;
	}

	try {
		const models = await fetchModels();
		writeCache(models);
		return models;
	} catch {
		if (cached?.models.length) return cached.models;
		return FALLBACK_MODELS;
	}
}

function supports(capability?: { supported?: boolean }) {
	return capability?.supported === true;
}

function thinkingLevelMap(model: ConcentrateListModel): Record<string, string | null> | undefined {
	const effort = model.capabilities?.effort;
	if (!effort?.supported) return undefined;

	return {
		off: "none",
		minimal: null,
		low: supports(effort.low) ? "low" : null,
		medium: supports(effort.medium) ? "medium" : null,
		high: supports(effort.high) ? "high" : null,
		xhigh: supports(effort.xhigh) ? "xhigh" : null,
	};
}

function modelCost(modelId: string) {
	if (modelId === "glm-5.2") {
		return { input: 1.4, output: 4.4, cacheRead: 0.25, cacheWrite: 1.4 };
	}
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function toPiModel(model: ConcentrateListModel): PiModelConfig {
	const reasoning = supports(model.capabilities?.effort) || supports(model.capabilities?.thinking);
	const input = supports(model.capabilities?.image_input) ? ["text", "image"] : ["text"];
	return {
		id: model.id,
		name: `${model.display_name ?? model.id}${model.owned_by ? ` — ${model.owned_by}` : ""} via Concentrate`,
		reasoning,
		input,
		contextWindow: model.max_input_tokens ?? 128_000,
		maxTokens: model.max_tokens ?? 16_384,
		cost: modelCost(model.id),
		...(reasoning ? { thinkingLevelMap: thinkingLevelMap(model) } : {}),
	};
}

async function registerConcentrate(pi: ExtensionAPI, forceRefresh = false) {
	const models = (await loadModels(forceRefresh)).map(toPiModel);
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: process.env.CONCENTRATE_BASE_URL || DEFAULT_BASE_URL,
		apiKey: "$CONCENTRATE_API_KEY",
		api: "openai-responses",
		models,
	});
	return models.length;
}

function splitArgs(args: string) {
	return args.trim().split(/\s+/).filter(Boolean);
}

export default async function concentrateProvider(pi: ExtensionAPI) {
	await registerConcentrate(pi);

	pi.registerCommand("concentrate", {
		description: "Show or refresh the Concentrate provider model catalog",
		getArgumentCompletions: (prefix) => {
			return ["status", "refresh"]
				.filter((item) => item.startsWith(prefix))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const [command = "status"] = splitArgs(args);
			if (command === "refresh") {
				const count = await registerConcentrate(pi, true);
				ctx.ui.notify(`Concentrate catalog refreshed: ${count} models`, "info");
				return;
			}

			const allModels = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID);
			const availableModels = ctx.modelRegistry.getAvailable().filter((model) => model.provider === PROVIDER_ID);
			ctx.ui.notify(
				`Concentrate registered ${allModels.length} models; ${availableModels.length} available. use /login → API key → Concentrate if available is 0.`,
				availableModels.length > 0 ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("glm52", {
		description: "Switch to Concentrate GLM-5.2",
		handler: async (_args, ctx) => {
			const model = ctx.modelRegistry.find(PROVIDER_ID, "glm-5.2");
			if (!model) {
				ctx.ui.notify("Concentrate GLM-5.2 is not registered. run /concentrate refresh, then retry.", "error");
				return;
			}
			const ok = await pi.setModel(model);
			if (!ok) {
				ctx.ui.notify("No Concentrate API key configured. run /login → API key → Concentrate.", "warning");
				return;
			}
			pi.setThinkingLevel("high");
			ctx.ui.notify("switched to concentrate/glm-5.2 with high thinking", "info");
		},
	});
}
