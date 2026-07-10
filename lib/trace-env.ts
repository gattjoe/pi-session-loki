const TRACE_ID_ENV = "PI_AGENT_TRACE_ID";
const SPAN_ID_ENV = "PI_AGENT_SPAN_ID";

/**
 * CustomEntry type used to pass parent trace context into sub-sessions via SessionManager.
 * Preferred over env vars for in-process sub-sessions to avoid race conditions.
 */
export const TRACE_CONTEXT_ENTRY_TYPE = "telemetry-otel-trace-context";

/** Shape of the data stored in a trace context custom entry. */
export interface TraceContextEntryData {
	traceId: string;
	spanId: string;
	/** Optional service name override for the sub-session's OTEL resource. */
	serviceName?: string;
}

const TRACE_ID_LENGTH = 32;
const SPAN_ID_LENGTH = 16;
const TRACE_FLAGS_SAMPLED = 0x01;

export interface SpanContextLike {
	traceId: string;
	spanId: string;
	traceFlags: number;
	isRemote?: boolean;
}

export interface SpanLike {
	spanContext(): { traceId: string; spanId: string };
}

function isValidHexId(value: string, length: number): boolean {
	if (value.length !== length) return false;
	if (!/^[0-9a-f]+$/i.test(value)) return false;
	return !/^0+$/.test(value);
}

export function isValidTraceId(value: string): boolean {
	return isValidHexId(value, TRACE_ID_LENGTH);
}

function isValidSpanId(value: string): boolean {
	return isValidHexId(value, SPAN_ID_LENGTH);
}

export function readParentSpanContext(env: NodeJS.ProcessEnv = process.env): SpanContextLike | undefined {
	const traceId = env[TRACE_ID_ENV];
	const spanId = env[SPAN_ID_ENV];

	if (!traceId || !spanId) return undefined;
	if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) return undefined;

	return {
		traceId,
		spanId,
		traceFlags: TRACE_FLAGS_SAMPLED,
		isRemote: true,
	};
}

/**
 * Read parent span context from session entries (CustomEntry with TRACE_CONTEXT_ENTRY_TYPE).
 * Used for in-process sub-sessions where env vars may conflict; last matching entry wins.
 */
export function readParentSpanContextFromEntries(
	entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): SpanContextLike | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "custom" && entry.customType === TRACE_CONTEXT_ENTRY_TYPE) {
			const data = entry.data as TraceContextEntryData | undefined;
			if (!data?.traceId || !data?.spanId) continue;
			if (!isValidTraceId(data.traceId) || !isValidSpanId(data.spanId)) continue;

			return {
				traceId: data.traceId,
				spanId: data.spanId,
				traceFlags: TRACE_FLAGS_SAMPLED,
				isRemote: false,
			};
		}
	}

	return undefined;
}

/** Read service name override from session entries (if present in trace context entry). */
export function readServiceNameFromEntries(
	entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "custom" && entry.customType === TRACE_CONTEXT_ENTRY_TYPE) {
			const data = entry.data as TraceContextEntryData | undefined;
			return data?.serviceName;
		}
	}
	return undefined;
}

function syncTraceEnv(span: SpanLike, env: NodeJS.ProcessEnv = process.env): void {
	const { traceId, spanId } = span.spanContext();
	const existingTraceId = env[TRACE_ID_ENV];

	if (!existingTraceId || !isValidTraceId(existingTraceId)) {
		env[TRACE_ID_ENV] = traceId;
	}

	env[SPAN_ID_ENV] = spanId;
}

/** Tracks the active span per nested scope (session/agent/turn/tool) and syncs it to env for cross-process propagation. */
export class TraceEnvStack<TSpan extends SpanLike = SpanLike> {
	private stack: Array<{ key: string; span: TSpan }> = [];
	private readonly env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.env = env;
	}

	/** Returns the current top span (the one synced into env), if any. */
	peek(): TSpan | undefined {
		return this.stack[this.stack.length - 1]?.span;
	}

	push(key: string, span: TSpan): void {
		const existingIndex = this.stack.findIndex((entry) => entry.key === key);
		if (existingIndex !== -1) {
			this.stack.splice(existingIndex, 1);
		}

		this.stack.push({ key, span });
		syncTraceEnv(span, this.env);
	}

	pop(key: string): void {
		const index = this.stack.findIndex((entry) => entry.key === key);
		if (index === -1) return;

		const wasTop = index === this.stack.length - 1;
		this.stack.splice(index, 1);

		if (wasTop) {
			this.syncTop();
		}
	}

	syncTop(): void {
		const top = this.stack[this.stack.length - 1];
		if (!top) return;
		syncTraceEnv(top.span, this.env);
	}

	clear(): void {
		this.stack = [];
	}
}
