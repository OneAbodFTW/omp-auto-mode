import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadOperatorPolicy, parseVerdict, review, type CompleteReview } from "../src/reviewer.ts";
import type { PendingCall, TranscriptEntry } from "../src/context.ts";

interface ReviewRequest {
	transcript: TranscriptEntry[];
	history: { total_tool_calls: number; omitted_tool_calls: number };
	pending_call: PendingCall;
}

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
		expect(calls).toBe(0);
	});

	test("bounds long tool history while retaining all restrictions and the exact pending eval", async () => {
		const ctx = context("Never push production. Inspect only.");
		const entries = ctx.sessionManager.getBranch();
		for (let i = 0; i < 200; i++) entries.push({
			type: "message", message: { role: "assistant", content: [
				{ type: "toolCall", id: String(i), name: "bash", arguments: { command: `printf '${i} ${"x".repeat(2000)}'` } },
			] },
		});
		entries.push({ type: "message", message: { role: "user", content: "Compute 17 + 25, without changing files." } });
		ctx.sessionManager.getBranch = () => entries;
		const data = { ...input(), call: { id: "eval-1", name: "eval", arguments: { language: "py", code: "print(17 + 25)" } } };
		let request: ReviewRequest | undefined;
		const verdict = await review(ctx, data, async (_ctx, system, raw) => {
			expect(system.length + raw.length).toBeLessThanOrEqual(60_000);
			request = JSON.parse(raw);
			return { text: '{"decision":"allow","reason":"pure arithmetic"}', model: "test/model", stopReason: "stop" };
		});
		expect(verdict.decision).toBe("allow");
		expect(request!.transcript.filter(entry => entry.role === "user").map(entry => entry.text)).toEqual([
			"Never push production. Inspect only.", "Compute 17 + 25, without changing files.",
		]);
		expect(request!.pending_call).toEqual(data.call);
		const calls = request!.transcript.filter(entry => entry.role === "tool_call");
		expect(calls.at(-1)!.arguments!.command).toBe(entries[200].message.content[0].arguments.command);
		expect(request!.history.omitted_tool_calls).toBe(200 - calls.length);
		expect(request!.history.omitted_tool_calls).toBeGreaterThan(0);
	});

	test("does not replace an oversized recent call with misleading older history", async () => {
		const ctx = context("Inspect only");
		const entries = ctx.sessionManager.getBranch();
		for (const command of ["printf old", "x".repeat(70_000)]) entries.push({
			type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
		});
		ctx.sessionManager.getBranch = () => entries;
		const verdict = await review(ctx, input(), async (_ctx, _system, raw) => {
			const request: ReviewRequest = JSON.parse(raw);
			expect(request.transcript).toEqual([{ role: "user", text: "Inspect only" }]);
			expect(request.history).toEqual({ total_tool_calls: 2, omitted_tool_calls: 2 });
			return { text: '{"decision":"escalate","reason":"missing evidence"}', model: "test/model", stopReason: "stop" };
		});
		expect(verdict.decision).toBe("escalate");
	});

	test("never clips an oversized pending call or policy to obtain approval", async () => {
		let calls = 0;
		const complete: CompleteReview = async (...args) => { calls++; return allow(...args); };
		const data = input();
		data.call.arguments.command = "x".repeat(70_000);
		expect((await review(context(), data, complete)).decision).toBe("escalate");
		expect((await review(context(), { ...input(), policy: { text: "x".repeat(70_000) } }, complete)).decision).toBe("escalate");
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
