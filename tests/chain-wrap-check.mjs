/**
 * Can a session reach chain entries that sit BEFORE the one it started on?
 *
 * Chain traversal was forward-only:
 *
 *   const applicable = this.findApplicableChain(pool.name, config);
 *   for (let chainIndex = applicable.index + 1; chainIndex < entries.length; chainIndex++)
 *
 * With chain "all" = [0] anthropic, [1] codex, a session on codex gets
 * applicable.index = 1, the loop starts at 2, and runs zero times. Not "no
 * eligible member" - no candidate is even considered. The anthropic pool is
 * unreachable from codex however much credit it has.
 *
 * Observed 2026-09-02: two planners spawned onto the anthropic pool, failed over
 * to codex (correctly), worked 14 minutes, then hit codex's usage limit and died
 * with "Failover exhausted after openai-codex; no eligible target remained in
 * this cascade" - while both anthropic accounts were funded and idle. 14 minutes
 * and $12.66 of planning thrown away with a working account one entry away.
 *
 * A chain is the set of routes across providers, so traversal wraps. It stays
 * bounded by the cascade state that already exists: visitedChainIndexes means
 * each entry is considered once per turn, attemptedProviders means no account is
 * retried, so a wrap can only reach entries this turn never saw.
 *
 *   node tests/chain-wrap-check.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const here = new URL(".", import.meta.url).pathname;
const extPath = join(here, "..", "extensions", "multi-sub.ts");

const TIERS = [
	{ name: "flagship", models: { anthropic: "claude-opus-5", "openai-codex": "gpt-5.6-sol" } },
	{ name: "mid", models: { anthropic: "claude-sonnet-5", "openai-codex": "gpt-5.5" } },
];

const CATALOG = [
	{ provider: "anthropic", id: "claude-opus-5" },
	{ provider: "anthropic", id: "claude-sonnet-5" },
	{ provider: "anthropic-2", id: "claude-opus-5" },
	{ provider: "anthropic-2", id: "claude-sonnet-5" },
	{ provider: "openai-codex", id: "gpt-5.6-sol" },
	{ provider: "openai-codex", id: "gpt-5.5" },
];

async function scenario({ chains, startModel, pools }) {
	const agentDir = mkdtempSync(join(tmpdir(), "multipass-wrap-"));
	writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
		subscriptions: [{ provider: "anthropic", index: 2 }],
		pools,
		chains,
		presets: [],
		tiers: TIERS,
	}, null, 2));
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
		anthropic: { type: "oauth", access: "a" },
		"anthropic-2": { type: "oauth", access: "b" },
		"openai-codex": { type: "oauth", access: "c" },
	}, null, 2));
	process.env.MULTIPASS_TEST_AGENT_DIR = agentDir;
	delete process.env.MULTI_SUB;

	const jiti = createJiti(import.meta.url, {
		interopDefault: true,
		moduleCache: false,
		alias: {
			"@earendil-works/pi-coding-agent": join(here, "stubs", "coding-agent.mjs"),
			"@earendil-works/pi-ai/compat": join(here, "stubs", "pi-ai-failover.mjs"),
			"@earendil-works/pi-ai/oauth": join(here, "stubs", "pi-ai-failover.mjs"),
			"@earendil-works/pi-ai": join(here, "stubs", "pi-ai-failover.mjs"),
			"@earendil-works/pi-tui": join(here, "stubs", "pi-tui.mjs"),
		},
	});
	const mod = await jiti.import(extPath, {});

	const catalog = new Map(CATALOG.map((m) => [`${m.provider}:${m.id}`, { ...m, api: "fake" }]));
	const handlers = new Map();
	const notifications = [];
	let currentModel = catalog.get(startModel);
	assert.ok(currentModel, `missing ${startModel} from the catalog`);

	const pi = {
		on(type, handler) {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
		registerProvider() {},
		registerCommand() {},
		async setModel(model) {
			currentModel = model;
			return true;
		},
		sendUserMessage() {},
	};
	mod.default(pi);

	const ctx = {
		cwd: agentDir,
		get model() {
			return currentModel;
		},
		modelRegistry: {
			find: (provider, id) => catalog.get(`${provider}:${id}`),
			getProviderAuthStatus(provider) {
				const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
				return { configured: provider in auth, source: "stored" };
			},
			getProvider: () => undefined,
			refresh: () => Promise.resolve({}),
		},
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: () => {},
		},
	};
	const emit = async (type, event) => {
		for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
	};

	await emit("session_start", { type: "session_start", reason: "startup" });
	await emit("before_agent_start", {
		type: "before_agent_start",
		prompt: "plan the demo account work",
		systemPrompt: "",
		systemPromptOptions: { cwd: agentDir },
	});

	return {
		notifications,
		current: () => currentModel,
		// The real string codex sends when its cap is hit. No HTTP status prefix,
		// unlike Anthropic's `400 {json}`.
		fail: () => emit("agent_end", {
			type: "agent_end",
			messages: [{
				role: "assistant",
				provider: currentModel.provider,
				model: currentModel.id,
				stopReason: "error",
				errorMessage: "Codex error: The usage limit has been reached",
				content: [],
			}],
		}),
	};
}

const POOLS = [
	{ name: "anthropic", baseProvider: "anthropic", members: ["anthropic", "anthropic-2"], enabled: true },
	{ name: "codex", baseProvider: "openai-codex", members: ["openai-codex"], enabled: true },
];
const CHAIN_ALL = [{
	name: "all",
	enabled: true,
	entries: [
		{ pool: "anthropic", model: "claude-opus-5", enabled: true },
		{ pool: "codex", model: "gpt-5.6-sol", enabled: true },
	],
}];

// ── 1. The reported failure: last entry in the chain, earlier pool alive ──
{
	const s = await scenario({ chains: CHAIN_ALL, pools: POOLS, startModel: "openai-codex:gpt-5.6-sol" });

	await s.fail();
	assert.equal(
		s.current().provider,
		"anthropic",
		"from the last chain entry the cascade must wrap to an earlier one, not give up",
	);
	assert.equal(
		s.current().id,
		"claude-opus-5",
		"and the wrap is tier-mapped like any other hop: flagship codex -> flagship anthropic",
	);

	// Then it behaves like any other cascade: rotate within the pool it landed in.
	await s.fail();
	assert.equal(s.current().provider, "anthropic-2");
	assert.equal(s.current().id, "claude-opus-5");

	// Nothing left. It must NOT wrap back onto codex, which already failed.
	await s.fail();
	assert.equal(
		s.current().provider,
		"anthropic-2",
		"a provider already attempted this turn must not be revisited - that is an infinite cascade",
	);
	assert.ok(
		s.notifications.some((n) => n.message.includes("Failover exhausted")),
		"and the genuine dead end is still reported",
	);
	console.log("  wrap-from-last-entry checks passed");
}

// ── 2. A mid-tier session wrapping keeps its tier ─────────────────────────
{
	const s = await scenario({ chains: CHAIN_ALL, pools: POOLS, startModel: "openai-codex:gpt-5.5" });
	await s.fail();
	assert.equal(s.current().provider, "anthropic");
	assert.equal(
		s.current().id,
		"claude-sonnet-5",
		"a mid-tier codex session must wrap onto the mid-tier anthropic model",
	);
	console.log("  wrap keeps the tier");
}

// ── 3. Starting at the first entry still goes forward first ───────────────
{
	const s = await scenario({ chains: CHAIN_ALL, pools: POOLS, startModel: "anthropic:claude-opus-5" });
	await s.fail();
	assert.equal(s.current().provider, "anthropic-2", "same-pool rotation comes first, as before");
	await s.fail();
	assert.equal(s.current().provider, "openai-codex", "then forward along the chain, as before");
	assert.equal(s.current().id, "gpt-5.6-sol");
	console.log("  forward order unchanged");
}

// ── 4. A single-entry chain must not spin ─────────────────────────────────
{
	const s = await scenario({
		chains: [{ name: "solo", enabled: true, entries: [{ pool: "codex", model: "gpt-5.6-sol", enabled: true }] }],
		pools: POOLS,
		startModel: "openai-codex:gpt-5.6-sol",
	});
	await s.fail();
	assert.equal(
		s.current().provider,
		"openai-codex",
		"one entry, one member, nowhere to go - and no wrap onto itself",
	);
	assert.ok(s.notifications.some((n) => n.message.includes("Failover exhausted")));
	console.log("  single-entry chain terminates");
}

console.log("chain wrap checks passed");
