# omp-auto-mode

Auto mode for [oh-my-pi](https://github.com/can1357/oh-my-pi). When omp asks you to approve a tool call, a reviewer model looks first:

- **allow**: the call runs without interrupting you, and a short note says why.
- **escalate**: the normal approval prompt opens, with the reviewer's reason added.

The reviewer can only allow. It never denies anything for you: every call it does not clearly allow comes back to you, so you stay in control.

## Install

```sh
omp plugin install github:OneAbodFTW/omp-auto-mode
```

Needs omp 18.11.3 or newer. Auto mode reviews the prompts omp already raises, so use an approval mode that asks, for example:

```yaml
# ~/.omp/agent/config.yml
tools:
  approvalMode: write
```

## What gets allowed

- **Read-only calls** anywhere on the machine (reading, listing, searching, `git status/log/diff`, `--version`, public HTTP GETs), unless they would expose secrets such as `.env` files, private keys, cloud or registry credentials, tokens or shell history.
- **Calls that serve what you asked for** and stay easy to undo: changes to git-tracked files, builds, tests, caches, local dev servers, project-local installs.
- **Calls you explicitly asked for**, by action and target ("push main", "delete the .log files").

Everything else escalates: pushes, publishing, deploys, sending messages, `sudo`, deleting untracked or uncommitted work, anything outside the project, targets the reviewer cannot verify, and anything it is unsure about. Clearly harmful calls are flagged with `DANGER:`.

Always handed to you without asking the model:

- bash commands omp flags as a critical pattern;
- provider computer-use safety checks.

If the reviewer fails (no model, no API key, timeout, unreadable reply), the prompt comes to you, so a broken reviewer behaves like plain `write` mode.

An approval covers that one call only. Auto mode never answers "allow for this session".

## What the reviewer sees

- Every message you typed this session. Agent-generated and synthetic messages are left out.
- The agent's non-read tool calls: tool name and arguments, with shell comments and the agent's stated intent removed.
- Facts gathered by the extension itself: working directory, repo root, branch, the git remotes present when the session started, and `git status` before commands that can discard work.
- The pending approval prompt.

It never sees the agent's prose or tool output, so instructions planted in files or command output cannot talk it into approving.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `OMP_AUTO_MODE_MODEL` | `anthropic/claude-sonnet-5-5` | Reviewer model: a model selector or role alias. Falls back to the session model when it cannot be resolved. |
| `OMP_AUTO_MODE_LOG` | unset | Path to a `.jsonl` file. Each review appends its request, verdict, model and latency. |
| `~/.omp/agent/auto-mode-policy.md` | absent | Your own rules, appended to the reviewer's instructions as trusted operator policy. |

Example policy:

```md
- Pushing to my own feature branches (anything except main) is fine without asking.
- Never allow anything that touches ~/work/prod-infra.
```

## Scope

- Interactive sessions only. Headless runs and subagents have no approval UI and keep omp's normal behaviour.
- `cfg://` setting changes use a separate approval path and are not reviewed.
- Works alongside Herdr: the pane shows as blocked only while a prompt is actually waiting for you, not while the reviewer decides.

## License

MIT
