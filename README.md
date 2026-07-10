# Pi Session Loki

**Ships pi coding agent session transcripts to Loki when a session ends.**

## Why Pi Session Loki

**Complements `pi-telemetry-otel`, doesn't replace it.** The OTel extension sends redacted, truncated span previews to Tempo for dashboards (latency, errors, tool timing). This extension sends the *complete, unredacted* session `.jsonl` to Loki — the same content pi uses for `--continue`/`--resume`/`--fork` — so it's searchable and retained centrally instead of living only on disk.

## Install

```bash
pi install git:github.com/gattjoe/pi-session-loki
```

## What it does

On `session_switch` and `session_shutdown`, reads the full session file and POSTs its lines as one Loki stream (labels: `job=pi-session`, `project`, `session_id`). Each session is shipped exactly once, in full, after it ends — this does not stream partial content from a session that's still running.

| Status | Meaning |
|--------|---------|
| `● logs shipped` | Loki accepted the push |
| `● logs <code>` | Loki reachable but returned an error status |
| `● logs unreachable` | Request failed (network error, timeout, DNS, etc.) |

## Configuration

The endpoint (`http://kenobi.echobase.network:30300/loki/api/v1/push`) is a constant in `index.ts`. Edit it directly if you point at a different Loki.

No redaction is applied — the raw session content (including tool output and file contents) goes to Loki as-is.
