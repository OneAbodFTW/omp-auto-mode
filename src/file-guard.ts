import { lstat, readlink, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

export interface FileGuardOptions {
	cwd: string;
	home: string;
	protectedPaths: string[];
	inspectEdits: (input: Record<string, unknown>) => string[];
}

function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve existing ancestors AND dangling symlinks before judging a new write target. */
export async function canonicalize(target: string, remainingLinks = 40): Promise<string> {
	if (remainingLinks <= 0) throw new Error("too many symbolic links");
	try { return await realpath(target); } catch (error) {
		if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
	try {
		if ((await lstat(target)).isSymbolicLink()) {
			return canonicalize(path.resolve(path.dirname(target), await readlink(target)), remainingLinks - 1);
		}
	} catch (error) {
		if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
	const parent = path.dirname(target);
	if (parent === target) throw new Error("cannot resolve filesystem root");
	return path.join(await canonicalize(parent, remainingLinks), path.basename(target));
}

function sensitive(target: string, home: string): boolean {
	const name = path.basename(target).toLowerCase();
	if (/^\.env(?:\.|$)/.test(name) && !/^\.env\.(example|sample|template)$/.test(name)) return true;
	if (/\.(pem|key|p12|pfx|keystore)$/.test(name)) return true;
	if (/^(agent\.db(?:-wal|-shm)?|auth.*\.json|\.?(bash|zsh|python|node_repl)_history|fish_history|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/.test(name)) return true;
	const privateRoots = [".aws", ".gnupg", ".azure", ".kube", ".config/gcloud", ".config/gh", ".omp"];
	if (privateRoots.some(root => isWithin(path.join(home, root), target))) return true;
	if (target === path.join(home, ".docker/config.json")) return true;
	if (isWithin(path.join(home, ".ssh"), target)) {
		return !name.endsWith(".pub") && !["known_hosts", "config"].includes(name);
	}
	return false;
}

async function localTarget(raw: string, options: FileGuardOptions, reading: boolean): Promise<{ lexical: string; canonical: string }> {
	if (!raw || !raw.trim()) throw new Error("file target is missing");
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new Error("non-filesystem target requires human review");
	let target = raw.replace(/^\[(.*)#[0-9a-f]{4}\]$/i, "$1");
	if (target === "~" || target.startsWith("~/")) target = options.home + target.slice(1);
	let lexical = path.resolve(options.cwd, target);
	if (reading) {
		try { await lstat(lexical); } catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			// OMP prefers an existing literal filename over a read selector.
			const withoutSelector = target.replace(/:(raw|img|\d+(?:[-+,]\d+)*)$/, "");
			if (withoutSelector === target && /[:?#]/.test(target)) throw new Error("unrecognized read selector");
			lexical = path.resolve(options.cwd, withoutSelector);
		}
	}
	return { lexical, canonical: await canonicalize(lexical) };
}

/** These checks route to the human; they never ask an LLM to waive a file guard. */
export async function fileGuardReason(
	name: string,
	input: unknown,
	options: FileGuardOptions,
): Promise<string | undefined> {
	const reading = name === "read" || name === "grep";
	if (!reading && !["write", "edit", "ast_edit", "notebook"].includes(name)) return;
	if (!input || typeof input !== "object" || Array.isArray(input)) return "file arguments could not be established";
	const args = input as Record<string, unknown>;
	// Public web reads retain OMP's existing behavior; this is not a network sandbox.
	if (name === "read" && typeof args.path === "string" && /^https?:\/\//i.test(args.path)) return;
	try {
		let targets: string[];
		if (name === "edit") {
			targets = options.inspectEdits(args);
		} else {
			const raw = args.path ?? args.notebook_path;
			targets = typeof raw === "string" ? [raw] : [];
		}
		if (!targets.length) return "file targets could not be established";
		for (const raw of targets) {
			if ((name === "grep" || name === "ast_edit") && /[*?\[\]{},\n]/.test(raw)) {
				return "content search or edit scope requires human review";
			}
			const { lexical, canonical } = await localTarget(raw, options, reading);
			const home = await canonicalize(options.home);
			if (reading) {
				const info = await stat(canonical).catch(error => {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					return undefined;
				});
				if (name === "read" && info?.isDirectory()) continue; // Names, not file contents.
				if (name === "grep" && (!info || !info.isFile())) return "content search scope can include secret files or could not be established";
				if (sensitive(lexical, options.home) || sensitive(canonical, home)) return "file contents may expose secrets or OMP credentials";
			} else {
				const cwd = await canonicalize(options.cwd);
				if (!isWithin(cwd, lexical) || !isWithin(cwd, canonical)) return "write target is outside the current project directory";
				for (const root of options.protectedPaths) {
					if (isWithin(path.resolve(root), lexical) || isWithin(await canonicalize(root), canonical)) {
						return "write target contains Auto Mode policy, configuration or extension code";
					}
				}
				if ([lexical, canonical].some(target => target.split(path.sep).some(part => [".git", ".omp", ".pi"].includes(part)))) return "write target changes repository or agent configuration";
				if (sensitive(lexical, options.home) || sensitive(canonical, home)) return "write target may contain secrets";
				if (name === "ast_edit" && (await stat(canonical)).isDirectory()) return "recursive edit targets require human review";
			}
		}
	} catch {
		return "file target could not be resolved safely";
	}
}
