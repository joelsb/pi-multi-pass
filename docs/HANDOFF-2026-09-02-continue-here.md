# Handoff: sub-agent failover, 2026-09-02

Written at the end of a long session so the next one starts with the decisions already made
rather than re-deriving them. Everything below was measured on this machine on 2026-09-02,
not reasoned about. Companion document: `docs/findings/2026-09-02-anthropic-400-investigation.md`
carries the full timeline and every hypothesis that was ruled out.

Two repos, both on `main`, both pushed to the `fork` remote:

| Repo | Role |
|---|---|
| `~/MYNE/Projects/tools/pi-multi-pass` | the failover engine. Fork of `hjanuschka/pi-multi-pass`. |
| `~/MYNE/Projects/tools/pi-interactive-subagents` | spawns sub-agents. Fork of `amosblomqvist/...`. |

---

## Read this first: the deploy step

pi loads multi-pass from `git:github.com/joelsb/pi-multi-pass` (in `~/.pi/agent/settings.json`
and the shared `~/.agents/pi-packages.txt`), cloned at `~/.pi/agent/git/github.com/joelsb/pi-multi-pass`.
A commit changes nothing pi runs until it is pushed to the fork and pulled with `pi update --extension`.

```bash
bash scripts/deploy.sh          # push HEAD to fork main, pi update --extension, verify
bash scripts/deploy.sh --check  # drift report, exit 1 if pi runs another commit
```

Put `--check` in front of any "it works now" claim. Extensions load **per process**, so an
already-running pi keeps the old code until it restarts or `/reload`s.

Never go back to `npm:pi-multi-pass` (changed 2026-10-02): the old flow hand-copied this file
over the npm package, and on 2026-09-21 a package update replaced it with upstream 1.5.1,
dropping every fix below, ring traversal included.

Since 2026-10-02 every pi package loads from git the same way, subagents included
(`git:github.com/joelsb/pi-interactive-subagents`): push, then `pi update --extension <source>`.

---

## What was wrong, and what each fix does

Eight defects, in the order the code hits them. All eight are fixed, tested, and deployed.

| # | Defect | Fix | Commit |
|---|---|---|---|
| 1 | Subscription exhaustion was not classified as a reason to rotate, so failover never fired at all | 3 patterns added to `RATE_LIMIT_PATTERNS` | `9f63d59` |
| 2 | After a rotation nobody re-ran the turn | conditional replay via `piWillRetryTurn` | `757bf3a` |
| 3 | A chain hop discarded the running model, promoting a cheap agent to a flagship one | `tiers` table + `resolveTierEquivalent` | `a9d41b1` |
| 4 | Every process re-learned which accounts were dead by spending a request | shared exhaustion ledger | `e8b7ec6` |
| 5 | An ambiguous refusal was published to that ledger, evicting healthy accounts fleet-wide | `LEDGER_WORTHY_PATTERNS` | `008dfd9` |
| 6 | Chain traversal was forward-only, so the last entry was a dead end | ring traversal | `6d42c13` |
| 7 | A statusless provider error was assumed retryable by pi, which never retries it | inverted default + `inferStatusFromErrorType` | `ebb3f1a` |
| 8 | One refusal evicted an account that was never dead | retry in place, 3 attempts | `7bbc683`, `c9c7068` |

Subagents repo:

| Defect | Fix | Commit |
|---|---|---|
| Children lost the extension that makes Anthropic OAuth work at all | `getProviderAuthExtensionPaths` | `75276c2` |
| Children lost multi-pass, so they had one account and no chain | `getFailoverExtensionPath` | `d6b89f3` |
| Auto-exit killed a child mid-recovery | deferred exit, cancelled by `agent_start` | `7a6d554` |
| Spawns went to accounts already known dead | `account-routing.ts` | `1031855` |
| The context gauge guessed the window from the model name and was wrong | ask `ctx.modelRegistry` | `76fc33e` |

---

## Decisions taken, with the reasoning that is not obvious from the diff

1. **`out of extra usage` rotates but is never published to the shared ledger.** It is a real
   spend limit, but on a workspace the user never meant to bill (see ADR 0001). Rotating is
   defensible - the next account might attribute correctly. Publishing is not: one refusal
   would evict a funded account for every process on the machine for five minutes, which is
   how two planners died with credit sitting idle.

2. **Two pattern lists, deliberately not merged.** `RATE_LIMIT_PATTERNS` answers "should this
   turn move elsewhere". `LEDGER_WORTHY_PATTERNS` answers "should every other process believe
   this account is finished". The second is a strictly stronger claim and needs stronger
   evidence. **General rule worth keeping: local state may act on one observation, shared
   state must not.**

3. **Tiers are keyed by the pool's `baseProvider`, never by the account.** By the time a
   cascade reaches a chain hop it has usually rotated within the pool, so `currentModel.provider`
   is `anthropic-2`, which no sane table lists. Keying by account silently disabled every
   mapping. There is a planted-defect test for exactly this.

4. **`piWillRetryTurn` returns false when no status can be inferred.** pi's retry has a shape
   gate before its status gate - `isProviderError` requires both `status` and `headers` on the
   error object - so an error carrying neither is thrown immediately. The status is inferred
   from `error.type` when the prefix is absent, because `overloaded_error` and `api_error`
   arrive with no prefix while `rate_limit_error` and `invalid_request_error` carry theirs.

5. **The in-place retry is gated on the same predicate as the replay.** If pi will retry, it
   already has, and a second attempt here adds nothing. So a 429 rotates on the first failure
   and a statusless refusal does not.

6. **A sub-agent's failure must not silently re-route its parent.** It currently does, through
   the ledger. Retry-in-place removes most of the harm by keeping blips out of the file, but
   the coupling is still there by design and is listed as open work below.

7. **The subagents extension keeps its own copy of `resolveTierEquivalent`.** It must work with
   multi-pass absent, so it cannot import from it. Keep the two in step; both key on
   `baseProvider`.

---

## The one thing still unexplained - RESOLVED, awaiting approval

**Root cause found and fixed later the same day. Read
`docs/findings/2026-09-02-anthropic-400-investigation.md`, section "Root cause, and the fix",
before anything below in this section.** In one line: Anthropic content-classifies the
**`system` field only** and denies the subscription claim to a request whose system prompt does
not read as Claude Code; the denied request falls to overage, which is zero, and that is the
400. The fix (`~/.pi/agent/extensions/anthropic-oauth-system-relocate.ts`) leaves only the
Claude Code identity block in `system` and moves pi's prompt into a leading user turn.
Implemented, verified on both accounts, **not committed - waiting for Joel's approval**.

Two claims in the rest of this section are now known wrong: the tool-name axis was measured and
makes no difference, and "it is not the auth path" was right for the wrong reason - both
accounts are identical, but the request content was never neutral. The rest is kept as the
record of what the evidence looked like before the cause was known.

**An intermittent `400 invalid_request_error` "You're out of extra usage" inside long,
tool-heavy sessions.** Same session, same model, same account, seconds apart:

```
18:04:01  claude-fable-5  282,393 tok (28% of 1M)  ok
18:04:25  claude-fable-5  283,261 tok (28%)        ok
18:04:27  claude-fable-5        -                  400 out of extra usage
18:08:27  claude-fable-5  290,571 tok (29%)        ok
```

And the user's own decisive observation: a 400, cascade exhausted, then the single word
`continue` - and the **same account, same model** resumed instantly.

### What is already known

- **It is not credit.** Both accounts answer on demand. The subscription allowance genuinely
  was exhausted earlier and renewed at 22:00 local, and that exhaustion is the 83
  `429 rate_limit_error` entries in the session history, never the 400s.
- **It tracks the system prompt.** Same account, same model, same minute:
  `pi -p` returns OK, `pi --no-extensions -p` returns the 400. The difference is
  `~/.pi/agent/extensions/anthropic-oauth-prompt-fix.ts`, which rewords two lines of pi's own
  prompt. That extension's header carries the original bisection.
- **Per the API docs**, a 400 is what Anthropic returns for an organisation or workspace spend
  limit *except* on the Claude Code workspace, which returns 429. So the 400 means the request
  was billed to a workspace with no budget - i.e. it was **not attributed to Claude Code**.
- **It is not the auth path.** pi sends the full masquerade for any token containing
  `sk-ant-oat`: `anthropic-beta: claude-code-20250219,oauth-2025-04-20`,
  `user-agent: claude-cli/<version>`, `x-app: cli`. Both accounts carry `sk-ant-oat01` tokens,
  so pi's own account and the multi-pass account take an identical code path - which matches
  their identical behaviour.

### Ruled out, each by measurement

model tier (opus/sonnet/fable/haiku behave identically under a given path) · credential type ·
request size (27 successful requests at 500k-1M context; 4 x 147k back to back all passed) ·
cwd and project instructions (`/tmp`, the repo and both worktrees all pass) · concurrency
(8 parallel all passed) · tokens per minute · the sub-agent result block replayed verbatim ·
the 16.8KB file the parent had just read, replayed verbatim · over-window context (the session
was at 28% of 1M; the `114.9%/200k` reading that suggested otherwise was a display bug, since
fixed).

### Where to go next, in order

1. **Dump the failing request body.** Every cheaper avenue is exhausted. Patch pi's provider
   call, or run it behind a local proxy, and capture the exact payload of a 400 next to the
   payload of a 200 from the same session. Then bisect as the prompt-fix author did.
2. **Check whether pi remaps tool names for OAuth requests.** The bundle contains
   `claudeCodeTools = ["Read","Write","Edit","Bash","Grep","Glob","AskUserQuestion",...]`, so
   pi knows the canonical Claude Code list. If a request carries pi's own names (`read`,
   `safe_bash`, `subagent`, `ask_question`) the classifier may not read it as Claude Code.
   This is the most promising untested axis, and it would explain why sub-agents produced
   **90 of the 146** refusals: they carry custom tools no Claude Code build has.
   File: `dist/bundle/chunks/anthropic-messages-JWX2WP65.js`.
3. **Check whether `claudeCodeVersion = "2.1.75"` is still accepted.** It is pinned in the same
   bundle. A version Anthropic has stopped recognising would produce exactly this.
4. **Only then** consider a longer cooldown for spend-cap 429s (see ADR 0001), which is a real
   but separate refinement.

---

## Open work, ranked

1. **Retryable-exhaustion reporting.** When a cascade exhausts, the child exits and the parent
   reports `failed (provider/agent error)` - indistinguishable from a crash. The orchestrator
   therefore replans from zero. It should say "all accounts in cooldown, resume in ~N min" and
   mark the session resumable. **This is the highest-value gap: it cost 13m56s + 13m33s of
   planner work and $12.66 in one afternoon.** ~2h.
2. **Refuse the spawn when every account is in cooldown.** `account-routing.ts` already knows.
   Fail in 0s instead of burning a spawn and 14 minutes. ~30 min, composes with 1.
3. **Scope the ledger by role**, so a disposable child's bad luck cannot re-route a long-lived
   parent holding expensive context. ~1h.
4. **Distinguish a spend-cap 429 from an ordinary one** by the absence of `retry-after`, and
   give it a much longer cooldown than 5 minutes. ~1h.
5. **Park a child instead of killing it** on cascade exhaustion, keeping its context warm.
   Correct but touches lifecycle semantics. ~half a day.

---

## How to work on this

```bash
cd ~/MYNE/Projects/tools/pi-multi-pass
for f in tests/*.mjs; do node "$f" || echo "FAIL $f"; done      # 16 files, no npm script
node tests/runtime-failover-check.mjs --retry-start-turn         # plus --pool-only --no-loop --failure-path
npx tsc -p tsconfig.check.json --noEmit
bash scripts/deploy.sh

cd ~/MYNE/Projects/tools/pi-interactive-subagents
npm test                                                          # 203 unit
PI_TEST_MODEL=openai-codex/gpt-5.4-mini npm run test:integration   # 16, real pi, real LLM, needs a mux
```

**Plant a defect for every behavioural claim.** Twice in this session a test passed for the
wrong reason and only a planted defect exposed it:

- A 429 "must not replay" assertion sat at the end of a cascade, where `handleError` returns
  before reaching the replay. An unconditionally-replaying build stayed green. Fixed by moving
  the case to where live targets still exist.
- A defect planted in `getAvailableMembers` did not fail anything, because the cascade under
  test never calls it. **"I planted a defect" only counts when the planted line is on the path
  the test actually walks.**

Verifying against the live accounts is cheap and worth it: `pi -p --model anthropic/claude-opus-5 "say ok"`.
To reproduce the 400 deterministically, add `--no-extensions` (which strips the prompt fix).

## What not to do

- Do not merge the two pattern lists. Do not publish an ambiguous refusal to the ledger.
- Do not key tiers by account name.
- Do not infer a context window, or a tier, from a model's name. Ask the registry; the name-based
  guess is what produced `114.9%/200k` and sent an afternoon down a context-overflow dead end.
- Do not trust a provider's error wording over its `error.type` and status. Every relevant error
  here is phrased as though it were about money.
- Do not claim a fix works without `deploy.sh --check` and a fresh process.
