# omp-auto-mode

Auto mode for [oh-my-pi](https://github.com/can1357/oh-my-pi). When omp asks you to approve a tool call, a reviewer model looks first:

- **allow**: the call runs without interrupting you, and a short note says why.
- **escalate**: the normal approval prompt opens, with the reviewer's reason added.

The reviewer can only allow. Every call it does not clearly allow comes back to you. File guards also ask you directly before sensitive file access, including calls OMP's approval mode would otherwise allow without a prompt.

This fork of [OneAbodFTW/omp-auto-mode](https://github.com/OneAbodFTW/omp-auto-mode) bounds historical tool evidence without clipping user restrictions or pending calls. It also preserves OMP's paused handler budget while a file-guard dialog waits for the user.

## Install

```sh
omp plugin install github:lialzm/omp-auto-mode
```

Needs omp 18.12.6 or newer. Auto mode reviews the prompts omp already raises, so use an approval mode that asks, for example:

```yaml
# ~/.omp/agent/config.yml
tools:
  approvalMode: write
```

`write` mode still allows ordinary project file reads and writes without model review. The file guards below run independently of that tier setting. To review other file calls too, set OMP's per-tool `tools.approval.<tool>` setting to `prompt`. An existing OMP policy may request a second approval after a file-guard approval; neither layer overrides a deny rule.

## File guards

In sessions with an approval UI, these go straight to you, without asking the reviewer model:

- File reads that target known secret paths, such as `.env`, private keys, credential stores and OMP state. Public key files, `.env.example` / `.env.sample` / `.env.template`, and the exact `~/.omp/plugins/package.json` dependency manifest are excluded. Symlinks to secret files remain guarded. Reading a directory's filenames remains allowed.
- Writes outside the current working directory unless explicitly covered by a session directory grant, writes to agent/repository configuration, and writes to Auto Mode's installed source or active agent directory. The policy file is protected even if it is inside the project.
- Content searches over directories or glob scopes, which may include secret files. Narrow searches of ordinary individual files remain allowed; filename-only `glob` calls are unaffected.
- File operations with unresolved targets or unsupported target formats. Edit targets and rename destinations are parsed with OMP's native edit parser.

Targets are checked lexically and after resolving symlinks, including dangling links used for new files. **Approve** covers one call; cancelling or declining blocks it. Ordinary project-external writes also offer **Allow ordinary writes for this session: /exact/directory**. Only that explicit choice remembers the listed directories and their descendants for the current session; ordinary approvals never silently grant directory access. A new session or process clears those grants. `/tmp` is not automatically trusted.

Directory grants do not bypass sensitive-file checks, repository/agent configuration, protected plugin source, unresolved paths or native OMP policies. Root/home-wide grants and grants through symlink aliases are not offered. Paths are rechecked after confirmation and on each later call; a link escaping the granted directory or a retargeted directory root still requires approval. These guards check tool requests, not every filesystem operation: arbitrary extensions, shell commands and subprocesses still need an OS sandbox for confinement.

File guards use the current event's scoped dialog, so time spent waiting for the user does not consume OMP's 30-second extension-handler execution budget.

## What gets allowed

- **Read-only calls** anywhere on the machine (reading, listing, searching, `git status/log/diff`, `--version`, public HTTP GETs), unless they would expose secrets such as `.env` files, private keys, cloud or registry credentials, tokens or shell history.
- **Calls that serve what you asked for** and stay easy to undo: changes to git-tracked files, builds, tests, caches, local dev servers, project-local installs.
- **Calls you explicitly asked for**, by action and target ("push main", "delete the .log files").

Everything else escalates: pushes, publishing, deploys, sending messages, `sudo`, deleting untracked or uncommitted work, anything outside the project, targets the reviewer cannot verify, and anything it is unsure about. Clearly harmful calls are flagged with `DANGER:`.

Always handed to you without asking the model:

- bash commands omp flags as a critical pattern;
- provider computer-use safety checks.

If the reviewer fails (no model, no API key, timeout, unreadable or incomplete reply), the prompt comes to you. A provider that ignores cancellation is still bounded by the review timeout.

OMP's prompt does not include a call ID and can abbreviate arguments. Auto Mode correlates approval events with the original persisted tool call and supplies its complete arguments to the reviewer. Approvals without a matching call, and concurrent approvals for the same tool that cannot be distinguished, always go to you. Critical patterns and provider safety checks retain their mandatory human path.

A model approval covers that one call only. The model never grants session permissions; directory grants above require an explicit human choice.

## What the reviewer sees

- Complete text from your messages on the current session branch. Agent-generated and synthetic messages are left out; images are not sent to the reviewer.
- Up to 24 of the most recent attempted non-read tool calls, with complete arguments, fitting the remaining input budget. The request reports total and omitted call counts. A historical call does not prove successful execution.
- Facts gathered by the extension itself: working directory, repo root, branch, git remotes captured at session start, and `git status` including ignored paths. Git metadata is data, not trusted instructions or proof that overwriting a file is safe.
- The exact pending tool name and arguments, plus OMP's human-readable approval prompt. Comments and heredocs are preserved.

The request is serialized as JSON so strings cannot create fake transcript roles. It excludes agent prose and tool results, but arguments and repository metadata remain potential prompt-injection inputs. Model review is not a security boundary.

The system prompt and request together are bounded to 60,000 characters. All user messages on the current branch, the operator policy, environment evidence and the exact pending call are retained intact. Historical tool calls fill the remaining budget newest-first; if the next call does not fit, selection stops rather than showing fragments or skipping to older calls.

Omitted tool calls are explicitly marked as unknown evidence. The reviewer must ask you if the pending action depends on missing history, such as the contents of a previously written script. Self-contained read-only operations can still be reviewed in tool-heavy long sessions. If user messages, policy, environment or the pending call alone exceed the budget, Auto Mode still asks you; it never silently drops a user restriction or clips executable code.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `OMP_AUTO_MODE_MODEL` | `anthropic/claude-sonnet-5-5` | Reviewer model: a model selector or role alias. Falls back to the session model when it cannot be resolved. |
| `OMP_AUTO_MODE_LOG` | unset | Path to a `.jsonl` file. Each review appends its full request, verdict, model and latency. New files use mode `0600`. Logs can contain sensitive user text and arguments. |
| `auto-mode-policy.md` in the active agent directory | absent | Your own rules, captured once at session start and appended as trusted operator policy. Defaults to `~/.omp/agent/auto-mode-policy.md`; respects OMP profiles and `PI_CODING_AGENT_DIR`. |

Example policy:

```md
- Pushing to my own feature branches (anything except main) is fine without asking.
- Never allow anything that touches ~/work/prod-infra.
```

Policy changes take effect in a new session or after reloading the extension. A missing file means no extra policy. An unreadable policy disables automatic approvals for that session. A tool call cannot rewrite the file and change the current session's snapshot.

## Scope

- Interactive sessions only. Headless runs and subagents have no approval UI and keep omp's normal behaviour.
- `cfg://` setting changes use a separate approval path and are not reviewed.
- Works alongside Herdr: the pane shows as blocked only while a prompt is actually waiting for you, not while the reviewer decides.
- Requires trusted peer extensions. It cannot constrain an extension's own I/O or guarantee checks after another extension revises an already inspected file request.
- Network access is unaffected. A launcher such as an OMP adaptation of `pi-safe` provides a separate filesystem boundary; Auto Mode approval does not change its mount permissions.

## Development

```sh
bun test
bun run check
```

Tests use fake model completions and temporary files; no API keys or model requests are needed. `check` builds the extension with host-provided OMP packages left external. Runtime compatibility should also be checked in OMP when changing approval hooks or native edit parsing.

To develop this fork, clone it outside `~/.omp` (that directory is protected agent state), then link the checkout:

```sh
git clone https://github.com/lialzm/omp-auto-mode.git
cd omp-auto-mode
bun test
bun run check
omp plugin install "$PWD"
```

The link loads local source changes in new OMP processes. Existing sessions retain their loaded code until their extensions are reloaded or the OMP process is restarted. Do not run the original and modified reviewers together. Before replacing an installation, keep a copy of its directory; `omp plugin install /absolute/path/to/backup` switches back without changing approval rules.

### 0.1.2

- Offer explicit session-scoped directory permission for ordinary external writes, without changing the meaning of one-call approval or bypassing sensitive paths and native policies.
- Allow reading the exact plugin dependency manifest without treating all OMP state as public.

### 0.1.1

- Bound historical tool evidence while preserving every user instruction and complete pending payload; include omission counts and require escalation when omitted evidence matters.
- Count the system prompt in the input budget and distinguish oversized protected context from oversized environment evidence.
- Route file-guard questions through OMP's handler-scoped dialog, allowing human answers after more than 30 seconds.


## License

MIT
