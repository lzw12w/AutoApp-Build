/**
 * Para config. File first, then env.
 *
 * File: ~/.ios-inspector/config.toml (same path as the Python agent).
 * Env: INSPECTOR_* / ANTHROPIC_* / OPENAI_* (Python names) and PARA_* aliases.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".ios-inspector", "config.toml");

export interface ParaConfig {
	inspectorHost: string;
	inspectorPort: number;
	inspectorDevice: string;
	inspectorTimeoutMs: number;
	/** `auto` infers ios vs android from --device / plugged-in devices. */
	inspectorPlatform: "auto" | "ios" | "android";
	/** On-device inspector port. Unset: Android 8765, iOS same as local port. */
	inspectorRemotePort?: number;
	bundleId: string;
	knowledgeDir?: string;
	autoTunnel: boolean;
	disableKnowledge: boolean;
	llmProvider: string;
	llmModel: string;
	anthropicApiKey?: string;
	anthropicBaseUrl?: string;
	anthropicThinkingBudget?: number;
	openaiApiKey?: string;
	openaiBaseUrl?: string;
	notePath?: string;
	llmMaxTokens?: number;
	/** Session start mode: gui (device) or code (repo). */
	mode: "gui" | "code";
	/** Layer 1: rewrite old view_hierarchy results in the LLM view. */
	elideOldViewHierarchies: boolean;
	/** How many recent view_hierarchy results stay verbatim. */
	elideKeepRecent: number;
}

const DEFAULTS: ParaConfig = {
	inspectorHost: "localhost",
	inspectorPort: 8765,
	inspectorDevice: "",
	inspectorTimeoutMs: 5000,
	inspectorPlatform: "auto",
	bundleId: "",
	autoTunnel: true,
	disableKnowledge: false,
	llmProvider: "anthropic",
	llmModel: "",
	mode: "gui",
	elideOldViewHierarchies: true,
	elideKeepRecent: 2,
};

function truthy(raw: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes((raw ?? "").trim().toLowerCase());
}

function falsy(raw: string | undefined): boolean {
	return ["0", "false", "no", "off"].includes((raw ?? "").trim().toLowerCase());
}

/** Minimal flat TOML: `key = "str"` / `key = 1` / `key = true`. Ignores tables. */
export function parseFlatToml(text: string): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, "").trim();
		if (!line || line.startsWith("[")) continue;
		const eq = line.indexOf("=");
		if (eq < 1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (!key) continue;
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			out[key] = value.slice(1, -1);
			continue;
		}
		if (value === "true" || value === "false") {
			out[key] = value === "true";
			continue;
		}
		if (/^-?\d+(\.\d+)?$/.test(value)) {
			out[key] = Number(value);
			continue;
		}
		out[key] = value;
	}
	return out;
}

function parsePlatform(raw: string | undefined): "auto" | "ios" | "android" | undefined {
	const v = (raw ?? "").trim().toLowerCase();
	if (v === "auto" || v === "ios" || v === "android") return v;
	return undefined;
}

function str(v: unknown): string | undefined {
	if (v === undefined || v === null) return undefined;
	const s = String(v).trim();
	return s ? s : undefined;
}

function num(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim()) {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

export function loadConfig(options: { tomlPath?: string; env?: NodeJS.ProcessEnv } = {}): ParaConfig {
	const env = options.env ?? process.env;
	const cfg: ParaConfig = { ...DEFAULTS };

	const tomlPath = options.tomlPath ?? env.PARA_CONFIG ?? CONFIG_PATH;
	if (existsSync(tomlPath)) {
		try {
			const data = parseFlatToml(readFileSync(tomlPath, "utf8"));
			cfg.inspectorHost = str(data.inspector_host) ?? cfg.inspectorHost;
			cfg.inspectorPort = num(data.inspector_port) ?? cfg.inspectorPort;
			cfg.inspectorDevice = str(data.inspector_device) ?? cfg.inspectorDevice;
			const plat = parsePlatform(str(data.inspector_platform) ?? str(data.para_inspector_platform));
			if (plat) cfg.inspectorPlatform = plat;
			cfg.inspectorRemotePort = num(data.inspector_remote_port) ?? cfg.inspectorRemotePort;
			const timeoutSec = num(data.inspector_timeout);
			if (timeoutSec !== undefined) cfg.inspectorTimeoutMs = Math.round(timeoutSec * 1000);
			cfg.bundleId = str(data.bundle_id) ?? cfg.bundleId;
			if (typeof data.disable_knowledge === "boolean") cfg.disableKnowledge = data.disable_knowledge;
			cfg.llmProvider = str(data.llm_provider) ?? cfg.llmProvider;
			cfg.llmModel = str(data.llm_model) ?? cfg.llmModel;
			cfg.anthropicApiKey = str(data.anthropic_api_key);
			cfg.anthropicBaseUrl = str(data.anthropic_base_url);
			cfg.anthropicThinkingBudget = num(data.anthropic_thinking_budget);
			cfg.openaiApiKey = str(data.openai_api_key);
			cfg.openaiBaseUrl = str(data.openai_base_url);
			cfg.notePath = str(data.note_path);
			cfg.llmMaxTokens = num(data.llm_max_tokens);
			if (typeof data.elide_old_view_hierarchies === "boolean") {
				cfg.elideOldViewHierarchies = data.elide_old_view_hierarchies;
			}
			const keep = num(data.elide_keep_recent);
			if (keep !== undefined) cfg.elideKeepRecent = Math.max(0, Math.trunc(keep));
			const mode = str(data.para_mode) ?? str(data.mode);
			if (mode === "gui" || mode === "code") cfg.mode = mode;
		} catch {
			// malformed toml is ignored; env still applies
		}
	}

	cfg.inspectorHost = env.PARA_INSPECTOR_HOST || env.INSPECTOR_HOST || cfg.inspectorHost;
	const port = env.PARA_INSPECTOR_PORT || env.INSPECTOR_PORT;
	if (port) cfg.inspectorPort = Number(port) || cfg.inspectorPort;
	cfg.inspectorDevice = env.PARA_DEVICE_UDID || env.INSPECTOR_DEVICE || cfg.inspectorDevice;
	const platEnv = parsePlatform(env.PARA_INSPECTOR_PLATFORM || env.INSPECTOR_PLATFORM);
	if (platEnv) cfg.inspectorPlatform = platEnv;
	const remotePort = env.PARA_INSPECTOR_REMOTE_PORT || env.INSPECTOR_REMOTE_PORT;
	if (remotePort) cfg.inspectorRemotePort = Number(remotePort) || cfg.inspectorRemotePort;
	cfg.bundleId = env.PARA_BUNDLE_ID || env.INSPECTOR_BUNDLE_ID || cfg.bundleId;
	if (env.PARA_KNOWLEDGE_DIR) cfg.knowledgeDir = env.PARA_KNOWLEDGE_DIR;
	if (env.PARA_AUTO_TUNNEL !== undefined) {
		cfg.autoTunnel = !falsy(env.PARA_AUTO_TUNNEL);
	}
	if (truthy(env.PARA_DISABLE_KNOWLEDGE) || truthy(env.INSPECTOR_DISABLE_KNOWLEDGE)) {
		cfg.disableKnowledge = true;
	}
	cfg.llmProvider = env.PARA_LLM_PROVIDER || env.INSPECTOR_LLM_PROVIDER || cfg.llmProvider;
	cfg.llmModel = env.PARA_LLM_MODEL || env.INSPECTOR_LLM_MODEL || env.ANTHROPIC_MODEL || cfg.llmModel;
	cfg.anthropicApiKey = env.ANTHROPIC_API_KEY || cfg.anthropicApiKey;
	cfg.anthropicBaseUrl = env.ANTHROPIC_BASE_URL || cfg.anthropicBaseUrl;
	if (env.ANTHROPIC_THINKING_BUDGET) cfg.anthropicThinkingBudget = Number(env.ANTHROPIC_THINKING_BUDGET) || undefined;
	cfg.openaiApiKey = env.OPENAI_API_KEY || cfg.openaiApiKey;
	cfg.openaiBaseUrl = env.OPENAI_BASE_URL || cfg.openaiBaseUrl;
	cfg.notePath = env.PARA_NOTE_PATH || env.INSPECTOR_NOTE_PATH || cfg.notePath;
	const envMode = (env.PARA_MODE || env.INSPECTOR_MODE || "").trim().toLowerCase();
	if (envMode === "gui" || envMode === "code") cfg.mode = envMode;
	if (truthy(env.PARA_DISABLE_VH_ELISION) || truthy(env.INSPECTOR_DISABLE_VH_ELISION)) {
		cfg.elideOldViewHierarchies = false;
	}
	const keepEnv = env.PARA_ELIDE_KEEP_RECENT || env.INSPECTOR_ELIDE_KEEP_RECENT;
	if (keepEnv) {
		const n = Number(keepEnv);
		if (Number.isFinite(n)) cfg.elideKeepRecent = Math.max(0, Math.trunc(n));
	}
	return cfg;
}

/** Copy keys pi / fetch will read into process.env (file → env, never overwrite). */
export function applyConfigToEnv(cfg: ParaConfig, env: NodeJS.ProcessEnv = process.env): void {
	const setIfAbsent = (key: string, value: string | undefined) => {
		if (!value) return;
		if (!env[key]) env[key] = value;
	};
	setIfAbsent("ANTHROPIC_API_KEY", cfg.anthropicApiKey);
	setIfAbsent("ANTHROPIC_BASE_URL", cfg.anthropicBaseUrl);
	setIfAbsent("OPENAI_API_KEY", cfg.openaiApiKey);
	setIfAbsent("OPENAI_BASE_URL", cfg.openaiBaseUrl);
	setIfAbsent("PARA_INSPECTOR_HOST", cfg.inspectorHost);
	setIfAbsent("PARA_INSPECTOR_PORT", String(cfg.inspectorPort));
	if (cfg.inspectorDevice) setIfAbsent("PARA_DEVICE_UDID", cfg.inspectorDevice);
	if (cfg.inspectorPlatform !== "auto") setIfAbsent("PARA_INSPECTOR_PLATFORM", cfg.inspectorPlatform);
	if (cfg.inspectorRemotePort) setIfAbsent("PARA_INSPECTOR_REMOTE_PORT", String(cfg.inspectorRemotePort));
	if (cfg.bundleId) setIfAbsent("PARA_BUNDLE_ID", cfg.bundleId);
	if (cfg.knowledgeDir) setIfAbsent("PARA_KNOWLEDGE_DIR", cfg.knowledgeDir);
	if (!cfg.autoTunnel) env.PARA_AUTO_TUNNEL = "0";
}

export function llmKeySet(cfg: ParaConfig): boolean {
	if (cfg.llmProvider === "openai") return Boolean(cfg.openaiApiKey || process.env.OPENAI_API_KEY);
	return Boolean(cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
}

export function defaultNotePath(cfg: ParaConfig): string {
	return cfg.notePath || join(homedir(), ".ios-inspector", "NOTE.md");
}
