import { readFile, appendFile } from "node:fs/promises";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildTranscript, type PendingCall } from "./context.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

export const MAX_REVIEW_CHARS = 60_000;
export interface Verdict {
	decision: "allow" | "escalate";
	reason: string;
	model?: string;
}

export interface OperatorPolicy {
	text: string;
	error?: string;
}

export async function loadOperatorPolicy(file: string): Promise<OperatorPolicy> {
	try {
		return { text: await readFile(file, "utf8") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "" };
		return { text: "", error: "operator policy could not be read at session start" };
	}
}

export interface Completion {
	text: string;
	model: string;
	stopReason: string;
	errorMessage?: string;
}

export type CompleteReview = (
	ctx: ExtensionContext,
	system: string,
	request: string,
	signal: AbortSignal,
) => Promise<Completion>;

export function parseVerdict(reply: string): Omit<Verdict, "model"> | undefined {
	let parsed: unknown;
	try { parsed = JSON.parse(reply); } catch { return; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
	const { decision, reason } = parsed as Record<string, unknown>;
	if ((decision !== "allow" && decision !== "escalate") || typeof reason !== "string" || !reason.trim()) return;
	return { decision, reason: reason.trim() };
}

/** Bound the wait even if a provider or credential resolver ignores its AbortSignal. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let onAbort: () => void = () => {};
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			}),
		]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export interface ReviewInput {
	call: PendingCall;
	prompt: string;
	policy: OperatorPolicy;
	environment: () => Promise<unknown>;
}

export async function review(
	ctx: ExtensionContext,
	input: ReviewInput,
	complete: CompleteReview,
	options: { signal?: AbortSignal; timeoutMs?: number; maxChars?: number; logFile?: string } = {},
): Promise<Verdict> {
	const started = Date.now();
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 45_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let request: string | undefined;
	const finish = async (verdict: Verdict): Promise<Verdict> => {
		if (options.logFile) {
			const row = { ts: new Date().toISOString(), ms: Date.now() - started, ...verdict, request };
			await appendFile(options.logFile, JSON.stringify(row) + "\n", { mode: 0o600 }).catch(() => {});
		}
		return verdict;
	};
	try {
		signal.throwIfAborted();
		if (input.policy.error) return finish({ decision: "escalate", reason: input.policy.error });
		const system = input.policy.text
			? `${SYSTEM_PROMPT}\n\n# Operator policy\nTrusted policy captured at session start; it refines the rules above.\n\n${input.policy.text}`
			: SYSTEM_PROMPT;
		const maxChars = options.maxChars ?? MAX_REVIEW_CHARS;
		const transcript = buildTranscript(ctx.sessionManager.getBranch());
		const users = transcript.filter(entry => entry.role === "user");
		const totalTools = transcript.length - users.length;
		const envelope = {
			transcript: users,
			history: { total_tool_calls: totalTools, omitted_tool_calls: totalTools },
			environment: undefined as unknown,
			pending_call: input.call,
			approval_prompt: input.prompt,
		};
		// User restrictions, policy and the pending payload are never summarized or clipped.
		if (JSON.stringify(envelope).length + system.length > maxChars) {
			return finish({ decision: "escalate", reason: "user instructions, policy or pending call exceed the input budget; protected context was not truncated" });
		}
		envelope.environment = await abortable(input.environment(), signal);
		if (JSON.stringify(envelope).length + system.length > maxChars) {
			return finish({ decision: "escalate", reason: "environment and protected review context exceed the input budget; protected context was not truncated" });
		}
		// Retain whole recent calls, never fragments. Stop at the first oversized call
		// rather than skipping it and presenting older evidence as the latest history.
		const selected = new Set<number>();
		let remaining = maxChars - system.length - JSON.stringify(envelope).length;
		for (let i = transcript.length - 1; i >= 0 && selected.size < 24; i--) {
			if (transcript[i].role !== "tool_call") continue;
			const size = JSON.stringify(transcript[i]).length + 1;
			if (size > remaining) break;
			selected.add(i);
			remaining -= size;
		}
		envelope.transcript = transcript.filter((entry, i) => entry.role === "user" || selected.has(i));
		envelope.history.omitted_tool_calls = totalTools - selected.size;
		request = JSON.stringify(envelope);
		const reply = await abortable(complete(ctx, system, request, signal), signal);
		signal.throwIfAborted();
		if (reply.stopReason !== "stop") {
			return finish({ decision: "escalate", reason: `reviewer did not finish: ${reply.errorMessage ?? reply.stopReason}`, model: reply.model });
		}
		const verdict = parseVerdict(reply.text);
		return finish(verdict
			? { ...verdict, model: reply.model }
			: { decision: "escalate", reason: "reviewer reply was not a valid verdict", model: reply.model });
	} catch (error) {
		if (options.signal?.aborted) throw error;
		const why = timeout.aborted ? "timed out" : error instanceof Error ? error.message : String(error);
		return finish({ decision: "escalate", reason: `reviewer failed: ${why}` });
	}
}
