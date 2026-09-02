# 0001. "You're out of extra usage" is not a quota error

Date: 2026-09-02
Status: Accepted

## Decision

`out of (extra )?usage` triggers local account rotation but is **never written to
the shared exhaustion ledger**. Only unambiguous capacity errors -
`usage limit`, `rate limit`, `limit reached`, `too many requests`, `quota`, `429` -
are published for other processes to act on.

## What forced it

Anthropic's OAuth endpoint answers a request it refuses with

```
400 invalid_request_error
"You're out of extra usage. Ask your workspace admin to add more so you can keep going."
```

and that refusal has nothing to do with billing. Measured on 2026-09-02, same
account, same model, same minute:

```
pi -p                 --model anthropic/claude-opus-5   ->  OK
pi --no-extensions -p --model anthropic/claude-opus-5   ->  400 "out of extra usage"
```

The difference is one extension, `~/.pi/agent/extensions/anthropic-oauth-prompt-fix.ts`,
which rewords two lines of pi's own system prompt. Its header records the
bisection: a bare request returns 200, 20,000 tokens of filler passes, an
830-token prefix of pi's system prompt fails, and the same failing text reversed
character-by-character passes. The endpoint content-classifies the prompt,
refuses what it does not read as Claude Code, and reports that as a billing
error.

Ruled out as causes, each measured the same day: model tier (opus, sonnet and
haiku behave identically under a given path), credential type (both accounts are
`type: "oauth"` with valid refresh tokens), and concurrency (three parallel
requests all returned OK).

## Authoritative explanation, added 2026-09-02 after reading the API docs

The first version of this ADR said the 400 is "not a quota decision". That was
wrong in an important way. Anthropic's error reference
(https://platform.claude.com/docs/en/api/errors) says:

> **400 invalid_request_error** - "The API also returns a 400 when usage reaches
> an organization or workspace spend limit you set, except limits on the Claude
> Code workspace, which can return a 429 instead."

> **429 rate_limit_error** - "Your organization has hit a rate limit, reached its
> usage tier's monthly spend cap, or reached a spend limit on the Claude Code
> workspace. A tier spend-cap 429 has no retry-after header and keeps failing
> until access resumes."

So both are spend limits, on **different workspaces**, and which one a request is
charged to depends on whether Anthropic recognises it as Claude Code traffic:

| Observed | Limit that fired | What it means |
|---|---|---|
| `400` "out of extra usage. Ask your workspace admin to add more" | some other workspace or the org | the request was NOT attributed to Claude Code, so it billed against a budget that is empty |
| `429 rate_limit_error` | the Claude Code workspace, or the tier's monthly cap | the actual subscription allowance |

This explains every observation at once, including the two that looked
contradictory:

- The prompt reword fixes the 400 because it restores Claude Code attribution.
  The budget was never the variable; the *workspace* was.
- The message names a workspace admin rather than credits, because it is
  literally a workspace spend limit.
- Joel's subscription allowance genuinely was exhausted and renewed at 22:00
  local on 2026-09-02 - and that exhaustion is the 83 `429 rate_limit_error`
  entries in this machine's history, never the 400s.
- Two minutes after that renewal, bare requests still returned 400 on both
  accounts while prompt-fixed requests returned OK. A renewed allowance does not
  help a request charged to the wrong workspace.

**Consequence for rotation, unchanged but now for the right reason.** Rotating
accounts cannot fix a 400: if the request is misattributed on one account it is
misattributed on all of them, which is exactly what the four-way probe showed.
Retrying in place cannot fix it either, but it costs one request and protects
the far more common transient case. Publishing it to the shared ledger is the
only genuinely harmful response, and that is what this ADR forbids.

**A refinement this surfaces, not yet implemented.** The docs say a tier
spend-cap 429 carries **no retry-after header and keeps failing until access
resumes**, whereas an ordinary rate-limit 429 does carry one. Multi-pass treats
all 429s alike with a 5 minute cooldown. A spend-cap 429 deserves a much longer
one, and the presence of `retry-after` is how to tell them apart.

## The three conditions, measured

Every anthropic error in this machine's 479 session files, grouped by status and
type on 2026-09-02. `sub` counts sub-agent sessions, `top` counts top-level ones:

| status | error type | n | sub | top | message |
|---|---|---|---:|---:|---|
| 400 | `invalid_request_error` | 146 | 90 | 56 | You're out of extra usage. Ask your workspace admin... |
| 429 | `rate_limit_error` | 83 | **0** | 83 | This request would exceed your account's rate limit. |
| - | `overloaded_error` | 15 | 0 | 15 | Overloaded |

They are three different conditions and only the middle one means "you are at
your limit":

- **429 `rate_limit_error`** - the real thing. Rotate and publish.
- **`overloaded_error`** - transient capacity at the provider. Rotate, never publish.
- **400 `invalid_request_error`** - the prompt refusal described above. Rotate, never publish.

The zero is the decisive cell. Not one of the 83 genuine rate limits came from a
sub-agent, while 90 of the 146 refusals did - on the same accounts, in the same
days. Sub-agents launch with `--no-extensions` and so lack the prompt fix, which
is the only difference between the two populations. An account that was really
empty would have refused the parents too.

## Consequences

- A prompt refusal no longer marks a funded account dead for every process on the
  machine. That is what happened on 2026-09-02: two planners, launched with
  `--no-extensions` and therefore without the prompt fix, took the fake billing
  error, rotated to codex, ran 14 minutes, hit codex's real usage cap and died -
  with both anthropic accounts funded and idle. Cost: $12.66 and the work.
- Rotation still happens locally, because the next account may not trip whatever
  refused this one. It costs one request to find out and it is not persisted.
- The two lists are deliberately not one list. `RATE_LIMIT_PATTERNS` answers
  "should this turn move somewhere else"; `LEDGER_WORTHY_PATTERNS` answers "should
  every other process believe this account is finished". The second is a strictly
  stronger claim.

## Rejected alternatives

- **Drop the pattern entirely.** A workspace genuinely out of extra usage sends
  the same words, and then failover should rotate. Removing it would strand that
  case.
- **Publish everything and rely on the 5 minute cooldown.** Five minutes of every
  sub-agent avoiding a healthy account is exactly the failure being fixed.
- **Detect the real cause from the error.** The message is identical in both
  cases; the provider gives us nothing to distinguish them.

## What would make us revisit

Anthropic returning a distinguishable error for prompt refusal versus real
exhaustion, or pi's default system prompt no longer tripping the classifier, at
which point `anthropic-oauth-prompt-fix.ts` can be deleted and the ambiguity with
it.

## Evidence

- `~/.pi/agent/extensions/anthropic-oauth-prompt-fix.ts` header, bisection dated 2026-09-01.
- The back-to-back probe above, 2026-09-02.
- `tests/exhaustion-ledger-check.mjs`, which fails if an ambiguous refusal is published.
- Child sessions `ce2d4d26` and `bf6d7c19` in
  `~/.pi/agent/sessions/--Users-joelsbastos-.treehouse-dicdrepo-b65ff0-5-dicdrepo--`:
  anthropic 400, anthropic-2 400, codex for 14 minutes, then codex's cap.
