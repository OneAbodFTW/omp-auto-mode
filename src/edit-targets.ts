interface Inspection {
	paths: string[];
	fileOps: { path: string; kind: string; to?: string | null }[];
}

/** Union OMP's supported parsers, including move destinations, rather than trusting spare path fields. */
export function inspectEditTargets(
	input: Record<string, unknown>,
	inspect: (mode: string, json: string) => Inspection,
): string[] {
	const targets = new Set<string>();
	for (const mode of ["replace", "patch", "hashline", "apply_patch", "sloppy"]) {
		try {
			const result = inspect(mode, JSON.stringify(input));
			for (const target of result.paths) targets.add(target);
			for (const operation of result.fileOps) {
				targets.add(operation.path);
				if (operation.kind === "move" && operation.to) targets.add(operation.to);
			}
		} catch { /* Unknown input formats require human review. */ }
	}
	return [...targets];
}
