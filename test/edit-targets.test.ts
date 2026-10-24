import { expect, test } from "bun:test";
import { inspectEditTargets } from "../src/edit-targets.ts";

test("uses parsed targets and move destinations, including when a spare path claims safety", () => {
	const input = { path: "safe.ts", input: "[real.ts#abcd]\nMV ../outside.ts" };
	const targets = inspectEditTargets(input, (mode, raw) => {
		expect(JSON.parse(raw)).toEqual(input);
		if (mode !== "hashline") throw new Error("wrong edit grammar");
		return { paths: ["real.ts"], fileOps: [{ path: "real.ts", kind: "move", to: "../outside.ts" }] };
	});
	expect(targets).toEqual(["real.ts", "../outside.ts"]);
	expect(targets).not.toContain("safe.ts");
});

test("does not invent a target when all native parsers reject a payload", () => {
	expect(inspectEditTargets({ input: "unknown" }, () => { throw new Error("unsupported"); })).toEqual([]);
});
