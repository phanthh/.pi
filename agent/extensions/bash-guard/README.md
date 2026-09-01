# bash-guard (pi extension)

Intercepts agent-issued `bash` tool calls. Protection depends on session type: subagents get a
headless hard-block (on by default), the main session runs unguarded (off by default) with a
small irreversible-op floor and an opt-in interactive prompt.

## Modes

Mode picked at registration from env: `PI_SUBAGENT_DEPTH` >= 1 or `PI_SUBAGENT_ID` set (injected by
tmux-subagents) => subagent, else main session.

| Session | Default | Behaviour |
|---|---|---|
| Subagent (worker/scout/delegate/...) | guard ON | headless hard-block of catastrophic patterns, no prompting |
| Main (master/orchestrator) | guard OFF | pass-through, minus a small irreversible-op floor |

### Main session (master/orchestrator) — disabled by default

- Starts disabled: routine commands (incl. `git`, `rm -r`, `sudo`, `curl | sh`) run unblocked
- Floor still hard-blocks machine-level destruction: `mkfs*`, `newfs_*`, `wipefs`,
  `diskutil erase/...`, `dd of=/dev/...`, `parted|fdisk|gdisk|sgdisk`, `cryptsetup`, `zpool`,
  `shutdown|reboot|halt|poweroff`, `terraform destroy`, `kubectl delete`, `aws s3 rm --recursive`
- `/bash-guard` toggles interactive mode on; `--bash-guard-enabled` starts enabled
- Status badge ` ⚠ BG OFF ` shows while disabled

### Main session, guard enabled — interactive prompt

- Heuristically detects destructive/questionable commands via shell-aware parsing
- Prompts for **any** `git ...` command (escalates severity for especially risky ones: `git rm`,
  `git reset --hard`, `git clean -fdx`, `git push --force`, `git reflog expire`, `git gc --prune`)
- Prompts for disk/volume tooling: `diskutil`, `hdiutil`, `mkfs*`, `newfs_*`, `wipefs`, `parted`,
  `fdisk`, `gdisk/sgdisk`, `cryptsetup`, `pvcreate/vgcreate/lvcreate`, `zpool`, `lsblk`
- Prompts for: `rm`/`rmdir`/`unlink`, `sudo`, `find -delete`, `dd`, `truncate`, `sed -i`,
  `perl -pi`, `chmod/chown -R`, `mv/cp --force`, `kill`/`pkill`/`killall`, `shutdown`/`reboot`,
  `systemctl stop/disable`, `curl|sh`/`wget|sh`, `kubectl delete`, `terraform destroy`,
  `aws s3 rm --recursive`, `gcloud delete`, shell redirections (`>`, `>>`, `2>`), pipes
- Shows a 2-option dialog: **Run** / **Abort**
- If aborted, the tool call is blocked and the model receives a clear reason
- Remembers recently aborted commands for 60 s to prevent retry loops

### Subagent — headless hard-block (default ON)

Subagents run unattended in tmux panes, so prompting is useless. A focused set of catastrophic/unrecoverable operations is hard-blocked with no user interaction:

| Pattern | Reason |
|---|---|
| `rm -r` / `-rf` / `-Rf` | Recursive deletion |
| `sudo` | Elevated privileges |
| `curl\|sh`, `wget\|sh` | Pipe to shell (remote code execution) |
| `mkfs*`, `newfs_*` | Filesystem formatting |
| `wipefs` | Disk signature wipe |
| `diskutil erase/zeroDisk/secureErase/reformat` | Destructive disk operation |
| `dd of=/dev/…` | Raw disk write |
| `parted`, `fdisk`, `gdisk`, `sgdisk` | Partition table management |
| `cryptsetup` | Disk encryption management |
| `zpool` | ZFS pool management |
| `shutdown`, `reboot`, `halt`, `poweroff` | System power operation |
| `terraform destroy` | Infrastructure teardown |
| `kubectl delete` | Kubernetes resource deletion |
| `aws s3 rm --recursive` | Bulk S3 deletion |
| `git commit` | Main-session operation |
| `git pull` | Main-session operation |
| `git push` | Main-session operation |
| `git reset --hard` | Discard all uncommitted changes |
| `git clean -f` | Delete untracked files |
| `git reflog expire` | Remove recovery history |
| `git gc --prune` | Prune unreachable objects |

All other commands (including routine git operations) pass through unaffected.

## Install

Auto-discovered from `~/.pi/agent/extensions/bash-guard/`. Run `/reload` in pi.

## Notes

- Scope: `bash` tool calls only (`write`/`edit` and user `!` commands are not intercepted).
- `--bash-guard-auto-allow`: main-session flag that allows flagged commands when there is no UI
  (e.g. running pi non-interactively). Has no effect in subagent sessions.
- `--bash-guard-enabled`: start the main session with interactive prompting on.
