/**
 * Content hashes for fingerprints and edge identity.
 *
 * Python used blake2b(digest_size=8). We use node:crypto blake2b512 truncated
 * to the same hex widths so the same code path runs under Bun tests and under
 * Node (pi's extension loader). Hashes are only compared within this store.
 */
import { createHash } from "node:crypto";

/** 64-bit hex digest. */
export function h64(text: string): string {
	return createHash("blake2b512").update(text, "utf8").digest("hex").slice(0, 16);
}

/** 32-bit hex digest. */
export function h32(text: string): string {
	return createHash("blake2b512").update(text, "utf8").digest("hex").slice(0, 8);
}
