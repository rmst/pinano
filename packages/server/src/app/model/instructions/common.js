import { dedent } from "./dedent.js"

export const MANAGED_WORKTREE_INSTRUCTIONS = dedent`
	## Cerex-Managed Worktrees

	For non-trivial implementation work in a Git repo, consider using a Cerex-managed short-lived worktree.

	For short-lived independent Git worktrees whose changes should eventually be applied to an integration branch, use \`cerex-worktree-add\` instead of \`git worktree add\`:

	\`cerex-worktree-add <name> --integration-target <target-branch>\`

	It creates \`$REPO_ROOT/.cerex/wt/<name>\` by default and copies ignored working files, using copy-on-write when supported. Use \`-b <branch>\` to choose the worktree branch name, \`--path <path>\` only when a specific location is needed, and \`--no-copy\` when copied ignored files would be undesirable.

	Do not switch branches inside a Cerex-managed worktree; create a new worktree instead.

	In a Cerex-managed short-lived worktree, once your own changes for the task are in a reviewable state and could plausibly be merged, package them into one or more local commits before handing the work back, unless the user or project instructions say not to commit.

	Commit only your own task changes. Do not include unrelated or user-made changes, do not push, and do not merge or cherry-pick into the integration target unless explicitly asked. If you leave a Cerex-managed worktree dirty after finishing, explain why.

	After its changes are integrated or abandoned, run \`cerex-worktree-close --applied\` or \`cerex-worktree-close --discarded\` from inside it.

	For long-lived branch checkouts, branch exploration, or worktrees with no integration target, use normal Git or ask before creating one.`

export const SESSION_INSTRUCTIONS = dedent`
	## Cerex Session Updates

	The current Cerex session id is available as \`$CEREX_SESSION\`. Use \`cerex session ...\` to update Cerex session properties. Use \`cerex session --id <id> ...\` to target another session.

	Update Cerex session properties only when needed. Never set properties whose values should remain unchanged! The \`description\` property is checked after every turn during an automated session metadata check, so it usually shouldn't be updated otherwise. Change \`project-dir\` only when unset and clear, clearly wrong, or the user asks; prefer the stable main project root, not a short-lived worktree path, and avoid late changes.

	Session properties:
	- \`description\`: Short stable label for the session shown in the UI, ideally 6-12 words. Don't include minutiae. It must capture the overarching long-term goal(s) of the entire session not just the most recent goal.
	- \`project-dir\`: Absolute directory used for project identity and project metadata lookup. Prefer the stable main project root, usually the repository root; when working in a short-lived worktree, keep/select the main repository root, not the worktree path. For renaming the project displayed for that directory, use \`cerex project set <name>\`; use lowercase unless the user requested otherwise.
	- \`cwd\`: Absolute working directory for subsequent tool calls, interpreted inside the selected environment.
	- \`environment\`: Configured environment id for subsequent tool calls. Switching to an environment with a configured cwd also switches cwd unless cwd is supplied explicitly.

	Multiple properties may be updated in one call by repeating property/value pairs.

	Examples:
	\`cerex session set description "Investigate test failure"\`
	\`cerex session set project-dir /absolute/project/root\`
	\`cerex session set cwd /absolute/path\`
	\`cerex session set environment local\`

	Transcript inspection:
	- \`cerex session --id <id> cat\` prints another session's compact visible transcript. Run \`cerex session cat --help\` for entry/range drill-down and full tool details.
	- \`cerex sessions\` lists visible sessions.
	- \`cerex sessions cat --state ready-for-review | rg needle\` searches a filtered set of compact visible transcripts. \`cerex sessions cat\` requires \`--all\`, \`--state\`, \`--since\`, or \`--limit\`.`
