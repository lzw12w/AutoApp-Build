/**
 * Para config. File first, then env.
 *
 * File: ~/.para/config.toml (Para-V2's own home, independent from the Python
 * agent's ~/.ios-inspector).
 * Env: INSPECTOR_* (Python names) and PARA_* aliases.
 *
 * LLM credentials are intentionally NOT part of Para config: pi owns them, but
 * from Para's OWN agent home (~/.para/agent/models.json + auth.json, via
 * applyAgentDir), never the shared ~/.pi/agent. Para only selects a
 * provider/model; it never reads ANTHROPIC_* / OPENAI_*.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_PATH = join(homedir(), ".para", "config.toml");

/** Para's own pi-agent home. Kept separate from ~/.pi/agent so Para's LLM
 * providers/credentials/sessions never mix with a plain `pi` install. */
export const PARA_AGENT_DIR = join(homedir(), ".para", "agent");

/**
 * Redirect pi's config layer (models.json, auth.json, settings.json, sessions)
 * to Para's own home before any pi code reads it. pi resolves getAgentDir()
 * from PI_CODING_AGENT_DIR (ENV_AGENT_DIR), so we set that. Location is
 * overridable via PARA_AGENT_DIR. MUST run before ModelRuntime.create(),
 * getAgentDir(), or spawning a child `pi` — call it at CLI entry.
 */
export function applyAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PARA_AGENT_DIR?.trim() || PARA_AGENT_DIR;
	env.PI_CODING_AGENT_DIR = dir;
	// Para is not a pi distribution. Leave an explicit user value alone.
	if (!env.PI_SKIP_VERSION_CHECK?.trim()) env.PI_SKIP_VERSION_CHECK = "1";
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// non-fatal: pi still creates what it needs on write
	}
	return dir;
}

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
	/**
	 * Provider id selecting which pi provider to use (Para's ~/.para/agent/models.json
	 * or a built-in). Para no longer stores API keys or base URLs itself — those
	 * live entirely in pi's config so we never hijack the shared ANTHROPIC_* env.
	 */
	llmProvider: string;
	llmModel: string;
	anthropicThinkingBudget?: number;
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

/** Strip a `#` comment, but not one inside a single/double-quoted string. */
function stripInlineComment(line: string): string {
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === "#") {
			return line.slice(0, i);
		}
	}
	return line;
}

/** Minimal flat TOML: `key = "str"` / `key = 1` / `key = true`. Ignores tables. */
export function parseFlatToml(text: string): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripInlineComment(rawLine).trim();
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
			cfg.anthropicThinkingBudget = num(data.anthropic_thinking_budget);
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
	// Credentials & base URLs are pi's job now (~/.para/agent/models.json + auth.json).
	// Para deliberately does NOT read ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL /
	// OPENAI_* so it never collides with a separate proxy owning those globals.
	if (env.ANTHROPIC_THINKING_BUDGET) cfg.anthropicThinkingBudget = Number(env.ANTHROPIC_THINKING_BUDGET) || undefined;
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

/** Copy Para's inspector keys into process.env for a child `pi -e` (never overwrite). */
export function applyConfigToEnv(cfg: ParaConfig, env: NodeJS.ProcessEnv = process.env): void {
	const setIfAbsent = (key: string, value: string | undefined) => {
		if (!value) return;
		if (!env[key]) env[key] = value;
	};
	// No LLM credentials here on purpose: pi reads its own ~/.para/agent config, so
	// Para must not touch ANTHROPIC_* / OPENAI_* (a separate proxy may own them).
	setIfAbsent("PARA_INSPECTOR_HOST", cfg.inspectorHost);
	setIfAbsent("PARA_INSPECTOR_PORT", String(cfg.inspectorPort));
	if (cfg.inspectorDevice) setIfAbsent("PARA_DEVICE_UDID", cfg.inspectorDevice);
	if (cfg.inspectorPlatform !== "auto") setIfAbsent("PARA_INSPECTOR_PLATFORM", cfg.inspectorPlatform);
	if (cfg.inspectorRemotePort) setIfAbsent("PARA_INSPECTOR_REMOTE_PORT", String(cfg.inspectorRemotePort));
	if (cfg.bundleId) setIfAbsent("PARA_BUNDLE_ID", cfg.bundleId);
	if (cfg.knowledgeDir) setIfAbsent("PARA_KNOWLEDGE_DIR", cfg.knowledgeDir);
	if (!cfg.autoTunnel) env.PARA_AUTO_TUNNEL = "0";
}

/** After device routing, overwrite inspector bind so a child `pi -e` sees the assigned port. */
export function syncInspectorEnv(cfg: ParaConfig, env: NodeJS.ProcessEnv = process.env): void {
	env.PARA_INSPECTOR_HOST = cfg.inspectorHost;
	env.PARA_INSPECTOR_PORT = String(cfg.inspectorPort);
	if (cfg.inspectorDevice) env.PARA_DEVICE_UDID = cfg.inspectorDevice;
	if (cfg.inspectorPlatform !== "auto") env.PARA_INSPECTOR_PLATFORM = cfg.inspectorPlatform;
	if (cfg.inspectorRemotePort !== undefined) env.PARA_INSPECTOR_REMOTE_PORT = String(cfg.inspectorRemotePort);
}

/** Env var names pi reads as the API key for a given provider id. */
function providerEnvKeys(provider: string): string[] {
	if (provider === "openai") return ["OPENAI_API_KEY"];
	if (provider === "deepseek") return ["DEEPSEEK_API_KEY"];
	// anthropic and anthropic-compatible gateways
	return ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
}

function readJson(path: string): Record<string, unknown> | null {
	try {
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Best-effort pre-flight for `para doctor`: is a usable credential reachable
 * for the configured provider? Credentials live in pi under Para's own agent
 * home (~/.para/agent), so we check, in order: an apiKey on the provider in
 * models.json → a stored auth.json credential → one of the provider's API-key
 * env vars. This mirrors pi's own resolution well enough to warn early without
 * duplicating its logic.
 */
export function llmKeySet(cfg: ParaConfig): boolean {
	const provider = cfg.llmProvider.trim() || "anthropic";
	const agentDir = getAgentDir();

	const models = readJson(join(agentDir, "models.json"));
	const providers = models && typeof models.providers === "object" ? (models.providers as Record<string, unknown>) : null;
	// A custom provider selected by id (e.g. "super-relay") with its own apiKey.
	const chosen = providers?.[provider];
	if (chosen && typeof chosen === "object" && (chosen as Record<string, unknown>).apiKey) return true;
	// Or ANY custom provider carrying an apiKey when llm_model matches a model it
	// declares (users often leave llm_provider unset and just pick a model id).
	if (providers && cfg.llmModel.trim()) {
		const wanted = cfg.llmModel.trim().toLowerCase();
		for (const value of Object.values(providers)) {
			if (!value || typeof value !== "object") continue;
			const p = value as Record<string, unknown>;
			if (!p.apiKey) continue;
			const list = Array.isArray(p.models) ? p.models : [];
			if (list.some((m) => m && typeof m === "object" && String((m as Record<string, unknown>).id ?? "").toLowerCase() === wanted)) {
				return true;
			}
		}
	}

	const auth = readJson(join(agentDir, "auth.json"));
	if (auth && Object.keys(auth).length > 0) return true;

	return providerEnvKeys(provider).some((name) => Boolean(process.env[name]));
}

export function defaultNotePath(cfg: ParaConfig): string {
	return cfg.notePath || join(homedir(), ".para", "NOTE.md");
}
