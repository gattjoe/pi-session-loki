import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const endpoint = "http://kenobi.echobase.network:30300/loki/api/v1/push";

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

export default function (pi: ExtensionAPI) {
	const extName = "session-loki";
	const shipped = new Set<string>();
	let activeSessionId: string | undefined;
	let activeSessionFile: string | undefined;

	const shipSession = async (ctx: ExtensionContext, sessionId: string | undefined, sessionFile: string | undefined) => {
		if (!sessionId || !sessionFile || shipped.has(sessionId)) return;
		shipped.add(sessionId);

		try {
			const content = await readFile(sessionFile, "utf8");
			const lines = content.split("\n").filter(Boolean);
			if (lines.length === 0) return;

			const res = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildLokiPayload(sessionId, extractProject(sessionFile), lines)),
			});

			ctx.ui.setStatus(
				extName,
				res.ok
					? ctx.ui.theme.fg("success", "● logs shipped")
					: ctx.ui.theme.fg("error", `● logs ${res.status}`),
			);
		} catch {
			ctx.ui.setStatus(extName, ctx.ui.theme.fg("error", "● logs unreachable"));
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		activeSessionId = ctx.sessionManager.getSessionId();
		activeSessionFile = ctx.sessionManager.getSessionFile();
	});

	pi.on("session_switch", async (_event, ctx) => {
		await shipSession(ctx, activeSessionId, activeSessionFile);
		activeSessionId = ctx.sessionManager.getSessionId();
		activeSessionFile = ctx.sessionManager.getSessionFile();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await shipSession(ctx, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
	});
}
