---
summary: "Claude provider notes: transcript metadata, turn boundaries, OAuth/Web/CLI quota sources, identity and transport."
ids: [claude]
read_when:
  - Changing Claude session roots, titles, turn state or live context parsing
  - Changing Claude OAuth, Web session or CLI limits collection
  - Changing Claude account identity, prepaid credits or cookie renewal
---

# Claude

Claude has independent local-usage/session and account-limits planes. A Claude Code transcript is not proof of which Claude account owns a limits row, and a Web or OAuth credential is not a token-history source.

## Usage and session metadata

Aggregate tokens and costs come from tokscale. The local adapter in `src/shared/providers/claude/sessionMetadata.js` enriches sessions from `CLAUDE_CONFIG_DIR` or `~/.claude`, checking `projects/` before `transcripts/`.

It reads only persisted `custom-title` and `ai-title` records; it never turns prompt text into a title. Custom titles win. The index is keyed by file size and mtime, scans appended bytes after the first pass and keeps reads bounded around oversized JSONL records.

Turn state comes from the newest assistant `stop_reason` plus any genuine user prompt written after it. `tool_use` is not an ended turn. `tool_result`, meta and compaction records are not new user prompts. The adapter emits `true`, `false` or no value deliberately: `false` must clear an older finished state, while no value means there is no evidence.

### Live context occupancy

Claude emits `contextTokens`/`contextWindow` from its transcript for sessions that pass `shouldReadSessionContext()`. Use the last serving `message` or `fallback_message` iteration when present, not the request's cumulative usage rollup. Occupancy is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; `output_tokens` is not part of the current input context. `input_tokens` is required, while missing cache counters mean zero. A malformed present counter, zeroed assistant notice or incomplete usage record must not erase the last valid reading.

An explicit `[1m]` model marker, supported native Claude 1M model ids and recognized provider Sonnet 5 ids map to 1M. Other nonempty model ids map to Claude Code's 200K default, including third-party bridges as a best-effort estimate; do not present that fallback as an authoritative bridge window. A compact boundary or compact summary clears the pair to `0/0` until the next valid assistant response. Oversized JSONL records use bounded head/tail fragments; accept context only from a complete message-level `usage` object and do not mistake nested `model` or `usage` fields in tool content for the response.

## Limits source order

`fetchClaudeLimits()` uses these mutually exclusive paths:

1. an explicitly configured Claude Web `sessionKey`;
2. Claude Code OAuth credentials discovered from env/file, Windows Credential Manager or macOS Keychain;
3. the authenticated Claude CLI usage screen as a fallback only for not-configured, rate-limited, unavailable or generic OAuth failures.

An identity-resolution failure after successful OAuth quota is not allowed to fall through and mint a differently keyed CLI row. The limits runtime retains the previous stable account instead.

OAuth usage refreshes reactively after unauthorized responses. Non-macOS platforms may also refresh shortly before expiry; macOS avoids proactive delegated refresh because it spawns Claude Code. Windows credential-file discovery includes running WSL homes when no explicit config root overrides it.

## Usage-limit reset grants

Both usage responses carry Anthropic's reset coupons in a `cedar_ember` block only when the request asks for it, so every OAuth and Web usage call sends `cedar_ember=1` — the same request, not an extra fetch. Grants that still hold resets and have not reached `ends_at` map onto `provider.resetCredits` with per-grant detail (label, cleared windows, usability flags); spent and lapsed grants are dropped so the count never promises a reset the account cannot use.

The OAuth endpoint also gates the block on client surface: a user-agent that is not Claude Code gets `eligible: false` with `ineligible_reason: "surface"` and no grants, so the OAuth usage call presents as `claude-cli/<version> (external, cli)` — the credential is a Claude Code token. Web usage calls are unaffected because they already present as the browser.

`seven_day_overage_included` in a grant's `clears` reads like a modifier on the weekly clear, but Claude Code's own label map calls it "Fable limit" — the credits-backed model's weekly bucket. Most accounts never see that bucket, so it folds into the general Weekly entry when `seven_day` is also cleared and lists as `Fable weekly` only when it is the sole weekly coverage. The display is read-only: the claim endpoint is deliberately not wired, so nothing in the app can spend a grant. A second reset program (`juniper_tide`) exists but is not collected.

## Claude Web

The stored value must be one bare `sk-ant-…` session key or canonical `sessionKey=…`; arbitrary Cookie headers are rejected. Web collection has priority when configured and uses Electron's dedicated native request adapter. That adapter preserves raw `Set-Cookie` headers and aborts the underlying request, which ordinary fetch handling cannot guarantee here.

The Web provider enumerates distinct chat organizations and reads each subscription separately. Explicit Pro, Max, Team and Enterprise plans keep a row even when quota is empty. An explicit Free subscription is omitted; an unknown plan is probed and kept if it has quota or a balance. Missing capabilities retain a compatibility probe, but organizations that explicitly lack chat are excluded. An empty plan label is not evidence of Free. Membership metadata is matched by organization UUID; an account-wide subscription type is used only for a single organization, never copied onto multiple teams.

Web and OAuth identity hash the account UUID together with the organization UUID. Email plus organization is the fallback when the account UUID is absent; neither organization names nor cookies define identity. This separates personal and team quotas, including different members of one team, while merging the same member/organization across devices. Older clients emitted an account-only key: a successful full inventory replaces this device's old rows, but older remote devices may temporarily contribute a duplicate until upgraded and refreshed. Saved subscription bindings follow a uniquely matching organization name; ambiguous bindings require re-linking.

Discovery is cached for one hour as an organization collection. Usage and prepaid reads run serially and honor cancellation. Scoped refreshes return only the requested organization. A failed workspace request produces its own unavailable row without losing its siblings; a 401 or account/session authentication failure invalidates the session. A Cloudflare challenge is unavailable, not unauthorized. A successful complete inventory retires disappeared organizations; a failed discovery never means an empty inventory.

Session-key rotation is observed across every response and persisted with compare-and-swap semantics; later requests in the same probe use the renewed key even if persistence loses a race. The entire organization cache follows rotation without extending its discovery age. A cold cache requires the account endpoint. A transient account failure may reuse only identities for the exact same organizations; it cannot lend an old identity to a newly discovered team. Web failures do not fall through to another local OAuth/CLI account.


Prepaid balance is best effort and cached more slowly than usage. A failed or refused prepaid endpoint must not erase the quota row. Transient failures retain the last balance; durable refusal is backed off. An unfunded zero pool is hidden when usage credits are disabled, while a funded or exhausted relevant pool remains visible. The provider emits its credits window explicitly without inventing a percentage meter.

## Verification

Run the Claude session, limits and Electron transport tests when changing this note's scope:

```bash
node --test tests/shared/claudeSessionMetadata.test.js tests/shared/limitCollector.claude.test.js tests/electron/claudeWebFetch.test.js
```
