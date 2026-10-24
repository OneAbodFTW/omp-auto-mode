/** Reviewer inputs are JSON data. No shell parsing, comment stripping or clipping. */
export interface PendingCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface TranscriptEntry {
	role: "user" | "tool_call";
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface MessageEntry {
	type: string;
	message?: {
		role: string;
		synthetic?: boolean;
		attribution?: string;
		content?: string | readonly { type: string; text?: string; id?: string; name?: string; arguments?: unknown }[];
	};
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "find", "web_search", "todo", "wait", "ask", "recall"]);

export function buildTranscript(entries: readonly MessageEntry[]): TranscriptEntry[] {
	const transcript: TranscriptEntry[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "user") {
			if (message.synthetic || message.attribution === "agent") continue;
			const text = typeof message.content === "string"
				? message.content
				: (message.content ?? []).filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
			if (text) transcript.push({ role: "user", text });
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "toolCall" || !block.name || READ_ONLY_TOOLS.has(block.name)) continue;
				transcript.push({ role: "tool_call", name: block.name, arguments: block.arguments });
			}
		}
	}
	return transcript;
}

/** Read the persisted call at approval time, after OMP applies input revisions. */
export function findPendingCall(entries: readonly MessageEntry[], id: string, name: string): PendingCall | undefined {
	const matches: PendingCall[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall" || block.id !== id || block.name !== name) continue;
			if (!block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments)) return;
			matches.push({ id, name, arguments: block.arguments });
		}
	}
	// Duplicate IDs or a call absent from the transcript cannot identify an approval safely.
	return matches.length === 1 ? JSON.parse(JSON.stringify(matches[0])) : undefined;
}
