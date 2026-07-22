import { dedent } from "./dedent.js"

export const PINANO_MANAGED_WORKTREE_INSTRUCTIONS = dedent`
	## Pinano-Managed Worktrees

	For non-trivial implementation work in a Git repo, consider using a Pinano-managed short-lived worktree.

	For short-lived independent Git worktrees whose changes should eventually be applied to an integration branch, use \`pinano-worktree-add\` instead of \`git worktree add\`:

	\`pinano-worktree-add <name> --integration-target <target-branch>\`

	It creates \`$REPO_ROOT/.pinano/wt/<name>\` by default and copies ignored working files, using copy-on-write when supported. Use \`-b <branch>\` to choose the worktree branch name, \`--path <path>\` only when a specific location is needed, and \`--no-copy\` when copied ignored files would be undesirable.

	Do not switch branches inside a Pinano-managed worktree; create a new worktree instead.

	In a Pinano-managed short-lived worktree, once your own changes for the task are in a reviewable state and could plausibly be merged, package them into one or more local commits before handing the work back, unless the user or project instructions say not to commit.

	Commit only your own task changes. Do not include unrelated or user-made changes, do not push, and do not merge or cherry-pick into the integration target unless explicitly asked. If you leave a Pinano-managed worktree dirty after finishing, explain why.

	After its changes are integrated or abandoned, run \`pinano-worktree-close --applied\` or \`pinano-worktree-close --discarded\` from inside it.

	For long-lived branch checkouts, branch exploration, or worktrees with no integration target, use normal Git or ask before creating one.`

export const PINANO_SESSION_INSTRUCTIONS = dedent`
	## Pinano Session Updates

	The current Pinano session id is available as \`$PINANO_SESSION\`. Use \`pinano session ...\` to update Pinano session properties. Use \`pinano session --id <id> ...\` to target another session.

	Update Pinano session properties only when needed. Never set properties whose values should remain unchanged! The \`description\` property is checked after every turn during an automated session metadata check, so it usually shouldn't be updated otherwise. Change \`project-dir\` only when unset and clear, clearly wrong, or the user asks; prefer the stable main project root, not a short-lived worktree path, and avoid late changes.

	Session properties:
	- \`description\`: Short stable label for the session shown in the UI, ideally 6-12 words. Don't include minutiae. It must capture the overarching long-term goal(s) of the entire session not just the most recent goal.
	- \`project-dir\`: Absolute directory used for project identity and project metadata lookup. Prefer the stable main project root, usually the repository root; when working in a short-lived worktree, keep/select the main repository root, not the worktree path. For renaming the project displayed for that directory, use \`pinano project set <name>\`; use lowercase unless the user requested otherwise.
	- \`cwd\`: Absolute working directory for subsequent tool calls, interpreted inside the selected environment.
	- \`environment\`: Configured environment id for subsequent tool calls. Switching to an environment with a configured cwd also switches cwd unless cwd is supplied explicitly.

	Multiple properties may be updated in one call by repeating property/value pairs.

	Examples:
	\`pinano session set description "Investigate test failure"\`
	\`pinano session set project-dir /absolute/project/root\`
	\`pinano session set cwd /absolute/path\`
	\`pinano session set environment local\`

	Transcript inspection:
	- \`pinano session --id <id> cat\` prints another session's compact visible transcript. Run \`pinano session cat --help\` for entry/range drill-down and full tool details.
	- \`pinano sessions\` lists visible sessions.
	- \`pinano sessions cat --state ready-for-review | rg needle\` searches a filtered set of compact visible transcripts. \`pinano sessions cat\` requires \`--all\`, \`--state\`, \`--since\`, or \`--limit\`.`
