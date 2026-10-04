---
name: thread-tags
description: Read or set the tag on a bb thread (the colored emoji/text badge left of the thread title in the sidebar) with the `bb thread-tags` CLI. Use when the user asks to tag, label, mark, or untag a thread, or to create, list, or delete thread tags.
---

# Thread tags

The Thread Tags plugin keeps one configurable set of tags. A tag is an emoji or
short text (up to 12 characters) on a colored background. Each thread has at
most one tag. The tag shows as a badge left of the thread's title in the bb
sidebar. Users apply tags from the tag button in a row's hover controls. They
edit the tag set on the plugin's settings page.

## Commands

`--thread <id>` defaults to the thread the command runs in. A `<tag>` is a tag
id or its exact label, and the label match ignores case.

| Command | Effect |
| --- | --- |
| `bb thread-tags list` | List tags as `id  label  color`. |
| `bb thread-tags get [--thread <id>]` | Show a thread's tag. |
| `bb thread-tags set <tag> [--thread <id>]` | Tag a thread. It replaces any existing tag. |
| `bb thread-tags clear [--thread <id>]` | Remove a thread's tag. |
| `bb thread-tags create <label> --color <#rrggbb>` | Create a tag. |
| `bb thread-tags delete <tag>` | Delete a tag and remove it from every thread. |

Add `--json` for machine-readable output.

## Guidance

- Run `list` before `set`, and use an existing tag. Create a tag only when the
  user asks for a new one.
- Do not delete tags unless the user asks. Deleting a tag removes it from every
  thread.
