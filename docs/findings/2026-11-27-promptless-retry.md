# Promptless retries revisited refused accounts

Symptom: two sessions recorded `429` with `rate_limit_error` four times, alternating `anthropic` and `anthropic-2` on `claude-opus-5-5`, then switching back to `anthropic`. The reported terminal message was `Retry failed after 3 attempts`.

Misleading diagnosis: OpenAI was disabled or needed a new login. Neither follows from these errors. The global enabled chain included Codex (`gpt-6.2-astra`), both pool cooldowns were zero and outbrink had no project configuration override when checked.

Mechanism: both logs record custom subagent results before the refusal. Pi can start a run with a custom message instead of a user prompt. PoolManager.ensureCascadeState created a fresh attempted-provider set on every promptless refusal. With cooldown disabled, the previous account was immediately eligible again.

Fix: d36b459 keeps a promptless turn's state between retries. It changes neither eligibility nor ordering. A new promptless turn still resets the state at start.

Proof: `node tests/cooldown-disabled-check.mjs` failed with `actual: 'anthropic', expected: 'openai-codex'` before the fix and printed `cooldown-disabled-check: ok` afterward. The regression sends a custom turn through real extension handlers and two 429s through model selection. Model responses are simulated.

Status: reproduced and verified locally on 2026-11-27. Live provider capacity not tested. Do not use user prompt availability to decide whether a retry cascade exists.
