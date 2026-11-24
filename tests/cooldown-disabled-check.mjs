/**
 * Can a machine opt out of the cooldown, paying one request to hear the truth?
 *
 * A pool with `"cooldownMs": 0` in multi-pass.json must try every member again
 * on the next failure, even one this process or the shared ledger saw refused
 * moments ago. The per-turn "already attempted" guard still ends a cascade.
 *
 *   node tests/cooldown-disabled-check.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const here = new URL(".", import.meta.url).pathname;
const extPath = join(here, "..", "extensions", "multi-sub.ts");
const agentDir = mkdtempSync(join(tmpdir(), "multipass-cooldown-"));
const ledgerPath = join(agentDir, "multi-pass-exhausted.json");

const POOLS = [
	{ name: "anthropic", baseProvider: "anthropic", members: ["anthropic", "anthropic-2"], enabled: true, cooldownMs: 0 },
	{ name: "codex", baseProvider: "openai-codex", members: ["openai-codex"], enabled: true, cooldownMs: 0 },
];

writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
	subscriptions: [{ provider: "anthropic", index: 2 }],
	pools: POOLS,
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
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
	anthropic: { type: "oauth", access: "a" },
	"anthropic-2": { type: "oauth", access: "b" },
	"openai-codex": { type: "oauth", access: "c" },
}, null, 2));

process.env.MULTIPASS_TEST_AGENT_DIR = agentDir;
delete process.env.MULTI_SUB;
// Retry-in-place is off for this file on purpose. Its subject is what happens
// WHEN a rotation occurs, and with the default 2s in-place retry the first
// refusal on each account no longer rotates at all. The interaction between the
// two is covered by tests/retry-in-place-check.mjs, which drives a full cascade
// with the policy on.
process.env.MULTI_PASS_RETRY_IN_PLACE_MS = "0";


const models = new Map([
	["anthropic:claude-opus-5", { provider: "anthropic", id: "claude-opus-5", api: "fake" }],
	["anthropic-2:claude-opus-5", { provider: "anthropic-2", id: "claude-opus-5", api: "fake" }],
	["openai-codex:gpt-5.6-sol", { provider: "openai-codex", id: "gpt-5.6-sol", api: "fake" }],
]);

/** A whole independent pi process, as far as module state is concerned. */
async function spawnInstance(label) {
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
	const handlers = new Map();
	let currentModel = models.get("anthropic:claude-opus-5");
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
			find: (provider, id) => models.get(`${provider}:${id}`),
			getProviderAuthStatus(provider) {
				const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
				return { configured: provider in auth, source: "stored" };
			},
			getProvider: () => undefined,
			refresh: () => Promise.resolve({}),
		},
		ui: { notify() {}, setStatus() {} },
	};
	const emit = async (type, event) => {
		for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
	};
	await emit("session_start", { type: "session_start", reason: "startup" });
	await emit("before_agent_start", {
		type: "before_agent_start",
		prompt: `work from ${label}`,
		systemPrompt: "",
		systemPromptOptions: { cwd: agentDir },
	});
	return {
		emit,
		current: () => currentModel,
		setCurrent: (key) => { currentModel = models.get(key); },
		newTurn: (label) => emit("before_agent_start", { type: "before_agent_start", prompt: label, systemPrompt: "", systemPromptOptions: { cwd: agentDir } }),
		/** An ambiguous refusal that Anthropic words like a billing error. */
		failAmbiguous: (provider) => emit("agent_end", {
			type: "agent_end",
			messages: [{
				role: "assistant",
				provider,
				model: "claude-opus-5",
				stopReason: "error",
				errorMessage:
					'400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Ask your workspace admin to add more so you can keep going."}}',
				content: [],
			}],
		}),
		fail: (provider) => emit("agent_end", {
			type: "agent_end",
			messages: [{
				role: "assistant",
				provider,
				model: "claude-opus-5",
				stopReason: "error",
				errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached"}}',
				content: [],
			}],
		}),
	};
}

// ── One turn still ends: both anthropic accounts refuse, codex is next ────
const parent = await spawnInstance("parent");
await parent.fail("anthropic");
assert.equal(parent.current().provider, "anthropic-2");
await parent.fail("anthropic-2");
assert.equal(parent.current().provider, "openai-codex", "the cascade still moves on within one turn");
assert.ok(existsSync(ledgerPath), "refusals are still recorded in the shared ledger");

// ── Next turn, same process: anthropic-2 is tried again, not skipped ──────
parent.setCurrent("anthropic:claude-opus-5");
await parent.newTurn("next turn");
await parent.fail("anthropic");
assert.equal(
	parent.current().provider,
	"anthropic-2",
	"with cooldownMs 0 a refusal seconds ago must not skip the account",
);

// ── A new process ignores the fresh ledger entries ────────────────────────
const child = await spawnInstance("child");
await child.fail("anthropic");
assert.equal(
	child.current().provider,
	"anthropic-2",
	"with cooldownMs 0 the ledger must not skip the account",
);

console.log("cooldown-disabled-check: ok");
