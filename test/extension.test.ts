import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import installAutoMode from "../src/extension.ts";

function harness(cwd = "/project") {
	const handlers = new Map<string, Function[]>();
	const entries: any[] = [{ type: "message", message: { role: "user", content: "Inspect the project; never push main" } }];
	const dialogs: any[] = [];
	const requests: any[] = [];
	const events: any[] = [];
	let human = "deny";
	let policy = "Never push main";
	let policyLoads = 0;
	let sessionId = "session-1";
	let complete = async (_ctx: any, system: string, raw: string) => {
		requests.push({ system, ...JSON.parse(raw) });
		return { model: "test/model", text: '{"decision":"allow","reason":"harmless"}', stopReason: "stop" };
	};
	const ui: any = {
		approve: async (prompt: any) => { dialogs.push(prompt); return human; },
		select: async () => "Deny", notify: () => {}, setStatus: () => {},
	};
	const ctx: any = { cwd, hasUI: true, ui, sessionManager: { getSessionId: () => sessionId, getBranch: () => entries } };
	const pi: any = {
		on: (name: string, fn: Function) => handlers.set(name, [...handlers.get(name) ?? [], fn]),
		events: { emit: (...args: any[]) => events.push(args) },
	};
	installAutoMode(pi, {
		agentDir: () => path.join(cwd, ".omp-agent"), extensionRoot: "/installed-auto-mode",
		inspectEdits: input => typeof input.path === "string" ? [input.path] : [],
		wrapText: text => [text], git: async () => "origin https://example.test/repo",
		loadPolicy: async () => { policyLoads++; return { text: policy }; },
		environment: async () => ({ cwd }), complete: (...args) => complete(...args),
	});
	async function emit(name: string, value = {}, context = ctx): Promise<any> {
		for (const fn of handlers.get(name) ?? []) {
			const result = await fn({ type: name, ...value }, context);
			if (result?.block) return result;
		}
	}
	async function pending(id: string, name: string, args: Record<string, unknown>) {
		entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
		await emit("tool_approval_requested", { toolCallId: id, toolName: name, sessionId });
	}
	async function approve(name = "bash", details = "Command: printf hello") {
		const full = `Allow tool: ${name}\n${details}`;
		return ui.approve({ full, compact: full });
	}
	return { ctx, ui, entries, dialogs, requests, events, emit, pending, approve,
		setHuman: (answer: string) => { human = answer; },
		setPolicy: (value: string) => { policy = value; }, policyLoads: () => policyLoads,
		setSession: (value: string) => { sessionId = value; },
		setComplete: (fn: typeof complete) => { complete = fn; },
	};
}

describe("approval integration", () => {
	test("returns once, never a standing grant, and reviews the original payload behind clipped UI text", async () => {
		const h = harness();
		const command = "printf hello # original comment\n" + "x".repeat(2_500);
		await h.pending("call-1", "bash", { command });
		expect(await h.approve("bash", "Command: printf hello[…2500ch elided…]")).toBe("once");
		expect(h.requests[0].pending_call.arguments.command).toBe(command);
		expect(h.dialogs).toHaveLength(0);
	});

	test("never models unidentified or ambiguous approvals", async () => {
		const h = harness();
		await h.emit("session_start");
		expect(await h.approve()).toBe("deny");
		await h.pending("1", "bash", { command: "printf first" });
		await h.pending("2", "bash", { command: "printf second" });
		expect(await h.approve()).toBe("deny");
		expect(h.requests).toHaveLength(0);
		expect(h.dialogs[1].full).toContain("cannot be identified uniquely");
	});

	test("removes completed calls before selecting another approval", async () => {
		const h = harness();
		await h.pending("1", "bash", { command: "printf first" });
		await h.emit("tool_approval_resolved", { toolCallId: "1" });
		await h.pending("2", "bash", { command: "printf second" });
		expect(await h.approve()).toBe("once");
		expect(h.requests[0].pending_call.id).toBe("2");
	});

	test("critical patterns and provider checks always reach the human", async () => {
		const h = harness();
		await h.pending("1", "bash", { command: "printf hello" });
		await h.approve("bash", "Reason: Critical pattern detected\nCommand: printf hello");
		await h.approve("bash", "Provider safety checks:\nCommand: printf hello");
		expect(h.requests).toHaveLength(0);
		expect(h.dialogs).toHaveLength(2);
	});

	test("keeps the policy snapshot for a session and reloads it for a new session", async () => {
		const h = harness();
		await h.emit("session_start");
		h.setPolicy("Allow every push");
		await h.pending("1", "bash", { command: "printf hello" });
		await h.approve();
		expect(h.requests[0].system).toContain("Never push main");
		expect(h.requests[0].system).not.toContain("Allow every push");
		expect(h.policyLoads()).toBe(1);
		h.setSession("session-2");
		await h.emit("session_switch");
		expect(h.policyLoads()).toBe(2);
	});

	test("sensitive file calls reach the human even when OMP would not prompt", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "auto-mode-extension-"));
		try {
			await writeFile(path.join(cwd, ".env"), "dummy");
			const h = harness(cwd);
			const result = await h.emit("tool_call", { toolCallId: "1", toolName: "read", input: { path: ".env" } });
			expect(result.block).toBe(true);
			expect(h.dialogs[0].full).toContain("file guard");
			expect(h.requests).toHaveLength(0);
			h.setHuman("once");
			expect(await h.emit("tool_call", { toolCallId: "2", toolName: "write", input: { path: "../outside" } })).toBeUndefined();
			h.setHuman("session");
			expect((await h.emit("tool_call", { toolCallId: "3", toolName: "write", input: { path: "../outside" } })).block).toBe(true);
		} finally { await rm(cwd, { recursive: true, force: true }); }
	});

	test("ordinary local writes do not add a guard prompt", async () => {
		const h = harness();
		expect(await h.emit("tool_call", { toolCallId: "1", toolName: "write", input: { path: "src/new.ts" } })).toBeUndefined();
		expect(h.dialogs).toHaveLength(0);
	});

	test("reviewer errors open the human dialog and preserve full details", async () => {
		const h = harness();
		h.setComplete(async () => { throw new Error("model unavailable"); });
		await h.pending("1", "bash", { command: "printf hello" });
		expect(await h.approve()).toBe("deny");
		expect(h.dialogs[0].full).toContain("model unavailable");
		expect(h.dialogs[0].compact).toContain("Original arguments");
		expect(h.events.at(-1)).toEqual(["herdr:blocked", { active: false }]);
	});

	test("headless contexts retain OMP's existing behavior", async () => {
		const h = harness();
		h.ctx.hasUI = false;
		await h.emit("session_start");
		expect(await h.emit("tool_call", { toolCallId: "1", toolName: "write", input: { path: "../outside" } })).toBeUndefined();
		expect(h.dialogs).toHaveLength(0);
		expect(h.policyLoads()).toBe(0);
	});

	test("patches the actual approval gate behind OMP's handler UI proxy only once", async () => {
		const h = harness();
		const original = h.ui.approve;
		h.ctx.ui = new Proxy(h.ui, { get: (target, key) => key === "approve" ? original : Reflect.get(target, key) });
		await h.emit("session_start");
		await h.emit("turn_start");
		await h.pending("1", "bash", { command: "printf hello" });
		expect(await h.approve()).toBe("once");
		expect(h.requests).toHaveLength(1);
	});

	test("does not apply an in-flight model verdict to a different session", async () => {
		const h = harness();
		let resolve!: (reply: any) => void;
		let started!: () => void;
		const reviewing = new Promise<void>(done => { started = done; });
		h.setComplete(async () => { started(); return new Promise(done => { resolve = done; }); });
		await h.pending("1", "bash", { command: "printf hello" });
		const work = h.approve();
		await reviewing;
		h.setSession("session-2");
		resolve({ model: "test/model", text: '{"decision":"allow","reason":"safe"}', stopReason: "stop" });
		await expect(work).rejects.toThrow("session change");
	});

	test("a call changed during review cannot use the earlier verdict", async () => {
		const h = harness();
		h.setComplete(async () => {
			h.entries.at(-1).message.content[0].arguments.command = "changed command";
			return { model: "test/model", text: '{"decision":"allow","reason":"safe"}', stopReason: "stop" };
		});
		await h.pending("1", "bash", { command: "printf hello" });
		expect(await h.approve()).toBe("deny");
		expect(h.dialogs[0].full).toContain("arguments changed during review");
	});

	test("a new user restriction invalidates a verdict already in flight", async () => {
		const h = harness();
		h.setComplete(async () => {
			h.entries.push({ type: "message", message: { role: "user", content: "Stop. Do not execute that command." } });
			return { model: "test/model", text: '{"decision":"allow","reason":"safe"}', stopReason: "stop" };
		});
		await h.pending("1", "bash", { command: "printf hello" });
		expect(await h.approve()).toBe("deny");
		expect(h.dialogs[0].full).toContain("user instructions or tool history changed");
	});
});
