import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

async function withSessionFile(lines, run) {
	const dir = await mkdtemp(join(tmpdir(), "--Users-joegatt-code-demo--"));
	const file = join(dir, "session.jsonl");
	await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	try {
		return await run(file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// Drives the extension against a fake pi/ctx and a stubbed fetch, exercising
// the session_start -> session_switch -> session_shutdown ship sequence.
function run(sessionFile, fetchImpl) {
	const script = `
		globalThis.fetch = ${fetchImpl};

		const handlers = {};
		const pi = { on: (event, handler) => { handlers[event] = handler; } };

		const statuses = [];
		const requests = [];
		globalThis.__capture = (url, body) => requests.push({ url, body });

		const ctx = {
			ui: {
				setStatus: (key, text) => statuses.push([key, text]),
				theme: { fg: (color, text) => \`\${color}:\${text}\` },
			},
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => ${JSON.stringify(sessionFile)},
			},
		};

		const extension = (await import(${JSON.stringify(indexUrl)})).default;
		extension(pi);

		await handlers.session_start({ type: "session_start" }, ctx);
		await handlers.session_shutdown({ type: "session_shutdown" }, ctx);

		console.log(JSON.stringify({ statuses, requests }));
	`;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("ships session lines to Loki on shutdown", async () => {
	await withSessionFile(
		[
			{ type: "session", id: "session-1", timestamp: "2026-07-10T00:00:00.000Z" },
			{ type: "message", id: "m1", timestamp: "2026-07-10T00:00:01.000Z" },
		],
		async (file) => {
			const { statuses, requests } = run(
				file,
				`async (url, opts) => {
					globalThis.__capture(url, JSON.parse(opts.body));
					return new Response(null, { status: 204 });
				}`,
			);

			assert.equal(requests.length, 1);
			assert.equal(requests[0].url, "http://kenobi.echobase.network:30300/loki/api/v1/push");
			const stream = requests[0].body.streams[0];
			assert.equal(stream.stream.job, "pi-session");
			assert.equal(stream.stream.session_id, "session-1");
			assert.equal(stream.values.length, 2);
			assert.equal(statuses.at(-1)[1], "success:● logs shipped");
		},
	);
});

test("does not ship the same session twice", async () => {
	await withSessionFile([{ type: "session", id: "session-1", timestamp: "2026-07-10T00:00:00.000Z" }], async (file) => {
		const script = `
			let calls = 0;
			globalThis.fetch = async () => { calls++; return new Response(null, { status: 204 }); };

			const handlers = {};
			const pi = { on: (event, handler) => { handlers[event] = handler; } };
			const ctx = {
				ui: { setStatus: () => {}, theme: { fg: (_c, t) => t } },
				sessionManager: {
					getSessionId: () => "session-1",
					getSessionFile: () => ${JSON.stringify(file)},
				},
			};

			const extension = (await import(${JSON.stringify(indexUrl)})).default;
			extension(pi);

			await handlers.session_start({ type: "session_start" }, ctx);
			await handlers.session_switch({ type: "session_switch" }, ctx);
			await handlers.session_shutdown({ type: "session_shutdown" }, ctx);

			console.log(JSON.stringify({ calls }));
		`;
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: script,
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
		});
		assert.equal(child.status, 0, child.stderr);
		assert.equal(JSON.parse(child.stdout.trim()).calls, 1);
	});
});
