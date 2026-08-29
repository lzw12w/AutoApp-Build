/**
 * Domain errors for the iOS inspector transport/client layer.
 *
 * Ported from ios_inspector_agent/core/errors.py. These stay small and
 * transport-focused; the agent loop and provider handling now live in pi
 * (@earendil-works/pi-agent-core, @earendil-works/pi-ai) and are no longer
 * our concern.
 */

export interface InspectorErrorDetail {
	[key: string]: unknown;
}

/** Base for every error the inspector transport/client can raise. */
export class InspectorError extends Error {
	code: string;
	detail: InspectorErrorDetail;

	constructor(message: string, code = "E_INSPECTOR", detail: InspectorErrorDetail = {}) {
		super(message);
		this.name = "InspectorError";
		this.code = code;
		this.detail = detail;
	}
}

/** Cooperative cancellation — the owning turn was aborted. */
export class Cancelled extends InspectorError {
	constructor(message = "cancelled") {
		super(message, "E_CANCELLED");
		this.name = "Cancelled";
	}
}

/** Request timed out at the socket level. */
export class Timeout extends InspectorError {
	constructor(message: string) {
		super(message, "E_TIMEOUT");
		this.name = "Timeout";
	}
}

/** Nothing reachable at the inspector base URL (refused / DNS / reset). */
export class Unreachable extends InspectorError {
	constructor(message: string, detail: InspectorErrorDetail = {}) {
		super(message, "E_UNREACHABLE", detail);
		this.name = "Unreachable";
	}
}

/** Non-2xx HTTP status returned by the inspector server. */
export class HTTPStatusError extends InspectorError {
	status: number;
	body: string;

	constructor(status: number, body: string) {
		super(`HTTP ${status}: ${body.slice(0, 200)}`, "E_HTTP_STATUS", { status });
		this.name = "HTTPStatusError";
		this.status = status;
		this.body = body;
	}
}

/** Server responded, but the body was not the JSON we expected. */
export class InvalidResponse extends InspectorError {
	constructor(message: string) {
		super(message, "E_INVALID_RESPONSE");
		this.name = "InvalidResponse";
	}
}

/** Caller passed an argument the client refuses to send. */
export class InvalidArgument extends InspectorError {
	constructor(message: string) {
		super(message, "E_INVALID_ARGUMENT");
		this.name = "InvalidArgument";
	}
}
