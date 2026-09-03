/**
 * Resolve the running app's bundle id so the knowledge graph lands in
 * `~/.para/knowledge/<bundle>.db` instead of a shared fallback.
 *
 * Inspector payloads are inconsistent: some put the id on `app_state`
 * (`bundle_id` / `CFBundleIdentifier` / nested `app`), others only on
 * `ping.app` as a reverse-DNS string. We accept every shape we have seen
 * rather than assuming one endpoint.
 */
const BUNDLE_ID_KEYS = [
	"bundle_id",
	"bundleId",
	"bundle",
	"app_id",
	"appId",
	"CFBundleIdentifier",
	"packageName",
	"package_name",
	"package",
] as const;

const NEST_KEYS = ["app", "application", "target", "identity"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const s = v.trim();
	return s ? s : null;
}

/** Pull a bundle / package id out of an inspector JSON payload. */
export function extractBundleId(payload: unknown, depth = 0): string | null {
	if (!isRecord(payload) || depth > 3) return null;

	for (const key of BUNDLE_ID_KEYS) {
		const id = nonEmpty(payload[key]);
		if (id) return id;
	}

	for (const key of NEST_KEYS) {
		const nested = payload[key];
		const asString = nonEmpty(nested);
		if (asString) return asString;
		const fromObj = extractBundleId(nested, depth + 1);
		if (fromObj) return fromObj;
	}

	return null;
}

export interface BundleIdClient {
	appState(signal?: AbortSignal): Promise<unknown>;
	ping(signal?: AbortSignal): Promise<unknown>;
}

/**
 * Configured id wins; otherwise app_state, then ping. Never throws —
 * returns `unknown_app` when every source is empty or unreachable.
 */
export async function resolveBundleId(
	client: BundleIdClient,
	configured: string,
	signal?: AbortSignal,
): Promise<string> {
	const fromCfg = configured.trim();
	if (fromCfg) return fromCfg;

	try {
		const fromState = extractBundleId(await client.appState(signal));
		if (fromState) return fromState;
	} catch {
		// fall through to ping
	}

	try {
		const fromPing = extractBundleId(await client.ping(signal));
		if (fromPing) return fromPing;
	} catch {
		// fall through to default
	}

	return "unknown_app";
}
