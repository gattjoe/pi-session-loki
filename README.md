# Pi Session Loki

**Ships pi coding agent sessions to both Loki (full transcript) and Tempo (live OTel traces) from one extension.**

## Why Pi Session Loki

This absorbs everything `pi-telemetry-otel` used to do, so that's no longer a dependency: it mirrors the session as an OTel span tree (`pi.session` → `pi.agent` → `pi.turn` → `pi.tool: <name>`) to Tempo in real time, redacted and truncated for dashboards. It *also* ships the complete, unredacted session `.jsonl` to Loki once the session ends — the same content pi uses for `--continue`/`--resume`/`--fork` — so full content is searchable and retained centrally instead of living only on disk.

Same split as before, one less extension to install: Tempo/traces for live "what's happening / how fast," Loki/logs for "what actually was said," including token usage/cost that never made it into spans.

## Install

```bash
pi install git:github.com/gattjoe/pi-session-loki
```

## What it does

**Loki**: on `session_start` (reason `new`/`resume`/`fork`) and `session_shutdown`, reads the full session file and POSTs its lines as one stream (labels: `job=pi-session`, `project`, `session_id`). Each session is shipped exactly once, in full, after it ends — this does not stream partial content from a session that's still running.

| Status | Meaning |
|--------|---------|
| `● logs shipped` | Loki accepted the push |
| `● logs <code>` | Loki reachable but returned an error status |
| `● logs unreachable` | Request failed (network error, timeout, DNS, etc.) |

**Tempo**: spans start and end live as the session runs (session/agent/turn/tool hierarchy), exported via OTLP/HTTP. Also registers `/open-jaeger-trace` to open the current session's trace in a browser.

## Configuration

- Loki endpoint (`http://kenobi.echobase.network:30300/loki/api/v1/push`) is a constant in `index.ts`.
- OTel endpoint defaults to `https://otel.echobase.network/v1/traces` (the same collector `pi-otel-status` pings), overridable via `PI_OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` (and `_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`) — same env vars `pi-telemetry-otel` used.

No redaction is applied to the Loki path — the raw session content (including tool output and file contents) goes to Loki as-is. The Tempo path keeps the original redaction (`api_key|token|secret|password` key match) and 8KB payload cap.
