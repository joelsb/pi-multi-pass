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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const here = new URL(".", import.meta.url).pathname;
const extPath = join(here, "..", "extensions", "multi-sub.ts");
const agentDir = mkdtempSync(join(tmpdir(), "multipass-replay-"));
const originalPrompt = "implement task 3 of the page-intros plan";

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
process.env.MULTI_PASS_RETRY_IN_PLACE_MS = "20";
process.env.MULTI_PASS_RETRY_IN_PLACE_ATTEMPTS = "3";
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

// ── One refusal must not evict a healthy account ─────────────────────────
//
// Measured 2026-09-02, one session, one model, one account, four minutes:
//   18:04:01 ok / 18:04:25 ok / 18:04:27 refused / 18:08:27 ok
// Rotating on that single refusal moved a working account aside, published the
// eviction to every other pi process for five minutes, and pushed the fleet
// onto the last remaining provider until it capped for real.
//
// So the first refusal retries the SAME account, and only the second rotates.
const ledgerPath = join(agentDir, "multi-pass-exhausted.json");

// Three attempts, then rotate. Each refusal must replay on the SAME account and
// leave the shared ledger untouched - publishing a blip is what evicts every
// other pi process from a working account for five minutes.
for (let attempt = 1; attempt <= 3; attempt++) {
	await emit("agent_end", creditExhaustedEvent("anthropic", "claude-opus-5"));
	assert.equal(
		currentModel.provider,
		"anthropic",
		`refusal ${attempt} of 3 must NOT rotate - the account may be perfectly healthy`,
	);
	assert.deepEqual(modelSwitches, [], "and must not call setModel at all");
	assert.equal(injectedUserMessages.length, attempt, "each attempt replays the prompt once");
	assert.equal(injectedUserMessages[attempt - 1].options?.deliverAs, "followUp");
	assert.ok(
		!existsSync(ledgerPath),
		"a blip must never reach the shared ledger",
	);
	assert.ok(
		notifications.some((n) => n.message.includes(`attempt ${attempt} of 3`)),
		`the user must be told this is attempt ${attempt} of 3`,
	);
	await replayTurn();
}

// ── The fourth refusal is evidence, not noise ────────────────────────────
await emit("agent_end", creditExhaustedEvent("anthropic", "claude-opus-5"));
assert.equal(
	currentModel.provider,
	"anthropic-2",
	"once the attempts are spent, rotate",
);
assert.equal(injectedUserMessages.length, 4, "and replay onto the new account");

await replayTurn();

// ── An error pi already retried itself must rotate immediately ───────────
//
// A 429 reaches us only after pi exhausted its own retries, so a second try
// here would add nothing. This is why the in-place retry is gated on the same
// predicate as the replay rather than on "is it a limit".
const switchesBefore429 = modelSwitches.length;
await emit("agent_end", rateLimitedEvent("anthropic-2", "claude-opus-5"));
assert.equal(
	modelSwitches.length,
	switchesBefore429 + 1,
	"a 429 must rotate on the first failure - pi has already retried it",
);
assert.equal(currentModel.provider, "openai-codex");

// ── The default is 3 when nothing is configured ──────────────────────────
{
	const saved = process.env.MULTI_PASS_RETRY_IN_PLACE_ATTEMPTS;
	delete process.env.MULTI_PASS_RETRY_IN_PLACE_ATTEMPTS;
	assert.equal(mod.retryInPlaceAttempts(), 3, "default attempts must be 3");
	process.env.MULTI_PASS_RETRY_IN_PLACE_ATTEMPTS = "junk";
	assert.equal(mod.retryInPlaceAttempts(), 3, "junk falls back to 3");
	process.env.MULTI_PASS_RETRY_IN_PLACE_ATTEMPTS = "0";
	assert.equal(mod.retryInPlaceAttempts(), 0, "0 disables in-place retry");
	if (saved === undefined) delete process.env.MULTI_PASS_RETRY_IN_PLACE_ATTEMPTS;
	else process.env.MULTI_PASS_RETRY_IN_PLACE_ATTEMPTS = saved;
}

console.log(
	`retry-in-place checks passed (${modelSwitches.length} rotations, ${injectedUserMessages.length} replays)`,
);
