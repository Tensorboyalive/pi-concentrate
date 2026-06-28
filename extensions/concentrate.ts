import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	calculateCost,
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
} from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROVIDER_ID = "concentrate";
const PROVIDER_NAME = "Concentrate";
const DEFAULT_BASE_URL = "https://api.concentrate.ai/v1";
const MODELS_URL = `${DEFAULT_BASE_URL}/models`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

function normalizeBaseUrl(value?: string) {
	const base = (value || DEFAULT_BASE_URL).replace(/\/+$/, "");
	return base.endsWith("/v1") ? base : `${base}/v1`;
}

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

type ChatToolCallDelta = {
	index?: number;
	id?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
};

type ChatCompletionChunk = {
	id?: string;
	model?: string;
	choices?: Array<{
		finish_reason?: string | null;
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			reasoning_text?: string | null;
			tool_calls?: ChatToolCallDelta[];
		};
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
		prompt_cache_hit_tokens?: number;
	};
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

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function parseUsage(rawUsage: NonNullable<ChatCompletionChunk["usage"]>, model: Model<any>) {
	const promptTokens = rawUsage.prompt_tokens ?? 0;
	const cacheRead = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
	const cacheWrite = rawUsage.prompt_tokens_details?.cache_write_tokens ?? 0;
	const output = rawUsage.completion_tokens ?? 0;
	const usage = {
		input: Math.max(0, promptTokens - cacheRead - cacheWrite),
		output,
		cacheRead,
		cacheWrite,
		totalTokens: Math.max(0, promptTokens - cacheRead - cacheWrite) + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function convertTools(tools: Context["tools"]) {
	return (tools ?? []).map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

function normalizeToolCallId(id: string) {
	if (id.includes("|")) return id.split("|")[0].replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
	return id.length > 40 ? id.slice(0, 40) : id;
}

function convertContent(content: any, supportsImages: boolean) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((item) => {
		if (item.type === "text") return { type: "text", text: item.text };
		if (item.type === "image" && supportsImages) return { type: "image_url", image_url: { url: `data:${item.mimeType};base64,${item.data}` } };
		if (item.type === "image") return { type: "text", text: "[image omitted: selected Concentrate model does not support image input]" };
		return { type: "text", text: "" };
	});
}

function textFromContent(content: any) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (item.type === "text" ? item.text : item.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

function convertMessages(model: Model<any>, context: Context) {
	const messages: any[] = [];
	const supportsImages = model.input?.includes("image") === true;
	if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });

	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push({ role: "user", content: convertContent(message.content, supportsImages) });
			continue;
		}

		if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			const text = message.content
				.filter((block: any) => block.type === "text")
				.map((block: any) => block.text)
				.join("");
			const toolCalls = message.content
				.filter((block: any) => block.type === "toolCall")
				.map((block: any) => ({
					id: normalizeToolCallId(block.id),
					type: "function",
					function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
				}));
			const assistantMessage: any = { role: "assistant", content: text || null };
			if (toolCalls.length) assistantMessage.tool_calls = toolCalls;
			messages.push(assistantMessage);
			continue;
		}

		if (message.role === "toolResult") {
			messages.push({
				role: "tool",
				tool_call_id: normalizeToolCallId(message.toolCallId),
				content: textFromContent(message.content),
			});
		}
	}

	return messages;
}

function mapStopReason(reason: string | null | undefined): { stopReason: StopReason; errorMessage?: string } {
	if (!reason || reason === "stop" || reason === "end") return { stopReason: "stop" };
	if (reason === "length") return { stopReason: "length" };
	if (reason === "function_call" || reason === "tool_calls") return { stopReason: "toolUse" };
	return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
}

function parsePartialJson(text: string) {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

function mergeHeaders(...records: Array<Record<string, string | null | undefined> | undefined>) {
	const headers: Record<string, string> = {};
	for (const record of records) {
		for (const [key, value] of Object.entries(record ?? {})) {
			if (value === null) {
				const existing = Object.keys(headers).find((header) => header.toLowerCase() === key.toLowerCase());
				if (existing) delete headers[existing];
				continue;
			}
			if (value === undefined || value === "") continue;
			headers[key] = value;
		}
	}
	return headers;
}

function resolveReasoningEffort(model: Model<any>, options?: SimpleStreamOptions) {
	if (!options?.reasoning) return undefined;
	const mapped = model.thinkingLevelMap?.[options.reasoning] ?? options.reasoning;
	return typeof mapped === "string" ? mapped : undefined;
}

function requestSignal(options?: SimpleStreamOptions) {
	const signals: AbortSignal[] = [];
	if (options?.signal) signals.push(options.signal);
	if (options?.timeoutMs && options.timeoutMs > 0) signals.push(AbortSignal.timeout(options.timeoutMs));
	if (signals.length === 0) return undefined;
	if (signals.length === 1) return signals[0];
	return AbortSignal.any(signals);
}

function streamConcentrate(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);

			let payload: any = {
				model: model.id,
				messages: convertMessages(model, context),
				stream: true,
				stream_options: { include_usage: true },
			};

			if (options.maxTokens) payload.max_tokens = options.maxTokens;
			if (options.temperature !== undefined) payload.temperature = options.temperature;
			const reasoningEffort = resolveReasoningEffort(model, options);
			if (reasoningEffort && model.reasoning) payload.reasoning_effort = reasoningEffort;
			if (context.tools?.length) payload.tools = convertTools(context.tools);

			const nextPayload = await options.onPayload?.(payload, model);
			if (nextPayload !== undefined) payload = nextPayload;

			const requestHeaders = mergeHeaders(
				{
					Authorization: `Bearer ${options.apiKey}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					"User-Agent": "pi-concentrate/0.1",
				},
				model.headers,
				options.headers,
			);
			const response = await fetch(`${normalizeBaseUrl(model.baseUrl)}/chat/completions`, {
				method: "POST",
				headers: requestHeaders,
				body: JSON.stringify(payload),
				signal: requestSignal(options),
			});

			await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);

			if (!response.ok) {
				throw new Error(`${response.status} ${await response.text()}`);
			}
			if (!response.body) throw new Error("Concentrate returned an empty response body");

			stream.push({ type: "start", partial: output });

			const blocks = output.content;
			let textBlock: any;
			let thinkingBlock: any;
			let hasFinishReason = false;
			const toolCallBlocksByIndex = new Map<number, any>();
			const toolCallBlocksById = new Map<string, any>();
			const getContentIndex = (block: any) => blocks.indexOf(block);

			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				return textBlock;
			};

			const ensureThinkingBlock = () => {
				if (!thinkingBlock) {
					thinkingBlock = { type: "thinking", thinking: "", thinkingSignature: "reasoning_content" };
					blocks.push(thinkingBlock);
					stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				return thinkingBlock;
			};

			const ensureToolCallBlock = (toolCall: ChatToolCallDelta) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!block && toolCall.id) block = toolCallBlocksById.get(toolCall.id);
				if (!block) {
					block = {
						type: "toolCall",
						id: toolCall.id || "",
						name: toolCall.function?.name || "",
						arguments: {},
						partialArgs: "",
						streamIndex,
					};
					if (streamIndex !== undefined) toolCallBlocksByIndex.set(streamIndex, block);
					if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
					blocks.push(block);
					stream.push({ type: "toolcall_start", contentIndex: getContentIndex(block), partial: output });
				}
				if (toolCall.id && !block.id) {
					block.id = toolCall.id;
					toolCallBlocksById.set(toolCall.id, block);
				}
				if (toolCall.function?.name && !block.name) block.name = toolCall.function.name;
				return block;
			};

			const finishBlock = (block: any) => {
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) return;
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
				} else if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
				} else if (block.type === "toolCall") {
					block.arguments = parsePartialJson(block.partialArgs || "{}");
					delete block.partialArgs;
					delete block.streamIndex;
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
				}
			};

			const handleChunk = (chunk: ChatCompletionChunk) => {
				output.responseId ||= chunk.id;
				if (chunk.model && chunk.model !== model.id) output.responseModel ||= chunk.model;
				if (chunk.usage) output.usage = parseUsage(chunk.usage, model);

				const choice = chunk.choices?.[0];
				if (!choice) return;
				if (choice.finish_reason) {
					const mapped = mapStopReason(choice.finish_reason);
					output.stopReason = mapped.stopReason;
					if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
					hasFinishReason = true;
				}

				const delta = choice.delta;
				if (!delta) return;
				if (delta.content) {
					const block = ensureTextBlock();
					block.text += delta.content;
					stream.push({ type: "text_delta", contentIndex: getContentIndex(block), delta: delta.content, partial: output });
				}

				const reasoningDelta = delta.reasoning_content || delta.reasoning || delta.reasoning_text;
				if (reasoningDelta) {
					const block = ensureThinkingBlock();
					block.thinking += reasoningDelta;
					stream.push({ type: "thinking_delta", contentIndex: getContentIndex(block), delta: reasoningDelta, partial: output });
				}

				for (const toolCall of delta.tool_calls ?? []) {
					const block = ensureToolCallBlock(toolCall);
					const argsDelta = toolCall.function?.arguments ?? "";
					block.partialArgs = (block.partialArgs ?? "") + argsDelta;
					block.arguments = parsePartialJson(block.partialArgs);
					stream.push({ type: "toolcall_delta", contentIndex: getContentIndex(block), delta: argsDelta, partial: output });
				}
			};

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const events = buffer.split(/\r?\n\r?\n/);
				buffer = events.pop() ?? "";
				for (const event of events) {
					const data = event
						.split(/\r?\n/)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (!data || data === "[DONE]") continue;
					handleChunk(JSON.parse(data) as ChatCompletionChunk);
				}
			}

			if (buffer.trim()) {
				const data = buffer
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (data && data !== "[DONE]") handleChunk(JSON.parse(data) as ChatCompletionChunk);
			}

			for (const block of blocks) finishBlock(block);
			if (options.signal?.aborted) throw new Error("Request was aborted");
			if (!hasFinishReason) throw new Error("Stream ended without finish_reason");
			if (output.stopReason === "error") throw new Error(output.errorMessage || "Provider returned an error stop reason");

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content as any[]) {
				delete block.partialArgs;
				delete block.streamIndex;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		}
	})();

	return stream;
}

async function registerConcentrate(pi: ExtensionAPI, forceRefresh = false) {
	const models = (await loadModels(forceRefresh)).map(toPiModel);
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: normalizeBaseUrl(process.env.CONCENTRATE_BASE_URL),
		apiKey: "$CONCENTRATE_API_KEY",
		api: "concentrate-completions",
		streamSimple: streamConcentrate,
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
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
