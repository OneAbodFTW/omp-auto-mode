import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await exec("git", args, { cwd, timeout: 3_000, maxBuffer: 1 << 20 });
		return stdout.trim();
	} catch { return; }
}

export async function environmentFacts(cwd: string, remotes: string | undefined): Promise<unknown> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!root) return { cwd, repository: null, note: "Git recovery of file changes is not established." };
	const [branch, status] = await Promise.all([
		git(cwd, ["branch", "--show-current"]),
		git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]),
	]);
	return {
		cwd, repository: root, branch: branch ?? null, remotesAtSessionStart: remotes ?? null,
		status: status ?? null,
		note: "Status includes ignored paths. Neither a tracked path nor an empty status proves that overwriting it is safe. Missing metadata is not evidence of safety.",
	};
}
