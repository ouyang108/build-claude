---
name: example-skill
description: Explains the SKILL.md format, YAML frontmatter, and on-demand loading with the load_skill tool
tags: skill, skill-loader, SKILL.md, frontmatter, template, load_skill
---

# SKILL.md Format Guide

Use this skill when the user asks how skills are written, how `SKILL.md`
frontmatter works, how `load_skill` loads full skill content, or how to create a
new skill template.

## What This Skill Does

- Explains the required structure of a `SKILL.md` file
- Shows how YAML frontmatter becomes the short skill summary
- Explains why the full skill body is loaded only when needed
- Provides a small template for creating new skills

## When To Load This Skill

Load this skill when the request mentions:

- `SKILL.md`
- skill format
- skill frontmatter
- `load_skill`
- skill loading mechanism
- creating a new skill
- writing a skill template

Do not load this skill for ordinary coding tasks unless the user is asking about
the skill system itself.

## How Skills Are Used

1. Create a directory in `skills/` with your skill name
2. Add a `SKILL.md` file with frontmatter
3. Put the detailed instructions in the body
4. The system prompt lists only the skill name, description, and tags
5. The agent calls `load_skill` when it needs the full body

## Frontmatter Format

```yaml
---
name: skill-name
description: Short description shown in system prompt
tags: comma, separated, tags
---
```

The frontmatter is the lightweight index. It should be specific enough for the
agent to decide when the skill is relevant.

## Body Content

The body is the full skill content returned by `load_skill`, usually inside a
structured wrapper such as:

```xml
<skill name="skill-name">
Full skill instructions here.
</skill>
```

This keeps the system prompt small while still giving the agent detailed
knowledge when the task needs it.

## New Skill Template

```markdown
---
name: my-skill
description: Specific description of when this skill should be used
tags: relevant, searchable, keywords
---

# My Skill

Use this skill when ...

## Instructions

- Step or rule one
- Step or rule two
```
