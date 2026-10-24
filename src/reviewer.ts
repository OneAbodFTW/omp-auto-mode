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
		const transcript = buildTranscript(ctx.sessionManager.getBranch());
		request = JSON.stringify({ transcript, pending_call: input.call, approval_prompt: input.prompt });
		const maxChars = options.maxChars ?? MAX_REVIEW_CHARS;
		// Never drop a user restriction or hide part of a command to fit a budget.
		if (request.length + input.policy.text.length > maxChars) {
			return finish({ decision: "escalate", reason: "complete review context exceeds the input budget; nothing was truncated" });
		}
		request = JSON.stringify({ transcript, environment: await abortable(input.environment(), signal), pending_call: input.call, approval_prompt: input.prompt });
		if (request.length + input.policy.text.length > maxChars) {
			return finish({ decision: "escalate", reason: "complete review context exceeds the input budget; nothing was truncated" });
		}
		const system = input.policy.text
			? `${SYSTEM_PROMPT}\n\n# Operator policy\nTrusted policy captured at session start; it refines the rules above.\n\n${input.policy.text}`
			: SYSTEM_PROMPT;
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
