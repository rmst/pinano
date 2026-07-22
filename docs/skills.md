# Skills

Pinano can load reusable task instructions from local skill folders. A skill is a directory containing a `SKILL.md` file with YAML frontmatter followed by Markdown instructions.

```markdown
---
name: review
description: Review code changes and surface concrete risks.
---

Use this workflow when reviewing a patch...
```

`name` defaults to the skill directory name when omitted. `description` is optional, but it should be short enough to help the model decide when the skill applies.

## Locations

Pinano scans these roots for `SKILL.md` files:

- `.agents/skills` under the current cwd and its ancestors
- `$PINANO_HOME/skills`
- `~/.agents/skills`

Skill folders may contain supporting files such as `scripts/`, `references/`, and `assets/`. Pinano does not load those files automatically; the model sees the skill path and reads or runs only what the skill asks for using the normal tools.

## Use

Mention a skill by name in the prompt, either as `$skill-name` or plain text. Pinano injects the matching `SKILL.md` body into model context for that turn. Pinano also shows the model an available-skills index so it can open and read a listed `SKILL.md` completely when the task clearly matches a skill description.

Skills are not tools and are not slash commands. They are model context plus ordinary file access.
