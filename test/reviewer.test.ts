import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadOperatorPolicy, parseVerdict, review, type CompleteReview } from "../src/reviewer.ts";

function context(text = "Fix the project") {
	return { sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: text } }] } } as any;
}
const input = () => ({ call: { id: "1", name: "bash", arguments: { command: "printf hello" } }, prompt: "Allow tool: bash", policy: { text: "Never push main" }, environment: async () => ({ cwd: "/project" }) });
const allow: CompleteReview = async () => ({ text: '{"decision":"allow","reason":"harmless"}', model: "test/model", stopReason: "stop" });

describe("reviewer failure boundaries", () => {
	test("validates exactly one verdict with a nonempty reason", () => {
		for (const reply of ['garbage', '{"decision":"deny","reason":"no"}', '{"decision":"allow"}', '{"decision":"allow","reason":" "}', 'prefix {"decision":"allow","reason":"yes"}']) {
			expect(parseVerdict(reply)).toBeUndefined();
		}
		expect(parseVerdict('{"decision":"allow","reason":"safe"}')).toEqual({ decision: "allow", reason: "safe" });
	});

	test("sends the exact pending command and startup policy", async () => {
		const data = input();
		data.call.arguments.command = "printf hello # untrusted comment\n" + "x".repeat(3_000);
		let request: any;
		const verdict = await review(context(), data, async (_ctx, system, raw) => {
			request = JSON.parse(raw);
			expect(system).toContain("Never push main");
			return allow(_ctx, system, raw, new AbortController().signal);
		});
		expect(request.pending_call.arguments.command).toBe(data.call.arguments.command);
		expect(verdict.decision).toBe("allow");
	});

	test("escalates an oversized transcript without invoking the model or dropping restrictions", async () => {
		let calls = 0;
		const verdict = await review(context("x".repeat(61_000) + " Never push main"), input(), async (...args) => { calls++; return allow(...args); });
		expect(verdict.decision).toBe("escalate");
		expect(verdict.reason).toContain("nothing was truncated");
		expect(calls).toBe(0);
	});

	test("escalates oversized environment evidence too", async () => {
		const data = { ...input(), environment: async () => ({ status: "x".repeat(61_000) }) };
		expect((await review(context(), data, allow)).decision).toBe("escalate");
	});

	test("does not use a partial response even when it contains valid allow JSON", async () => {
		const verdict = await review(context(), input(), async (...args) => ({ ...await allow(...args), stopReason: "length" }));
		expect(verdict.decision).toBe("escalate");
	});

	test("model exceptions and unreadable policies escalate", async () => {
		expect((await review(context(), input(), async () => { throw new Error("no API key"); })).reason).toContain("no API key");
		const verdict = await review(context(), { ...input(), policy: { text: "", error: "policy unreadable" } }, allow);
		expect(verdict).toEqual({ decision: "escalate", reason: "policy unreadable" });
	});

	test("times out a provider that ignores cancellation", async () => {
		const verdict = await review(context(), input(), () => new Promise(() => {}), { timeoutMs: 15 });
		expect(verdict.decision).toBe("escalate");
		expect(verdict.reason).toContain("timed out");
	});

	test("propagates caller cancellation instead of opening a new approval", async () => {
		const controller = new AbortController();
		const work = review(context(), input(), () => new Promise(() => {}), { signal: controller.signal });
		controller.abort(new Error("user cancelled"));
		await expect(work).rejects.toThrow("user cancelled");
	});

	test("distinguishes an absent policy from a policy read failure", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "auto-mode-policy-"));
		try {
			expect(await loadOperatorPolicy(path.join(dir, "absent"))).toEqual({ text: "" });
			expect((await loadOperatorPolicy(dir)).error).toBeDefined();
			await writeFile(path.join(dir, "policy.md"), "Never deploy");
			expect(await loadOperatorPolicy(path.join(dir, "policy.md"))).toEqual({ text: "Never deploy" });
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
});
