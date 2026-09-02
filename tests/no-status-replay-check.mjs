/**
 * After a rotation, does the turn actually run again?
 *
 * pi only retries a failed turn when the provider error is retryable, and its
 * rule is narrow (pi 0.84.4, `isRetryableProviderError`):
 *
 *     408, 409, 429, >= 500, or an x-should-retry: true header
 *
 * A 400 is never retried. Anthropic reports subscription exhaustion as exactly
 * that - `400 {"type":"error","error":{"type":"invalid_request_error", ...
 * "You're out of extra usage"}}`, captured verbatim from a real agent_end event
 * on 2026-09-02 - so multi-pass switches the account and then nothing resumes.
 * A human presses Enter again. A sub-agent has nobody to press Enter: it lands
 * on a healthy account with its task unexecuted and the pane goes idle.
 *
 * So the replay is conditional, and both halves are load-bearing:
 *
 *   - error pi WILL retry      -> rotate only. Replaying would send the prompt
 *     twice, once by us and once by pi's own retry. That regression is why
 *     c9f4b3f removed the unconditional replay; tests/failover-turn-integrity-check.mjs
 *     guards that direction.
 *   - error pi will NOT retry  -> replay exactly once per rotation.
 *
 * This file guards the second direction, plus the "exactly once" part.
 *
 *   node tests/failover-replay-check.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const here = new URL(".", import.meta.url).pathname;
const extPath = join(here, "..", "extensions", "multi-sub.ts");
const agentDir = mkdtempSync(join(tmpdir(), "multipass-replay-"));
const originalPrompt = "audit the session files and write docs/forensics.md";

writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
	subscriptions: [{ provider: "anthropic", index: 2 }],
	pools: [
		{ name: "anthropic", baseProvider: "anthropic", members: ["anthropic", "anthropic-2"], enabled: true },
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
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
	anthropic: { type: "oauth", access: "fake-anthropic" },
	"anthropic-2": { type: "oauth", access: "fake-anthropic-2" },
	"openai-codex": { type: "oauth", access: "fake-codex" },
}, null, 2));

process.env.MULTIPASS_TEST_AGENT_DIR = agentDir;
delete process.env.MULTI_SUB;

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": join(here, "stubs", "coding-agent.mjs"),
		"@earendil-works/pi-ai/compat": join(here, "stubs", "pi-ai-failover.mjs"),
		"@earendil-works/pi-ai/oauth": join(here, "stubs", "pi-ai-failover.mjs"),
		"@earendil-works/pi-ai": join(here, "stubs", "pi-ai-failover.mjs"),
		"@earendil-works/pi-tui": join(here, "stubs", "pi-tui.mjs"),
	},
});
const mod = await jiti.import(extPath, {});
const multiSub = mod.default;

const models = new Map([
	["anthropic:claude-opus-5", { provider: "anthropic", id: "claude-opus-5", api: "fake" }],
	["anthropic-2:claude-opus-5", { provider: "anthropic-2", id: "claude-opus-5", api: "fake" }],
	["openai-codex:gpt-5.6-sol", { provider: "openai-codex", id: "gpt-5.6-sol", api: "fake" }],
]);
const handlers = new Map();
const injectedUserMessages = [];
const modelSwitches = [];
let currentModel = models.get("anthropic:claude-opus-5");

const pi = {
	on(type, handler) {
		const entries = handlers.get(type) ?? [];
		entries.push(handler);
		handlers.set(type, entries);
	},
	registerProvider() {},
	registerCommand() {},
	async setModel(model) {
		modelSwitches.push(`${model.provider}:${model.id}`);
		currentModel = model;
		return true;
	},
	sendUserMessage(content, options) {
		injectedUserMessages.push({ content, options });
	},
};

multiSub(pi);

const notifications = [];
const modelRegistry = {
	find(provider, modelId) {
		return models.get(`${provider}:${modelId}`);
	},
	getProviderAuthStatus(provider) {
		const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
		return { configured: provider in auth, source: "stored" };
	},
	getProvider() {
		return undefined;
	},
	refresh() {
		return Promise.resolve({});
	},
};
const ctx = {
	cwd: agentDir,
	get model() {
		return currentModel;
	},
	modelRegistry,
	ui: {
		notify(message, level) {
			notifications.push({ message, level });
		},
		setStatus() {},
	},
};

async function emit(type, event) {
	for (const handler of handlers.get(type) ?? []) {
		await handler(event, ctx);
	}
}

/**
 * Verbatim from a real agent_end event, 2026-09-02, `anthropic` account.
 * The leading "400 " is how pi formats `${status} ${body}` into errorMessage;
 * the assistant message carries no separate status field, so the status has to
 * be read off this string.
 */
function creditExhaustedEvent(provider, model = "claude-opus-5") {
	return {
		type: "agent_end",
		messages: [{
			role: "assistant",
			provider,
			model,
			stopReason: "error",
			errorMessage:
				'400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Ask your workspace admin to add more so you can keep going."},"request_id":"req_011CeeWqkhoUWwzFFQR8Xazb"}',
			content: [],
		}],
	};
}

/**
 * Codex's cap, verbatim: plain text, no HTTP status, no JSON body.
 *
 * pi's retry gate is `isProviderError(error) && isRetryableProviderError(error)`,
 * and `isProviderError` requires BOTH `status` and `headers` on the error object.
 * An error carrying neither is thrown immediately and never retried - so a
 * rotation on this error MUST replay the turn, or the work stops dead on a
 * healthy account.
 *
 * Observed 2026-09-02, a worker sub-agent: four tool calls on
 * openai-codex/gpt-5.5, the cap, a correct rotation to anthropic/claude-opus-5,
 * and then the session file simply ends. Not one request on the new account.
 */
function codexCapEvent(provider, model) {
	return {
		type: "agent_end",
		messages: [{
			role: "assistant",
			provider,
			model,
			stopReason: "error",
			errorMessage: "Codex error: The usage limit has been reached",
			content: [],
		}],
	};
}

/** A 429, which pi retries on its own. Rotate, do not replay. */
function rateLimitedEvent(provider, model = "claude-opus-5") {
	return {
		type: "agent_end",
		messages: [{
			role: "assistant",
			provider,
			model,
			stopReason: "error",
			errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached"}}',
			content: [],
		}],
	};
}

function replayTurn() {
	return emit("before_agent_start", {
		type: "before_agent_start",
		prompt: originalPrompt,
		systemPrompt: "",
		systemPromptOptions: { cwd: agentDir },
	});
}

await emit("session_start", { type: "session_start", reason: "startup" });
await emit("input", { type: "input", text: originalPrompt, source: "interactive" });
await emit("before_agent_start", {
	type: "before_agent_start",
	prompt: originalPrompt,
	systemPrompt: "",
	systemPromptOptions: { cwd: agentDir },
});

// ── A provider error with NO HTTP status, with a live target available ────
//
// This is the decisive case. pi's retry gate is
//   isProviderError(error) && isRetryableProviderError(error)
// and isProviderError requires BOTH `status` and `headers` on the error object
// (pi 0.84.4, dist/bundle/chunks/chunk-XNGRGP62.js). An error carrying neither
// is thrown immediately and never retried. So on such an error a rotation MUST
// replay the turn - otherwise the work stops dead on a healthy account.
//
// It runs FIRST, where anthropic-2 and the whole codex entry are still live. At
// the end of a cascade handleError returns before the replay and this would pass
// for the wrong reason - which is how the 429 assertion in
// failover-replay-check.mjs fooled me on 2026-09-02.
await emit("agent_end", codexCapEvent("anthropic", "claude-opus-5"));
assert.equal(currentModel.provider, "anthropic-2", "a capped account must still rotate");
assert.equal(
	injectedUserMessages.length,
	1,
	"pi cannot retry a statusless error, so the rotation must replay the turn itself",
);
assert.equal(injectedUserMessages[0].options?.deliverAs, "followUp");

await replayTurn();

// A 429 in the same position - live target still available - must NOT replay,
// because pi retries that one itself.
await emit("agent_end", rateLimitedEvent("anthropic-2", "claude-opus-5"));
assert.equal(currentModel.provider, "openai-codex", "429 rotates too");
assert.equal(
	injectedUserMessages.length,
	1,
	"a 429 has a status pi acts on; replaying it would send the prompt twice",
);

console.log(
	`no-status replay checks passed (${modelSwitches.length} rotations, ${injectedUserMessages.length} replay)`,
);
