/**
 * Does a quota-first pool spend the weekly quota that expires soonest?
 *
 * Two accounts, same plan: one has 43% of its week left with 4 days to go, the
 * other 53% left resetting in 20 hours. Whatever the second one does not spend
 * in those 20 hours is lost. The pool must start there, and on failover move to
 * the member whose weekly quota is worth most per hour left - while the chain
 * (anthropic pool, then codex, and back) keeps its order.
 *
 * Score = weekly % left / hours until weekly reset. A member with under 10% of
 * its 5-hour window or under 5% of its week left is skipped.
 *
 *   node tests/expiring-first-check.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const here = new URL(".", import.meta.url).pathname;
const extPath = join(here, "..", "extensions", "multi-sub.ts");
const HOUR = 3600 * 1000;

const CATALOG = [
	{ provider: "anthropic", id: "claude-opus-5" },
	{ provider: "anthropic-2", id: "claude-opus-5" },
	{ provider: "anthropic-3", id: "claude-opus-5" },
	{ provider: "openai-codex", id: "gpt-5.6-sol" },
];

/** Shape of GET https://api.anthropic.com/api/oauth/usage, read off a live call. */
function usage({ fiveHourUsed = 10, weeklyUsed, weeklyResetInHours }) {
	return {
		five_hour: { utilization: fiveHourUsed, resets_at: new Date(Date.now() + 2 * HOUR).toISOString() },
		seven_day: { utilization: weeklyUsed, resets_at: new Date(Date.now() + weeklyResetInHours * HOUR).toISOString() },
		seven_day_opus: null,
	};
}

async function scenario({ members, usageByProvider, startModel, fetchFails = false }) {
	const agentDir = mkdtempSync(join(tmpdir(), "multipass-expiring-"));
	writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
		subscriptions: [{ provider: "anthropic", index: 2 }, { provider: "anthropic", index: 3 }],
		pools: [
			{ name: "anthropic", baseProvider: "anthropic", members, enabled: true, strategy: "quota-first" },
			{ name: "codex", baseProvider: "openai-codex", members: ["openai-codex"], enabled: true },
		],
		chains: [{
			name: "all",
			enabled: true,
			entries: [
				{ pool: "anthropic", model: "claude-opus-5", enabled: true },
				{ pool: "codex", model: "gpt-5.6-sol", enabled: true },
			],
		}],
		presets: [],
	}, null, 2));
	// auth.json tokens are stale on purpose: the checker must use the registry's fresh key.
	const auth = Object.fromEntries(
		[...members, "openai-codex"].map((p) => [p, { type: "oauth", access: `stale-${p}`, expires: 0 }]),
	);
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth, null, 2));
	process.env.MULTIPASS_TEST_AGENT_DIR = agentDir;
	process.env.MULTI_PASS_RETRY_IN_PLACE_MS = "0";
	delete process.env.MULTI_SUB;

	const usageCalls = [];
	globalThis.fetch = async (url, init) => {
		const bearer = new Headers(init?.headers).get("authorization") ?? "";
		usageCalls.push({ url: String(url), bearer });
		if (fetchFails) throw new TypeError("fetch failed");
		const provider = bearer.replace(/^Bearer fresh-/, "");
		const body = usageByProvider[provider];
		if (!String(url).startsWith("https://api.anthropic.com/api/oauth/usage") || !body) {
			return new Response("{}", { status: 404 });
		}
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	};

	const jiti = createJiti(import.meta.url, {
		interopDefault: true,
		moduleCache: false,
		alias: {
			"@earendil-works/pi-coding-agent": join(here, "stubs", "coding-agent.mjs"),
			"@earendil-works/pi-ai/compat": join(here, "stubs", "pi-ai-failover.mjs"),
			"@earendil-works/pi-ai/providers/all": join(here, "stubs", "pi-ai-failover.mjs"),
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
				const stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
				return { configured: provider in stored, source: "stored" };
			},
			getApiKeyForProvider: async (provider) => `fresh-${provider}`,
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
		prompt: "keep working",
		systemPrompt: "",
		systemPromptOptions: { cwd: agentDir },
	});

	return {
		notifications,
		usageCalls,
		current: () => currentModel,
		fail: () => emit("agent_end", {
			type: "agent_end",
			messages: [{
				role: "assistant",
				provider: currentModel.provider,
				model: currentModel.id,
				stopReason: "error",
				errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}',
				content: [],
			}],
		}),
	};
}

// ── 1. Session start moves to the account whose week expires first ──
{
	const s = await scenario({
		members: ["anthropic", "anthropic-2"],
		startModel: "anthropic:claude-opus-5",
		usageByProvider: {
			anthropic: usage({ weeklyUsed: 57, weeklyResetInHours: 96 }),
			"anthropic-2": usage({ weeklyUsed: 47, weeklyResetInHours: 20 }),
		},
	});
	assert.equal(s.current().provider, "anthropic-2", "53% left expiring in 20h beats 43% left over 4 days");
	assert.equal(s.current().id, "claude-opus-5", "model id is kept");
	assert.ok(
		s.usageCalls.every((c) => c.bearer.startsWith("Bearer fresh-")),
		"usage is read with the registry's refreshed token, not the stale auth.json one",
	);
	assert.ok(s.notifications.some((n) => n.message.includes("anthropic-2")), "the switch is announced");
}

// ── 2. A nearly spent 5-hour window disqualifies the expiring account ──
{
	const s = await scenario({
		members: ["anthropic", "anthropic-2"],
		startModel: "anthropic:claude-opus-5",
		usageByProvider: {
			anthropic: usage({ weeklyUsed: 57, weeklyResetInHours: 96 }),
			"anthropic-2": usage({ fiveHourUsed: 95, weeklyUsed: 47, weeklyResetInHours: 20 }),
		},
	});
	assert.equal(s.current().provider, "anthropic", "5h window under 10% left: stay");
}

// ── 3. Usage endpoint down: session starts where it was, no throw ──
{
	const s = await scenario({
		members: ["anthropic", "anthropic-2"],
		startModel: "anthropic:claude-opus-5",
		usageByProvider: {},
		fetchFails: true,
	});
	assert.equal(s.current().provider, "anthropic");
}

// ── 4. Failover ranks by expiry inside the pool, chain order unchanged ──
{
	const s = await scenario({
		members: ["anthropic", "anthropic-2", "anthropic-3"],
		startModel: "anthropic:claude-opus-5",
		usageByProvider: {
			anthropic: usage({ weeklyUsed: 57, weeklyResetInHours: 96 }), // 43 / 96 = 0.45 per hour
			"anthropic-2": usage({ weeklyUsed: 70, weeklyResetInHours: 30 }), // 30 / 30 = 1.0 per hour
			"anthropic-3": usage({ weeklyUsed: 47, weeklyResetInHours: 20 }), // 53 / 20 = 2.65 per hour
		},
	});
	assert.equal(s.current().provider, "anthropic-3", "session starts on the most urgent week");
	await s.fail();
	assert.equal(
		s.current().provider,
		"anthropic-2",
		"round-robin would wrap to anthropic; 30% expiring in 30h beats 43% over 4 days",
	);
	await s.fail();
	assert.equal(s.current().provider, "anthropic", "last anthropic member next");
	await s.fail();
	assert.equal(s.current().provider, "openai-codex", "then the chain moves on to codex, as before");
}

console.log("expiring-first: all checks passed");
