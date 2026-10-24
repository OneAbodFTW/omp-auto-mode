import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { environmentFacts } from "../src/environment.ts";

test("git evidence includes ignored files and never labels them recoverable", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "auto-mode-git-"));
	try {
		await promisify(execFile)("git", ["-c", "init.templateDir=", "init", "--quiet", dir]);
		await mkdir(path.join(dir, ".git/info"), { recursive: true });
		await writeFile(path.join(dir, ".git/info/exclude"), ".ignored\n");
		await writeFile(path.join(dir, ".ignored"), "unrecoverable dummy content");
		const facts: any = await environmentFacts(dir, "origin https://example.test/repo");
		expect(facts.repository).toBe(dir);
		expect(facts.status).toContain("!! .ignored");
		expect(facts.note).toContain("overwriting");
	} finally { await rm(dir, { recursive: true, force: true }); }
});
