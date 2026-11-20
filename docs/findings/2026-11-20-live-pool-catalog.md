# Failover rejected a registered Codex model

**Symptom:** Joel observed two Anthropic 429s followed by `invalid model: gpt-6.2-astra unavailable for codex`.

**Misleading diagnosis:** The Codex model looks unconfigured. It was present in the runtime registry.

**Mechanism and fix:** `getSelectableModelsForPool` in `extensions/multi-sub.ts` used the builtin catalog, so pool validation skipped the entry before a switch could be attempted. Commit `5be1a1b` reads the registry for the pool's base provider and members, using builtins only when registry enumeration is unavailable.

**Proof:** `node tests/failover-turn-integrity-check.mjs` drove the extension through two simulated 429s. Before the fix: `actual: 'anthropic-2'`, `expected: 'openai-codex'`. After: `After two Anthropic 429s: openai-codex/gpt-6.2-astra`. The regression also checks the unavailable-model warning for a builtin absent from the registry.

**Status:** Observed locally by the implementing agent on 2026-11-20, not deployed. Keep pool validation provider-scoped. Do not bypass it or change retries to compensate for a stale catalog.
