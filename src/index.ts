// Auto Mode reviews OMP approvals. File guards supplement OMP's write mode;
// filesystem and network confinement remain the responsibility of an OS sandbox.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getAgentDir, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { editInspect } from "@oh-my-pi/pi-natives";
import { wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import installAutoMode from "./extension.ts";
import { inspectEditTargets } from "./edit-targets.ts";

export default function autoMode(pi: ExtensionAPI): void {
	installAutoMode(pi, {
		agentDir: getAgentDir,
		extensionRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
		inspectEdits: input => inspectEditTargets(input, editInspect),
		wrapText: wrapTextWithAnsi,
		complete: async (ctx, system, request, signal) => {
			const selector = process.env.OMP_AUTO_MODE_MODEL?.trim() || "anthropic/claude-sonnet-5-5";
			const model = ctx.models.resolve(selector) ?? ctx.models.current();
			if (!model) throw new Error("no reviewer model available");
			const sessionId = ctx.sessionManager.getSessionId();
			const reply = await completeSimple(model, {
				systemPrompt: [system], messages: [{ role: "user", content: request, timestamp: Date.now() }],
			}, {
				apiKey: ctx.modelRegistry.resolver(model, sessionId), sessionId,
				reasoning: Effort.Low, hideThinkingSummary: true, signal,
			});
			return {
				model: `${model.provider}/${model.id}`,
				text: reply.content.filter(block => block.type === "text").map(block => block.text).join("\n"),
				stopReason: reply.stopReason, errorMessage: reply.errorMessage,
			};
		},
	});
}
