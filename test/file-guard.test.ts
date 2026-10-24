import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { canonicalize, fileGuardReason, type FileGuardOptions } from "../src/file-guard.ts";

let root: string;
let options: FileGuardOptions;
beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "auto-mode-files-"));
	options = { cwd: path.join(root, "project"), home: path.join(root, "home"), protectedPaths: [path.join(root, "project", "policy.md")], inspectEdits: input => typeof input.path === "string" ? [input.path] : [] };
	await mkdir(options.cwd);
	await mkdir(options.home);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("file tool guards", () => {
	test("ordinary project reads and writes remain automatic", async () => {
		await writeFile(path.join(options.cwd, "app.ts"), "example");
		expect(await fileGuardReason("read", { path: "app.ts" }, options)).toBeUndefined();
		expect(await fileGuardReason("write", { path: "new/deep/app.ts" }, options)).toBeUndefined();
	});

	test("sensitive reads, selectors, and public key exceptions", async () => {
		await writeFile(path.join(options.cwd, ".env"), "dummy");
		expect(await fileGuardReason("read", { path: ".env:1-20" }, options)).toContain("secrets");
		expect(await fileGuardReason("read", { path: ".env.example" }, options)).toBeUndefined();
		await mkdir(path.join(options.home, ".ssh"));
		await writeFile(path.join(options.home, ".ssh/id_rsa"), "dummy");
		await writeFile(path.join(options.home, ".ssh/id_rsa.pub"), "public");
		expect(await fileGuardReason("read", { path: "~/.ssh/id_rsa" }, options)).toContain("secrets");
		expect(await fileGuardReason("read", { path: "~/.ssh/id_rsa.pub" }, options)).toBeUndefined();
	});

	test("resolves a harmless-looking link to a secret", async () => {
		await writeFile(path.join(options.cwd, ".env"), "dummy");
		await symlink(".env", path.join(options.cwd, "innocent.txt"));
		expect(await fileGuardReason("read", { path: "innocent.txt" }, options)).toContain("secrets");
	});

	test("guards outside writes and sibling paths with the same prefix", async () => {
		expect(await fileGuardReason("write", { path: "../outside.txt" }, options)).toContain("outside");
		expect(await fileGuardReason("write", { path: options.cwd + "-other/file.txt" }, options)).toContain("outside");
	});

	test("protects policy/config writes inside the project too", async () => {
		expect(await fileGuardReason("write", { path: "policy.md" }, options)).toContain("policy");
		expect(await fileGuardReason("write", { path: ".git/config" }, options)).toContain("configuration");
		expect(await fileGuardReason("write", { path: ".omp/config.yml" }, options)).toContain("configuration");
	});

	test("an innocuous alias to repository configuration still requires human review", async () => {
		await mkdir(path.join(options.cwd, ".git"));
		await writeFile(path.join(options.cwd, ".git/config"), "dummy");
		await symlink(".git/config", path.join(options.cwd, "ordinary.txt"));
		expect(await fileGuardReason("write", { path: "ordinary.txt" }, options)).toContain("configuration");
	});

	test("follows existing and dangling symlinks for new write paths", async () => {
		await symlink(options.home, path.join(options.cwd, "outside"));
		await symlink(path.join(options.home, "missing"), path.join(options.cwd, "dangling"));
		expect(await fileGuardReason("write", { path: "outside/new.txt" }, options)).toContain("outside");
		expect(await canonicalize(path.join(options.cwd, "dangling/new.txt"))).toBe(path.join(options.home, "missing/new.txt"));
		expect(await fileGuardReason("write", { path: "dangling/new.txt" }, options)).toContain("outside");
	});

	test("a link loop requires human review", async () => {
		await symlink("loop", path.join(options.cwd, "loop"));
		expect(await fileGuardReason("write", { path: "loop/file" }, options)).toContain("resolved safely");
	});

	test("checks all parsed edit targets, including move destinations", async () => {
		options.inspectEdits = () => ["safe.ts", "../outside.ts"];
		expect(await fileGuardReason("edit", { path: "safe.ts", input: "untrusted patch" }, options)).toContain("outside");
		options.inspectEdits = () => [];
		expect(await fileGuardReason("edit", { input: "unknown format" }, options)).toContain("established");
	});

	test("guards broad content searches while allowing filename listings", async () => {
		expect(await fileGuardReason("grep", { path: options.cwd, pattern: "TOKEN" }, options)).toContain("secret files");
		expect(await fileGuardReason("grep", { path: "**/*.ts", pattern: "TOKEN" }, options)).toContain("scope");
		expect(await fileGuardReason("glob", { path: "~/.ssh/*" }, options)).toBeUndefined();
		expect(await fileGuardReason("grep", { path: "missing-or-compound-scope", pattern: "TOKEN" }, options)).toBeDefined();
	});

	test("does not interpret unsupported local URLs or selector forms as safe paths", async () => {
		expect(await fileGuardReason("read", { path: "local://host/.env" }, options)).toBeDefined();
		expect(await fileGuardReason("read", { path: ".env:unknown-selector" }, options)).toBeDefined();
	});
});
