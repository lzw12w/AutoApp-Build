/**
 * Bounded settle-window polling. Ported from post_check._poll_until.
 *
 * Always samples at least once. Cancelled (AbortSignal) escapes the loop
 * instead of folding into a probe-failure dict.
 */
import { Cancelled } from "../errors.ts";

export const DEFAULT_SETTLE_VC_DIFF_MS = 600;
export const DEFAULT_POLL_INTERVAL_MS = 50;

export function intEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : fallback;
}

export function settleVcDiffMs(): number {
	return Math.max(0, intEnv("INSPECTOR_SETTLE_VC_DIFF_MS", DEFAULT_SETTLE_VC_DIFF_MS));
}

export function pollIntervalMs(): number {
	return Math.max(1, intEnv("INSPECTOR_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS));
}

export async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	if (signal?.aborted) throw new Cancelled();
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Cancelled());
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
	});
}

export async function pollUntil<T>(
	sample: () => Promise<T>,
	isDone: (value: T) => boolean,
	opts: { settleMs: number; pollMs: number; signal?: AbortSignal },
): Promise<{ value: T; polls: number; elapsedMs: number }> {
	const pollMs = Math.max(1, Math.trunc(opts.pollMs));
	const settleMs = Math.max(0, Math.trunc(opts.settleMs));
	const start = Date.now();
	const deadline = start + settleMs;
	let last!: T;
	let polls = 0;
	while (true) {
		if (opts.signal?.aborted) throw new Cancelled();
		last = await sample();
		polls += 1;
		const now = Date.now();
		if (isDone(last) || now >= deadline) {
			return { value: last, polls, elapsedMs: now - start };
		}
		const sleepFor = Math.min(pollMs, deadline - now);
		if (sleepFor > 0) await sleepAbortable(sleepFor, opts.signal);
	}
}
