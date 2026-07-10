import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Attributes, type Span, SpanStatusCode, type Tracer, context, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import {
	TraceEnvStack,
	isValidTraceId,
	readParentSpanContext,
	readParentSpanContextFromEntries,
	readServiceNameFromEntries,
} from "./lib/trace-env.ts";

// ---------------------------------------------------------------------------
// Loki: ship the full session transcript once a session ends.
// ---------------------------------------------------------------------------

const lokiEndpoint = "http://kenobi.echobase.network:30300/loki/api/v1/push";

// Session dirs are named like "--Users-joegatt-code-pi-omlx--"; trim the
// delimiters so the Loki label reads as a project name.
export function extractProject(sessionFile: string): string {
	return basename(dirname(sessionFile)).replace(/^-+|-+$/g, "");
}

// Loki requires non-decreasing timestamps within a stream; session entries
// are chronological already but can share a millisecond, so nudge ties.
export function toNanosSequence(lines: string[]): string[] {
	let last = -1n;
	return lines.map((line) => {
		let nanos: bigint;
		try {
			const parsed = JSON.parse(line) as { timestamp?: string };
			const ms = parsed.timestamp ? Date.parse(parsed.timestamp) : Number.NaN;
			nanos = Number.isNaN(ms) ? BigInt(Date.now()) * 1_000_000n : BigInt(ms) * 1_000_000n;
		} catch {
			nanos = BigInt(Date.now()) * 1_000_000n;
		}
		if (nanos <= last) nanos = last + 1n;
		last = nanos;
		return nanos.toString();
	});
}

export function buildLokiPayload(sessionId: string, project: string, lines: string[]) {
	const timestamps = toNanosSequence(lines);
	return {
		streams: [
			{
				stream: { job: "pi-session", project, session_id: sessionId },
				values: lines.map((line, i) => [timestamps[i], line]),
			},
		],
	};
}

// ---------------------------------------------------------------------------
// OTel: mirror the session as a live span tree in Tempo (ported from the
// former pi-telemetry-otel dependency so this extension is self-contained).
// ---------------------------------------------------------------------------

function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const DEFAULT_OTEL_ENDPOINT = "https://otel.echobase.network/v1/traces";
const DEFAULT_SERVICE_NAME = "pi-agent";
const PAYLOAD_MAX_BYTES = 8 * 1024;
const INPUT_PREVIEW_MAX_CHARS = 50;
const TOOL_COMMAND_PREVIEW_MAX_CHARS = 120;
const INPUT_LAST_SENTENCE_MAX_CHARS = 70;
const REDACTION_PATTERN = /api_key|token|secret|password/i;
const DEFAULT_JAEGER_TRACE_URL = "http://localhost:16686/trace";

interface TelemetryConfig {
	endpoint: string;
	headers: Record<string, string>;
	serviceName: string;
	resourceAttributes: Record<string, string>;
}

interface SpanRegistry {
	session?: Span;
	agent?: Span;
	turns: Map<number, Span>;
	tools: Map<string, Span>;
}

interface InputSummary {
	preview: string;
	previewBytes: number;
	previewTruncated: boolean;
	firstSentence?: string;
	firstSentenceTruncated?: boolean;
	lastSentence?: string;
	lastSentenceTruncated?: boolean;
}

function getEnvValue(key: string): string | undefined {
	return process.env[`PI_${key}`] ?? process.env[key];
}

function parseKeyValuePairs(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	return raw
		.split(",")
		.map((pair) => pair.trim())
		.filter(Boolean)
		.reduce<Record<string, string>>((acc, pair) => {
			const [key, ...rest] = pair.split("=");
			if (!key || rest.length === 0) return acc;
			acc[key.trim()] = rest.join("=").trim();
			return acc;
		}, {});
}

// A session inherits its agent name from PI_AGENT_CHAIN (set by pi when spawning
// sub-agents), e.g. "main>ask" -> "ask". Only the last link matters here.
function getCurrentAgentName(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env.PI_AGENT_CHAIN?.trim();
	if (!raw) return undefined;
	const chain = raw
		.split(">")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return chain.length > 0 ? chain[chain.length - 1] : undefined;
}

function resolveServiceName(): string {
	const explicitServiceName = getEnvValue("OTEL_SERVICE_NAME");
	if (explicitServiceName) return explicitServiceName;

	const agentName = getCurrentAgentName();
	if (agentName) return agentName;

	return DEFAULT_SERVICE_NAME;
}

function loadOtelConfig(): TelemetryConfig {
	const rawEndpoint = getEnvValue("OTEL_EXPORTER_OTLP_ENDPOINT");
	const endpoint =
		rawEndpoint && !rawEndpoint.endsWith("/v1/traces") ? rawEndpoint + "/v1/traces" : (rawEndpoint ?? DEFAULT_OTEL_ENDPOINT);
	const headers = parseKeyValuePairs(getEnvValue("OTEL_EXPORTER_OTLP_HEADERS"));
	const serviceName = resolveServiceName();
	const resourceAttributes = parseKeyValuePairs(getEnvValue("OTEL_RESOURCE_ATTRIBUTES"));
	console.error(
		`[pi-session-loki] otel endpoint=${endpoint} service=${serviceName} headers=${headers ? JSON.stringify(headers) : "none"}`,
	);

	return { endpoint, headers, serviceName, resourceAttributes };
}

function buildJaegerTraceUrl(traceId: string): string {
	return `${DEFAULT_JAEGER_TRACE_URL}/${traceId}`;
}

function getOpenUrlCommand(url: string): { command: string; args: string[] } {
	switch (process.platform) {
		case "darwin":
			return { command: "open", args: [url] };
		case "win32":
			return { command: "cmd", args: ["/c", "start", "", url] };
		default:
			return { command: "xdg-open", args: [url] };
	}
}

async function getTailscaleIp(pi: ExtensionAPI): Promise<string | undefined> {
	try {
		const { stdout, code } = await pi.exec("tailscale", ["status", "--json"], {});
		if (code !== 0) return undefined;

		const data = JSON.parse(stdout) as { Self?: { TailscaleIPs?: unknown[] } };
		const ips = data.Self?.TailscaleIPs ?? [];
		const first = ips.find((ip) => typeof ip === "string");
		return typeof first === "string" ? first : undefined;
	} catch {
		return undefined;
	}
}

async function buildTraceUrls(pi: ExtensionAPI, traceId: string): Promise<{ primary: string; tailscale?: string }> {
	const primary = buildJaegerTraceUrl(traceId);
	const tailscaleIp = await getTailscaleIp(pi);

	if (!tailscaleIp) {
		return { primary };
	}

	return { primary, tailscale: `http://${tailscaleIp}:16686/trace/${traceId}` };
}

function redactPayload(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => redactPayload(item));
	}

	if (value && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			output[key] = REDACTION_PATTERN.test(key) ? "[redacted]" : redactPayload(entry);
		}
		return output;
	}

	return value;
}

function serializePayload(value: unknown): { text: string; bytes: number; truncated: boolean } {
	const safe = redactPayload(value);
	const text = JSON.stringify(safe) ?? "null";
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= PAYLOAD_MAX_BYTES) {
		return { text, bytes, truncated: false };
	}

	const truncatedText = text.slice(0, PAYLOAD_MAX_BYTES);
	return { text: truncatedText, bytes, truncated: true };
}

function buildPayloadAttributes(prefix: string, value: unknown): Attributes {
	const payload = serializePayload(value);
	return {
		[`${prefix}`]: payload.text,
		[`${prefix}.bytes`]: payload.bytes,
		[`${prefix}.truncated`]: payload.truncated,
	};
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function trimTextByWord(value: string, maxChars: number): { text: string; truncated: boolean } {
	if (value.length <= maxChars) {
		return { text: value, truncated: false };
	}

	const words = value.split(" ");
	let result = "";
	for (const word of words) {
		const next = result ? `${result} ${word}` : word;
		if (next.length > maxChars) break;
		result = next;
	}

	if (!result) {
		return { text: value.slice(0, maxChars), truncated: true };
	}

	return { text: result, truncated: true };
}

function buildInputSummary(text: string): InputSummary {
	const normalized = normalizeText(text);
	const preview = trimTextByWord(normalized, INPUT_PREVIEW_MAX_CHARS);
	const previewBytes = Buffer.byteLength(preview.text, "utf8");

	if (!normalized) {
		return { preview: preview.text, previewBytes, previewTruncated: preview.truncated };
	}

	const sentences = normalized.split(/(?<=[.!?])\s+/).filter(Boolean);
	const firstSentence = trimTextByWord(sentences[0] ?? normalized, INPUT_PREVIEW_MAX_CHARS);
	const lastSentence = trimTextByWord(sentences[sentences.length - 1] ?? normalized, INPUT_LAST_SENTENCE_MAX_CHARS);

	return {
		preview: preview.text,
		previewBytes,
		previewTruncated: preview.truncated,
		firstSentence: firstSentence.text,
		firstSentenceTruncated: firstSentence.truncated,
		lastSentence: lastSentence.text,
		lastSentenceTruncated: lastSentence.truncated,
	};
}

function buildInputSummaryAttributes(prefix: string, summary: InputSummary): Attributes {
	return {
		[`${prefix}.preview`]: summary.preview,
		[`${prefix}.preview.bytes`]: summary.previewBytes,
		[`${prefix}.preview.truncated`]: summary.previewTruncated,
		[`${prefix}.first_sentence`]: summary.firstSentence ?? "",
		[`${prefix}.first_sentence.truncated`]: summary.firstSentenceTruncated ?? false,
		[`${prefix}.last_sentence`]: summary.lastSentence ?? "",
		[`${prefix}.last_sentence.truncated`]: summary.lastSentenceTruncated ?? false,
	};
}

function buildToolSpanName(toolName: string, input: unknown): string {
	if (toolName !== "bash") {
		return `pi.tool: ${toolName}`;
	}

	const command = (input as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") {
		return `pi.tool: ${toolName}`;
	}

	const normalized = normalizeText(command);
	if (!normalized) {
		return `pi.tool: ${toolName}`;
	}

	const trimmed = trimTextByWord(normalized, TOOL_COMMAND_PREVIEW_MAX_CHARS);
	const suffix = trimmed.truncated ? `${trimmed.text}…` : trimmed.text;
	return `pi.tool: ${toolName}(${suffix})`;
}

function updateSpanName(span: Span | undefined, name: string | undefined): void {
	if (!span || !name) return;
	span.updateName(name);
}

function addSpanEvent(span: Span | undefined, type: string, attrs: Attributes): void {
	if (!span) return;
	span.addEvent(type, { "pi.event.type": type, ...attrs });
}

function findLastStopReason(messages: Array<{ role?: string; stopReason?: string }>): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") {
			return message.stopReason;
		}
	}
	return undefined;
}

function ensureAttribute(span: Span, key: string, value: string | number | boolean | undefined): void {
	if (value === undefined) return;
	span.setAttribute(key, value);
}

function setSpanAttributes(span: Span | undefined, attrs: Attributes): void {
	if (!span) return;
	for (const [key, value] of Object.entries(attrs)) {
		span.setAttribute(key, value as string | number | boolean);
	}
}

function createTracer(config: TelemetryConfig): { tracer: Tracer; shutdown: () => Promise<void> } {
	const resource = resourceFromAttributes({
		...config.resourceAttributes,
		[SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
	});

	const exporter = new OTLPTraceExporter({ url: config.endpoint, headers: config.headers });
	const processor = new BatchSpanProcessor(exporter);
	const provider = new BasicTracerProvider({ resource, spanProcessors: [processor] });

	return {
		tracer: provider.getTracer("pi-session-loki", "0.1.0"),
		shutdown: async () => {
			try {
				await provider.forceFlush();
			} catch (e) {
				console.error(`[pi-session-loki] otel flush error: ${(e as Error).message}`);
			}
			await provider.shutdown();
		},
	};
}

export default function (pi: ExtensionAPI) {
	// -- Loki state --------------------------------------------------------
	const shippedToLoki = new Set<string>();
	let activeSessionId: string | undefined;
	let activeSessionFile: string | undefined;

	const shipSessionToLoki = async (
		ctx: ExtensionContext,
		sessionId: string | undefined,
		sessionFile: string | undefined,
	) => {
		if (!sessionId || !sessionFile || shippedToLoki.has(sessionId)) return;
		shippedToLoki.add(sessionId);

		try {
			const content = await readFile(sessionFile, "utf8");
			const lines = content.split("\n").filter(Boolean);
			if (lines.length === 0) return;

			const res = await fetch(lokiEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildLokiPayload(sessionId, extractProject(sessionFile), lines)),
			});

			ctx.ui.setStatus(
				"session-loki",
				res.ok ? ctx.ui.theme.fg("success", "● logs shipped") : ctx.ui.theme.fg("error", `● logs ${res.status}`),
			);
		} catch {
			ctx.ui.setStatus("session-loki", ctx.ui.theme.fg("error", "● logs unreachable"));
		}
	};

	// -- OTel state ----------------------------------------------------------
	const otelConfig = loadOtelConfig();
	let otelRuntime: { tracer: Tracer; shutdown: () => Promise<void> } | undefined;
	let tracer: Tracer | undefined;
	let otelShutdown: (() => Promise<void>) | undefined;

	function ensureOtelRuntime(serviceNameOverride?: string) {
		if (otelRuntime) return otelRuntime;
		const effectiveConfig = serviceNameOverride ? { ...otelConfig, serviceName: serviceNameOverride } : otelConfig;
		otelRuntime = createTracer(effectiveConfig);
		tracer = otelRuntime.tracer;
		otelShutdown = otelRuntime.shutdown;
		return otelRuntime;
	}

	const spans: SpanRegistry = { turns: new Map(), tools: new Map() };
	const traceEnvStack = new TraceEnvStack<Span>();
	const traceScopeKeys = {
		session: "session",
		agent: "agent",
		turn: (turnIndex: number) => `turn:${turnIndex}`,
		tool: (toolCallId: string) => `tool:${toolCallId}`,
	};

	let otelSessionId: string | undefined;
	let activeTurnIndex: number | undefined;
	let lastInputSummary: InputSummary | undefined;
	let otelShutdownTriggered = false;

	function updateTraceStatus(ctx: ExtensionContext, traceId: string | undefined): void {
		if (!ctx.hasUI) return;
		if (!traceId) {
			ctx.ui.setStatus("telemetry-otel", undefined);
			return;
		}
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("telemetry-otel", theme.fg("dim", `trace ${traceId.slice(0, 8)}`));
	}

	function syncActiveSpanContext(): void {
		// No external registry: this pi instance is the only consumer of the
		// active span context, so the traceEnvStack (env var propagation for
		// cross-process sub-agents) is all that needs to stay in sync, and it
		// already updates itself on push/pop.
	}

	function ensureSessionSpan(ctx: ExtensionContext): Span {
		if (spans.session) return spans.session;

		otelSessionId = ctx.sessionManager.getSessionId();
		const entries = ctx.sessionManager.getEntries();

		const parentSpanContext = readParentSpanContextFromEntries(entries) ?? readParentSpanContext();
		const parentContext = parentSpanContext ? trace.setSpanContext(context.active(), parentSpanContext) : context.active();

		const serviceNameOverride = readServiceNameFromEntries(entries);
		ensureOtelRuntime(serviceNameOverride);

		invariant(tracer, "Tracer not initialized");
		const span = tracer.startSpan("pi.session", { startTime: Date.now() }, parentContext);

		ensureAttribute(span, "pi.session.id", otelSessionId);
		ensureAttribute(span, "pi.session.file", ctx.sessionManager.getSessionFile());

		traceEnvStack.push(traceScopeKeys.session, span);
		syncActiveSpanContext();
		updateTraceStatus(ctx, span.spanContext().traceId);
		spans.session = span;
		return span;
	}

	function endSpan(span: Span | undefined, endTime?: number): void {
		if (!span) return;
		span.end(endTime);
	}

	function closeOrphanToolSpans(reason: string): void {
		for (const [toolCallId, span] of spans.tools.entries()) {
			span.setStatus({ code: SpanStatusCode.ERROR, message: `Closed without tool_result (${reason})` });
			span.setAttribute("pi.tool.missing_result", true);
			span.end();
			traceEnvStack.pop(traceScopeKeys.tool(toolCallId));
		}
		spans.tools.clear();
		syncActiveSpanContext();
	}

	function closeOrphanTurnSpans(reason: string): void {
		for (const [turnIndex, span] of spans.turns.entries()) {
			span.setStatus({ code: SpanStatusCode.ERROR, message: `Closed without turn_end (${reason})` });
			span.setAttribute("pi.turn.missing_end", true);
			span.end();
			traceEnvStack.pop(traceScopeKeys.turn(turnIndex));
		}
		spans.turns.clear();
		activeTurnIndex = undefined;
		syncActiveSpanContext();
	}

	function closeOrphanAgentSpan(reason: string): void {
		if (!spans.agent) return;
		spans.agent.setStatus({ code: SpanStatusCode.ERROR, message: `Closed without agent_end (${reason})` });
		spans.agent.setAttribute("pi.agent.missing_end", true);
		spans.agent.end();
		spans.agent = undefined;
		traceEnvStack.pop(traceScopeKeys.agent);
		syncActiveSpanContext();
	}

	function sendTraceMessage(ctx: ExtensionCommandContext, message: string, type: "info" | "error" = "info"): void {
		if (ctx.hasUI) {
			ctx.ui.notify(message, type);
			return;
		}
		pi.sendMessage({ customType: "session-loki-trace-url", content: message, display: true });
	}

	async function openUrl(ctx: ExtensionCommandContext, url: string): Promise<void> {
		const { command, args } = getOpenUrlCommand(url);
		const { code, stderr } = await pi.exec(command, args, {});
		if (code !== 0) {
			sendTraceMessage(ctx, stderr.trim() || `Failed to open URL (exit ${code}).`, "error");
		}
	}

	pi.registerCommand("open-jaeger-trace", {
		description: "Open the current Jaeger trace in your browser",
		handler: async (_args, ctx) => {
			const sessionSpan = ensureSessionSpan(ctx);
			const traceId = sessionSpan.spanContext().traceId;
			if (!traceId || !isValidTraceId(traceId)) {
				sendTraceMessage(ctx, "No valid trace ID found for this session.", "error");
				return;
			}

			const urls = await buildTraceUrls(pi, traceId);
			const messageLines = [`Trace URL: ${urls.primary}`];
			if (urls.tailscale) messageLines.push(`Tailscale URL: ${urls.tailscale}`);
			const message = messageLines.join("\n");

			if (!ctx.hasUI) {
				sendTraceMessage(ctx, message, "info");
				return;
			}

			const confirm = await ctx.ui.confirm("Open Jaeger trace?", `${message}\n\nOpen in your browser?`);
			if (!confirm) {
				sendTraceMessage(ctx, message, "info");
				return;
			}

			await openUrl(ctx, urls.primary);
			sendTraceMessage(ctx, message, "info");
		},
	});

	// -- Combined lifecycle hooks -------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		activeSessionId = ctx.sessionManager.getSessionId();
		activeSessionFile = ctx.sessionManager.getSessionFile();

		otelSessionId = activeSessionId;
		lastInputSummary = undefined;
		ensureSessionSpan(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await shipSessionToLoki(ctx, activeSessionId, activeSessionFile);
		activeSessionId = ctx.sessionManager.getSessionId();
		activeSessionFile = ctx.sessionManager.getSessionFile();

		closeOrphanToolSpans("session_switch");
		closeOrphanTurnSpans("session_switch");
		closeOrphanAgentSpan("session_switch");
		endSpan(spans.session, Date.now());
		spans.session = undefined;
		traceEnvStack.clear();
		updateTraceStatus(ctx, undefined);
		otelSessionId = activeSessionId;
		lastInputSummary = undefined;
		ensureSessionSpan(ctx);
	});

	pi.on("input", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const payloadAttributes = buildPayloadAttributes("pi.input.text", event.text);
		const summary = buildInputSummary(event.text);
		lastInputSummary = summary;
		const summaryAttributes = buildInputSummaryAttributes("pi.input", summary);

		addSpanEvent(sessionSpan, "input", {
			"pi.event.source": event.source,
			"pi.session.id": otelSessionId ?? "",
			"pi.input.images": event.images?.length ?? 0,
			...payloadAttributes,
			...summaryAttributes,
		});

		setSpanAttributes(sessionSpan, buildInputSummaryAttributes("pi.input.latest", summary));
		updateSpanName(sessionSpan, summary.preview ? `pi.session ${summary.preview}` : undefined);
	});

	pi.on("agent_start", (_event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const parent = trace.setSpan(context.active(), sessionSpan);
		invariant(tracer, "Tracer not initialized");
		const span = tracer.startSpan("pi.agent", { startTime: Date.now() }, parent);

		ensureAttribute(span, "pi.session.id", otelSessionId);
		if (lastInputSummary) {
			setSpanAttributes(span, buildInputSummaryAttributes("pi.input.latest", lastInputSummary));
			updateSpanName(span, lastInputSummary.preview ? `pi.agent ${lastInputSummary.preview}` : undefined);
		}

		traceEnvStack.push(traceScopeKeys.agent, span);
		syncActiveSpanContext();
		updateTraceStatus(ctx, span.spanContext().traceId);
		spans.agent = span;
	});

	pi.on("turn_start", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const parent = trace.setSpan(context.active(), spans.agent ?? sessionSpan);
		activeTurnIndex = event.turnIndex;

		invariant(tracer, "Tracer not initialized");
		const span = tracer.startSpan("pi.turn", { startTime: event.timestamp ?? Date.now() }, parent);

		ensureAttribute(span, "pi.session.id", otelSessionId);
		ensureAttribute(span, "pi.turn.index", event.turnIndex);
		if (lastInputSummary) {
			setSpanAttributes(span, buildInputSummaryAttributes("pi.input.latest", lastInputSummary));
		}

		spans.turns.set(event.turnIndex, span);
		traceEnvStack.push(traceScopeKeys.turn(event.turnIndex), span);
		syncActiveSpanContext();
		addSpanEvent(span, "turn_start", { "pi.turn.index": event.turnIndex, "pi.session.id": otelSessionId ?? "" });
	});

	pi.on("tool_call", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const parentSpan = activeTurnIndex !== undefined ? spans.turns.get(activeTurnIndex) : spans.agent;
		const parent = trace.setSpan(context.active(), parentSpan ?? sessionSpan);

		invariant(tracer, "Tracer not initialized");
		const span = tracer.startSpan(buildToolSpanName(event.toolName, event.input), { startTime: Date.now() }, parent);

		ensureAttribute(span, "pi.session.id", otelSessionId);
		ensureAttribute(span, "pi.turn.index", activeTurnIndex);
		ensureAttribute(span, "pi.tool.name", event.toolName);
		ensureAttribute(span, "pi.tool.call_id", event.toolCallId);

		spans.tools.set(event.toolCallId, span);
		traceEnvStack.push(traceScopeKeys.tool(event.toolCallId), span);
		syncActiveSpanContext();

		addSpanEvent(span, "tool_call", {
			"pi.tool.name": event.toolName,
			"pi.tool.call_id": event.toolCallId,
			"pi.session.id": otelSessionId ?? "",
			"pi.turn.index": activeTurnIndex ?? -1,
			...buildPayloadAttributes("pi.tool.input", event.input),
		});
	});

	pi.on("tool_result", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const span = spans.tools.get(event.toolCallId);
		const outputPayload = { content: event.content, details: event.details };

		addSpanEvent(span ?? sessionSpan, "tool_result", {
			"pi.tool.name": event.toolName,
			"pi.tool.call_id": event.toolCallId,
			"pi.tool.is_error": event.isError,
			"pi.session.id": otelSessionId ?? "",
			"pi.turn.index": activeTurnIndex ?? -1,
			...buildPayloadAttributes("pi.tool.output", outputPayload),
		});

		if (span) {
			if (event.isError) {
				span.setStatus({ code: SpanStatusCode.ERROR, message: "tool_result error" });
			}
			span.end();
			spans.tools.delete(event.toolCallId);
		}

		traceEnvStack.pop(traceScopeKeys.tool(event.toolCallId));
		syncActiveSpanContext();
	});

	pi.on("turn_end", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const span = spans.turns.get(event.turnIndex);
		const turnStopReason = "stopReason" in event.message ? event.message.stopReason : undefined;

		addSpanEvent(span ?? sessionSpan, "turn_end", {
			"pi.turn.index": event.turnIndex,
			"pi.session.id": otelSessionId ?? "",
			"pi.turn.tool_results": event.toolResults.length,
			"pi.message.stop_reason": turnStopReason ?? "",
		});

		endSpan(span, Date.now());
		spans.turns.delete(event.turnIndex);
		traceEnvStack.pop(traceScopeKeys.turn(event.turnIndex));
		syncActiveSpanContext();
		if (activeTurnIndex === event.turnIndex) {
			activeTurnIndex = undefined;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const stopReason = findLastStopReason(event.messages);

		addSpanEvent(spans.agent ?? sessionSpan, "agent_end", {
			"pi.session.id": otelSessionId ?? "",
			"pi.message.stop_reason": stopReason ?? "",
		});

		closeOrphanToolSpans("agent_end");
		closeOrphanTurnSpans("agent_end");
		endSpan(spans.agent, Date.now());
		spans.agent = undefined;
		traceEnvStack.pop(traceScopeKeys.agent);
		syncActiveSpanContext();

		if (!ctx.hasUI && !otelShutdownTriggered) {
			otelShutdownTriggered = true;
			endSpan(spans.session, Date.now());
			spans.session = undefined;
			traceEnvStack.clear();
			await otelShutdown?.();
		}
	});

	pi.on("model_select", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		addSpanEvent(sessionSpan, "model_select", {
			"pi.session.id": otelSessionId ?? "",
			"pi.model.provider": event.model.provider,
			"pi.model.id": event.model.id,
			"pi.model.source": event.source,
		});
	});

	pi.on("session_compact", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		addSpanEvent(sessionSpan, "session_compact", {
			"pi.session.id": otelSessionId ?? "",
			"pi.compaction.first_kept_entry": event.compactionEntry?.firstKeptEntryId ?? "",
			"pi.compaction.tokens_before": event.compactionEntry?.tokensBefore ?? 0,
			...buildPayloadAttributes("pi.compaction.summary", event.compactionEntry?.summary),
		});
	});

	pi.on("session_tree", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		addSpanEvent(sessionSpan, "session_tree", {
			"pi.session.id": otelSessionId ?? "",
			"pi.tree.new_leaf": event.newLeafId ?? "",
			"pi.tree.old_leaf": event.oldLeafId ?? "",
			"pi.tree.from_extension": event.fromExtension ?? false,
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await shipSessionToLoki(ctx, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());

		if (otelShutdownTriggered) return;
		otelShutdownTriggered = true;

		ensureSessionSpan(ctx);
		closeOrphanToolSpans("session_shutdown");
		closeOrphanTurnSpans("session_shutdown");
		closeOrphanAgentSpan("session_shutdown");

		endSpan(spans.session, Date.now());
		spans.session = undefined;
		traceEnvStack.clear();
		updateTraceStatus(ctx, undefined);

		await otelShutdown?.();
	});
}
