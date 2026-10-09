# 0002. quota-first spends the week that expires soonest

Date: 2026-10-09
Status: Accepted

## Decision

Inside a pool with strategy `quota-first`, the member whose weekly quota is
worth most per hour before it resets goes first:

```
score = weekly % left / max(hours until weekly reset, 1)
```

Only members with at least 10% of the 5-hour window and 5% of the week left, and
a known weekly reset, are ranked. If none qualify, failover falls back to the
member with the most remaining quota, and session start stays on the current
model.

The ranking runs at session start (current member included) and on failover. The
chain order (anthropic pool, codex pool, back) is untouched: only the order
inside a pool changes.

Anthropic usage comes from `GET https://api.anthropic.com/api/oauth/usage`
(`anthropic-beta: oauth-2025-04-20`), read with the token pi's registry
refreshes, because the access token in `auth.json` lives about an hour.

## What forced it

Weekly quota cannot be banked. What an account does not spend before its weekly
reset is gone. Live usage read on 2026-10-08, two accounts on the same plan:

```
account A   43% of the week left   resets in ~4 days
account B   53% of the week left   resets in ~20 hours
```

B's 53% is only worth anything if spent in the next 20 hours, while A's 43%
can be spent over four days at no loss. By `% left / hours` B scores 2.65 and A
0.45. Most-remaining-% agrees here but not in general: with a third account at
30% left resetting in 30 hours (score 1.0) it orders 53%, 43%, 30%, and the
30% account loses most of its week at reset. The expiry rule orders 53%, 30%,
43%.

## Consequences

- One usage call per pool member at session start, about 200 ms, 5 s timeout.
  Any failure leaves the session on its current model, silently.
- A lower absolute % can win: 30% left resetting in 30 hours beats 43% left
  resetting in 4 days.
- `/subs limits` now lists Anthropic accounts too, since the checker is
  registered in `PROVIDER_QUOTA_CHECKERS`. An Anthropic account on an API key
  shows as an error there: that endpoint reports subscription windows only.
- Starting a session on another account than the one pi opened with is
  announced: `multi-pass: <provider> first, its weekly quota expires soonest`.

## Rejected alternatives

- **Most remaining %**: the previous behaviour. It ignores when the quota
  expires, so it can keep spending the account with time to spare.
- **Re-rank every turn**: switching account mid-session loses the prompt cache,
  so the saving is paid back in uncached input. The pick is made once, at start,
  and again only when a failover forces a move.

## Revisit when

- Anthropic exposes usage on response headers, so a ranking costs no extra call.
- A per-turn re-rank is wanted, for example once the cache cost is measured
  against a quota that would otherwise expire unused.

## Evidence

- `tests/expiring-first-check.mjs`: 53% over 20 h beats 43% over 4 days at
  session start, a spent 5-hour window disqualifies, an unreachable endpoint
  keeps the session where it was, and a three-member failover runs 53%, 30%, 43%
  and then moves on to codex.
- Live `/api/oauth/usage` response shape, 2026-10-08:
  `{five_hour:{utilization,resets_at}, seven_day:{utilization,resets_at}, seven_day_opus:null}`,
  `utilization` being percent used.
