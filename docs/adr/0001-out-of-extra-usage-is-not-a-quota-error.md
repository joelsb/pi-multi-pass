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
