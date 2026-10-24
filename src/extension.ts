import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI, ExtensionApprovalAnswer, ExtensionApprovalPrompt, ExtensionContext,
	ExtensionUIDialogOptions, ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import { buildTranscript, findPendingCall, type PendingCall } from "./context.ts";
import { environmentFacts, git } from "./environment.ts";
import { fileGuardReason } from "./file-guard.ts";
import { loadOperatorPolicy, review, type CompleteReview, type OperatorPolicy } from "./reviewer.ts";

const PATCHED = Symbol.for("omp.llm-approval-reviewer");
const ACTIVE = Symbol.for("omp.llm-approval-reviewer.active");
type Approve = NonNullable<ExtensionUIContext["approve"]>;
interface Patch {
	wrapped: Approve;
	askHuman: (prompt: ExtensionApprovalPrompt, options?: ExtensionUIDialogOptions) => Promise<ExtensionApprovalAnswer>;
}
interface Session {
	policy: OperatorPolicy;
	policyFile: string;
	agentDir: string;
	remotes: string | undefined;
}
export interface Dependencies {
	complete: CompleteReview;
	agentDir: () => string;
	extensionRoot: string;
	inspectEdits: (input: Record<string, unknown>) => string[];
	wrapText: (text: string, width: number) => string[];
	// Injectable so tests exercise the same orchestration without a model API or git process.
	loadPolicy?: typeof loadOperatorPolicy;
	git?: typeof git;
	environment?: typeof environmentFacts;
}

function showInFull(prompt: ExtensionApprovalPrompt, wrapText: Dependencies["wrapText"]): ExtensionApprovalPrompt {
	const width = Math.max(20, (process.stdout.columns || 100) - 6);
	const [title = "", ...details] = prompt.full.split("\n");
	return { ...prompt, compact: [title, ...details.flatMap(line => line ? wrapText(line, width) : [""])].join("\n") };
}

function annotate(prompt: ExtensionApprovalPrompt, note: string, call?: PendingCall): ExtensionApprovalPrompt {
	const [title = "", ...details] = prompt.full.split("\n");
	return {
		...prompt,
		full: [title, note, "", ...details, ...(call ? ["", "Original arguments (untrusted data):", JSON.stringify(call.arguments, null, 2)] : [])].join("\n"),
	};
}

export default function installAutoMode(pi: ExtensionAPI, dependencies: Dependencies): void {
	let liveCtx: ExtensionContext | undefined;
	const sessions = new Map<string, Promise<Session>>();
	const pending = new Map<string, { sessionId: string; toolName: string }>();

	function session(ctx: ExtensionContext): Promise<Session> {
		const id = ctx.sessionManager.getSessionId();
		let initialized = sessions.get(id);
		if (!initialized) {
			const agentDir = dependencies.agentDir();
			const policyFile = path.join(agentDir, "auto-mode-policy.md");
			initialized = Promise.all([
				(dependencies.loadPolicy ?? loadOperatorPolicy)(policyFile),
				(dependencies.git ?? git)(ctx.cwd, ["remote", "-v"]),
			]).then(([policy, remotes]) => ({ policy, remotes, policyFile, agentDir }));
			// Store the promise immediately: concurrent events must share the startup snapshot.
			sessions.set(id, initialized);
		}
		return initialized;
	}

	function patchUI(ctx: ExtensionContext): Patch {
		liveCtx = ctx;
		const ui = ctx.ui as ExtensionUIContext & { [PATCHED]?: Patch | true };
		// OMP event-handler proxies capture dialog methods. Inspect the current target
		// property so we patch/check the method used by OMP's actual approval gate.
		const current = Object.getOwnPropertyDescriptor(ui, "approve")?.value ?? ui.approve;
		const previous = ui[PATCHED];
		if (previous && previous !== true && previous.wrapped === current) return previous;
		const original: Approve = typeof current === "function" && previous !== true
			? current.bind(ui)
			: async (prompt, options) => {
				const choices = prompt.session ? ["Approve", prompt.session, "Deny"] : ["Approve", "Deny"];
				const answer = await ui.select(prompt.full, choices, options);
				return answer === "Approve" ? "once" : prompt.session && answer === prompt.session ? "session" : "deny";
			};
		const askHuman: Patch["askHuman"] = async (prompt, options) => {
			pi.events.emit("herdr:blocked", { active: true, label: prompt.full.split("\n")[0] });
			try { return await original(showInFull(prompt, dependencies.wrapText), options); }
			finally { pi.events.emit("herdr:blocked", { active: false }); }
		};
		const wrapped: Approve = async (prompt, options) => {
			options?.signal?.throwIfAborted();
			const forced = /^Reason: Critical pattern detected/m.test(prompt.full) ? "critical command pattern"
				: /^Provider safety checks:/m.test(prompt.full) ? "provider safety checks" : undefined;
			if (forced) return askHuman(annotate(prompt, `Auto mode skipped: ${forced} always needs you`), options);
			const ctxNow = liveCtx;
			if (!ctxNow) return askHuman(prompt, options);
			const sessionId = ctxNow.sessionManager.getSessionId();
			const toolName = /^Allow tool: ([^\n]+)\n?/.exec(prompt.full)?.[1];
			const candidates = [...pending].filter(([, value]) => value.sessionId === sessionId && value.toolName === toolName);
			if (candidates.length !== 1 || !toolName) {
				return askHuman(annotate(prompt, "Auto mode skipped: original call cannot be identified uniquely"), options);
			}
			let call: PendingCall | undefined;
			try { call = findPendingCall(ctxNow.sessionManager.getBranch(), candidates[0][0], toolName); }
			catch { /* Unserializable or unavailable arguments require the human. */ }
			if (!call) return askHuman(annotate(prompt, "Auto mode skipped: complete original arguments are unavailable"), options);
			const state = await session(ctxNow);
			const guard = await fileGuardReason(call.name, call.arguments, guardOptions(ctxNow, state));
			if (guard) return askHuman(annotate(prompt, `Auto mode file guard: ${guard}`, call), options);
			const contextAtReview = JSON.stringify(buildTranscript(ctxNow.sessionManager.getBranch()));
			ui.setStatus("auto-mode", `Auto mode reviewing: ${toolName}`);
			let verdict;
			try {
				verdict = await review(ctxNow, {
					call, prompt: prompt.full, policy: state.policy,
					environment: () => (dependencies.environment ?? environmentFacts)(ctxNow.cwd, state.remotes),
				}, dependencies.complete, { signal: options?.signal, logFile: process.env.OMP_AUTO_MODE_LOG?.trim() });
			} finally { ui.setStatus("auto-mode", undefined); }
			options?.signal?.throwIfAborted();
			if (liveCtx?.sessionManager.getSessionId() !== sessionId) throw new Error("Auto mode approval cancelled after a session change");
			if (pending.get(call.id)?.sessionId !== sessionId) throw new Error("Auto mode approval is no longer pending");
			let latest: PendingCall | undefined;
			try { latest = findPendingCall(ctxNow.sessionManager.getBranch(), call.id, call.name); } catch { /* Ask the human below. */ }
			if (!latest || JSON.stringify(latest.arguments) !== JSON.stringify(call.arguments)) {
				return askHuman(annotate(prompt, "Auto mode skipped: original arguments changed during review", latest), options);
			}
			if (JSON.stringify(buildTranscript(ctxNow.sessionManager.getBranch())) !== contextAtReview) {
				return askHuman(annotate(prompt, "Auto mode skipped: user instructions or tool history changed during review", latest), options);
			}
			const by = verdict.model ? ` (${verdict.model})` : "";
			if (verdict.decision === "allow") {
				ui.notify(`Auto mode approved${by}: ${toolName} — ${verdict.reason}`, "info");
				return "once";
			}
			return askHuman(annotate(prompt, `Auto mode${by}: needs you — ${verdict.reason}`, call), options);
		};
		const patch = { wrapped, askHuman };
		ui.approve = wrapped;
		ui[PATCHED] = patch;
		(globalThis as Record<symbol, unknown>)[ACTIVE] = true;
		return patch;
	}

	function guardOptions(ctx: ExtensionContext, state: Session) {
		return {
			cwd: ctx.cwd, home: os.homedir(), inspectEdits: dependencies.inspectEdits,
			protectedPaths: [state.policyFile, state.agentDir, path.join(os.homedir(), ".omp"), dependencies.extensionRoot],
		};
	}

	const initialize = async (ctx: ExtensionContext) => {
		liveCtx = ctx;
		if (!ctx.hasUI) return;
		await session(ctx);
		patchUI(ctx);
	};
	pi.on("session_start", async (_event, ctx) => initialize(ctx));
	pi.on("turn_start", async (_event, ctx) => initialize(ctx));
	pi.on("session_switch", async (_event, ctx) => initialize(ctx));
	pi.on("tool_approval_requested", async (event, ctx) => {
		if (!ctx.hasUI) return;
		await initialize(ctx);
		pending.set(event.toolCallId, { sessionId: event.sessionId, toolName: event.toolName });
	});
	pi.on("tool_approval_resolved", event => { pending.delete(event.toolCallId); });
	pi.on("tool_result", event => { pending.delete(event.toolCallId); });
	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const state = await session(ctx);
		const guard = await fileGuardReason(event.toolName, event.input, guardOptions(ctx, state));
		if (!guard) return;
		const patch = patchUI(ctx);
		const full = `Allow tool: ${event.toolName}\nAuto mode file guard: ${guard}\n\nOriginal arguments (untrusted data):\n${JSON.stringify(event.input, null, 2)}`;
		const answer = await patch.askHuman({ full, compact: full });
		if (answer !== "once") return { block: true, reason: `Auto mode file guard: ${guard}; user did not approve this call` };
	});
}
