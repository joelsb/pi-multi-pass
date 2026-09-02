# Findings: why sub-agents kept dying, 2026-09-02

A single afternoon, eight defects, one symptom. The symptom was always the same - a sub-agent
that stopped working and reported a provider error - and it had **eight independent causes**,
each of which was sufficient on its own. That is why it kept looking fixed and then wasn't.

This document is the timeline and the evidence. The decisions live in
`docs/HANDOFF-2026-09-02-continue-here.md`; the one authoritative provider fact lives in
`docs/adr/0001-out-of-extra-usage-is-not-a-quota-error.md`.

---

## The reported symptom

Two `planner` sub-agents, deployed together, both died after ~14 minutes:

```
✗ planner-page-intros (planner) (gpt-5.6-sol) — failed (provider/agent error) · 13m 56s
  ↑169k ↓41k R1901k $3.039
✗ planner-demo-dicd   (planner) (gpt-5.6-sol) — failed (provider/agent error) · 13m 33s
  ↑677k ↓34k R4439k $9.621
Error: Codex error: The usage limit has been reached
Warning: [pool:codex] Failover exhausted after openai-codex; no eligible target remained in this cascade.
```

$12.66 and 27 minutes of planning discarded, with two funded Anthropic accounts idle. The
user's instinct - *"that shouldn't happen, it should switch automatically"* - was right, and
tracking down why took the rest of the session.

---

## Timeline

### 1. The handoff had the wrong headline

The session opened from `docs/HANDOFF-tier-preserving-failover.md`, which described a real bug
(a chain hop discarding the running model) and dismissed the primary complaint in one line:
*"it did not roll to the codex entry... I have not investigated it."*

That aside was the actual bug. **Lesson: order the work by what the user observed, not by what
you found first.** A precisely-located finding is not the same as the user's problem.

### 2. Failover was never firing (defect 1)

`PoolManager.handleError` exits on its second line unless `isRateLimitError` is true. Anthropic
reports subscription exhaustion as `400 invalid_request_error` with *"You're out of extra
usage"* - no `limit`, no `quota`, no `429`. It matched **none** of the eight patterns, so
`buildFailoverPlan` was never called. The pool and chain were never consulted at all.

Verified by evaluating the eight regexes against the verbatim provider string. Fixed in
`9f63d59`.

### 3. Rotation did not re-run the turn (defect 2)

With the classifier fixed, the cascade rotated correctly - and needed **three separate prompts**
from a human to walk `anthropic → anthropic-2 → openai-codex`. Multi-pass called `pi.setModel`
and stopped, trusting a code comment that said pi retries the turn.

A human presses Enter again and barely notices. **A sub-agent has nobody to press Enter**: it
parks on a healthy account with its task unexecuted, prints no completion sentinel, and its
parent polls it to timeout. Fixed in `757bf3a`.

### 4. Children never had the engine at all

`--no-extensions` re-enables only the extensions backing a child's whitelisted **tools**, and
multi-pass backs no tool. So a sub-agent held one account, no pool, no chain.

The loss was larger than the failover engine, because multi-pass *registers the extra accounts*:

```
$ pi --no-extensions -p --model anthropic-2/claude-opus-5 "say hi"
Error: Model "anthropic-2/claude-opus-5" not found.
```

Without it, `anthropic-2` does not merely fail - it does not exist. That fact killed the
alternative design where the parent picks a live account and passes it as `--model`: it could
only ever name base providers. Fixed in `d6b89f3`.

### 5. Auto-exit killed children mid-recovery

The first real end-to-end run still failed. The child had rotated **twice** and reached a live
account:

```
:29.458 error 400   anthropic
:29.461 model_change -> anthropic-2      (rotated)
:29.465 prompt replayed
:30.138 error 400   anthropic-2
:30.139 model_change -> openai-codex     (a live account)
:30.140 prompt replayed
        process gone before codex answered
```

`subagent-done.ts` shuts down on any `agent_end` with `stopReason: "error"`, and that fires
*before* either recovery mechanism runs. The parent reported `failed · 1s` while the child was
two hops into a recovery that would have worked.

**The first fix for this also failed**, and the reason is the most reusable thing in this
document. It cancelled the pending exit on `before_agent_start` - which pi emits **only for a
turn the user started**. Logging all twelve events through a live rotation:

```
agent_end stopReason=error
input
agent_start          <- the replayed turn starts here
turn_start
before_provider_request
```

No `before_agent_start`. The timer fired mid-recovery and killed the child three seconds before
it finished. Fixed in `7a6d554`, cancelling on `input` and `agent_start`.

### 6. Tier preservation (defect 3)

With failover working end to end, the original handoff's bug became reachable. A chain hop used
`entry.model` verbatim, so `implementer` and `tester` on `claude-sonnet-5` were being silently
promoted to a flagship model whenever the anthropic pool dried up.

One correction to the plan, found while building: the table must key on the pool's
**`baseProvider`**, not the account. By the time a cascade reaches a chain hop it has usually
rotated within the pool, so `currentModel.provider` is `anthropic-2`, which no table lists.
Keying by account silently disabled every mapping. Fixed in `a9d41b1`.

Live evidence:

```
claude-sonnet-5 session -> active openai-codex (gpt-5.5) [tier: mid]
claude-opus-5   session -> active openai-codex (gpt-5.6-sol) [tier: flagship]
```

### 7. The shared ledger, and the harm it caused (defects 4 and 5)

Cooldown lived in a `Map` inside each `PoolManager`, so every process learned which accounts
were dead the only way it could - by spending a request. A parent plus five sub-agents against
two dead accounts is a dozen wasted calls per wave.

`markExhausted` now publishes to `~/.pi/agent/multi-pass-exhausted.json` (`e8b7ec6`). It paid
off immediately: a second planner skipped `anthropic-2` without trying it, reading a cooldown
its sibling had written 55 seconds earlier.

**Then the user spotted the harm, unprompted:** *"does the agent reply back to the main agent
that it should change the pool? because it's working but then it changes to another pool which
it shouldn't."*

Exactly right. There is no message - but the ledger re-routes the parent anyway.
`isMemberExhausted → exhaustedAt → readExhaustedLedger()` is called from `buildFailoverPlan` on
**every failover decision, live**. So one sub-agent's refusal moved a long-lived parent session
off a working account. `008dfd9` stopped ambiguous refusals reaching the file at all.

### 8. The chain was a dead end, not a ring (defect 6)

The user's next hypothesis - *"the pool is only for a provider, not the chain, which involves
all providers"* - located a second real bug in one sentence.

```ts
for (let chainIndex = applicable.index + 1; chainIndex < entries.length; chainIndex++)
```

Chain `all` is `[0] anthropic, [1] codex`. On codex, `applicable.index = 1`, the loop starts at
2, and **runs zero times**. Not "no eligible member" - no candidate was ever considered. The
anthropic pool was unreachable from codex however much credit it had. That is precisely how the
two planners died: they failed over *to* codex correctly, worked 14 minutes, hit codex's cap,
and never looked at the other provider.

Fixed in `6d42c13` as modulo traversal over `entries.length - 1` steps. Confirmed by warnings
that were previously impossible: `[pool:anthropic] anthropic skipped (cooldown active)` in a
session that started on codex.

### 9. The auth extension children never got

Probing accounts to see whether they were really out of credit produced this:

```
pi -p                 --model anthropic/claude-opus-5   ->  OK
pi --no-extensions -p --model anthropic/claude-opus-5   ->  400 "You're out of extra usage"
```

Same account, same model, same minute. The difference is one extension,
`~/.pi/agent/extensions/anthropic-oauth-prompt-fix.ts`, which rewords two lines of pi's own
system prompt. Its header records the original bisection: a bare request returns 200, 20,000
tokens of filler passes, an 830-token prefix of pi's system prompt fails, and the same failing
text reversed character-by-character passes.

**Every sub-agent launched `--no-extensions` and therefore lost that fix**, which is why 90 of
the 146 refusals in the entire session history came from sub-agents. They took a fake
billing error on Anthropic, failover dutifully moved the work to another provider, and it
landed there until that provider capped. Fixed in `75276c2`
(`getProviderAuthExtensionPaths`).

This also invalidated an earlier conclusion of mine - *"verified: both accounts are out of
credit"* - which had been measured with `--no-extensions` in every probe. Clean, plausible,
wrong.

### 10. The statusless error (defect 7)

A `worker` sub-agent then made four tool calls on `openai-codex/gpt-5.5`, hit the cap, rotated
correctly to `anthropic/claude-opus-5`, and its session file simply ends. Not one request on
the new account.

pi's retry has **two** gates, and only the second is widely known:

```js
isProviderError(e) = e instanceof Error && "status" in e && "headers" in e
isRetryableProviderError(e) = 408 | 409 | 429 | >=500 | x-should-retry
if (!isProviderError(e) || !isRetryableProviderError(e)) throw e;
```

An error with no status is **not even a retry candidate**. Codex reports its cap as the bare
string `Codex error: The usage limit has been reached`. `piWillRetryTurn` returned `true` for
it - "assume pi handles it" - and pi had already thrown it.

I had quoted the 408/409/429/5xx rule earlier in the same session and never read the guard in
front of it. Worse, I had written the exact prediction of this failure in a note three messages
before it happened, and did not act on it.

Inverting the default alone broke a pre-existing regression test, correctly: `overloaded_error`
also arrives without a status prefix and pi *does* retry it. So the status is now inferred from
`error.type`, because across the whole session history every `overloaded_error` and `api_error`
lacked a prefix while every `rate_limit_error` carried its 429. **The error type is the reliable
signal; the prefix is pi's formatting choice.** Fixed in `ebb3f1a`.

### 11. The user's decisive experiment (defect 8)

```
400 "You're out of extra usage"        anthropic-2
cascade exhausted; no eligible target
#10 continue                            <- one word
review-intros-task3-code — resumed      <- works immediately
status bar: (anthropic-2) claude-opus-5  <- same account
```

Nothing changed except that the request was sent again. This is the cheapest possible
discriminator between a **capacity fact** and a **per-request refusal**, and no provider error
message will ever tell you which you have.

So: rotating on a single refusal was evicting accounts that were never dead, publishing those
evictions fleet-wide, and stampeding every process onto the last provider until it capped for
real. `7bbc683` retries the same account first; `c9c7068` makes it 3 attempts by default.

### 12. What the docs settled

Reading `https://platform.claude.com/docs/en/api/errors` resolved the last contradiction in two
lines:

> **400 invalid_request_error** - also returned "when usage reaches an organization or workspace
> spend limit you set, except limits on the Claude Code workspace, which can return a 429 instead."

> **429 rate_limit_error** - "reached its usage tier's monthly spend cap, or reached a spend
> limit on the Claude Code workspace."

Both are spend limits, on **different workspaces**, and which one a request is charged to
depends on whether Anthropic reads it as Claude Code traffic. That reconciles two facts that
had looked contradictory all session:

- The user's subscription allowance genuinely *was* exhausted and renewed at 22:00 local - and
  that exhaustion is the **83 `429 rate_limit_error`** entries in the history, never the 400s.
- Two minutes *after* that renewal, bare requests still returned 400 on both accounts while
  prompt-fixed requests returned OK. A renewed allowance cannot help a request billed to the
  wrong workspace.

The prompt reword does not dodge a quota. It restores attribution.

---

## The error taxonomy, from 479 session files

Every Anthropic error on this machine, grouped by status and type:

| status | error type | n | in sub-agents | in parents | meaning |
|---|---|---:|---:|---:|---|
| 400 | `invalid_request_error` | 146 | **90** | 56 | wrong-workspace attribution, not credit |
| 429 | `rate_limit_error` | 83 | **0** | 83 | the real allowance |
| - | `overloaded_error` | 15 | 0 | 15 | transient capacity |

**The zero is the decisive cell.** Not one of the 83 genuine rate limits ever came from a
sub-agent, while 90 of the 146 refusals did - same accounts, same days. Sub-agents are exactly
the population that launched without the prompt fix. An account that was truly empty would have
refused the parents too.

Of the 56 parent-side 400s, 34 are disposable probe directories from this session's own testing
and the rest predate the fix (first 400: 2026-08-31; fix written 2026-09-01).

---

## Hypotheses ruled out, each by measurement

| Hypothesis | How it died |
|---|---|
| Accounts out of credit | Both answer on demand, before and after the renewal |
| Model tier / Opus cap | opus, sonnet, fable, haiku behave identically under a given path |
| API key vs OAuth credential | Both accounts `type: "oauth"`, both tokens `sk-ant-oat01`, identical code path |
| Request size / context window | 27 successful requests at 500k-1M; 4 x 147k back to back all passed |
| Over the model's window | Session was at 28% of 1M. The `114.9%/200k` reading was a display bug, since fixed |
| cwd / project instructions | `/tmp`, the repo and both worktrees all pass |
| Concurrency | 8 parallel requests, all OK |
| Tokens per minute | 4 x 147k-token requests back to back, all OK |
| The sub-agent result block | Replayed verbatim in a fresh session -> ok |
| The 16.8KB file just read | Replayed verbatim -> ok |
| Empty-content messages correlating | An artifact of my own scan counting prior error entries |
| pi not masquerading as Claude Code | pi sends `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, `user-agent: claude-cli/2.1.75`, `x-app: cli` for any `sk-ant-oat` token |

Still unexplained: the **intermittent** 400 inside long, tool-heavy sessions. Next steps are in
the handoff; the most promising is whether pi remaps tool names for OAuth requests, since the
bundle carries a `claudeCodeTools` list and sub-agents run tools no Claude Code build has.

---

## Process lessons worth keeping

1. **A planted defect only counts when the planted line is on the path the test walks.** One
   defect planted in `getAvailableMembers` failed nothing, because the cascade under test never
   calls it. Re-planted in `isMemberExhausted`, it failed immediately.

2. **A test can pass for the wrong reason at the end of a cascade.** A "must not replay"
   assertion sat where `handleError` returns before reaching the replay, so an
   unconditionally-replaying build stayed green. Order matters: put the negative case where
   live targets still exist.

3. **Measure with the same flags the real thing uses.** Every probe that "proved" the accounts
   were out of credit used `--no-extensions`, which is the one flag that causes the failure.

4. **A wrong number is worse than no number.** `contextWindowFor` guessed 200k for any model
   named "claude". Opus is 1M. That single wrong denominator produced `114.9%/200k`, which reads
   as "blew past its window", and cost a whole investigation into context overflow.

5. **Deploy is part of the change.** Three fixes silently ran stale code because the installed
   extension is a file copy, not a symlink. `scripts/deploy.sh --check` now exists for exactly
   this and belongs in front of any "it works now".

6. **Trust `error.type` and status, never the prose.** Every error in this story is worded as
   though it were about money.

7. **The user's cheap experiments beat my expensive ones.** "Hit continue and it works, same
   account" settled in one word what four of my probes could not, and two of the eight defects
   were located by his hypotheses rather than my instrumentation.
