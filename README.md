# bb-plugin-thread-tags

Tag bb threads with a colored badge, an emoji or short text, shown left of the
thread title in the sidebar.

- **Apply a tag:** hover a thread in the sidebar and click the tag button,
  beside Archive and ⋯. Pick a tag, remove the current one, or create a new tag
  with an emoji or text (≤ 12 characters) and a color. Click the smiley next to
  the label field to pick from every emoji, by category or by search in English
  or Russian. Each thread has at most one tag.
- **Manage tags:** click the gear in the tag picker, or open Settings → Thread
  Tags → Tags. Edit a tag's label and color, or delete it after an inline
  confirmation. Deleting a tag removes it from every thread.
- **CLI / agents:** `bb thread-tags list | get | set <tag> | clear | create <label> --color <#rrggbb> | delete <tag>`.
  See `skills/thread-tags/SKILL.md`.

## How it works

- `server.ts` stores the tag set and the thread → tag assignments in
  `bb.storage.kv`. It exposes RPC methods and the CLI, and publishes
  `tags-changed` over realtime after each write. It also drops assignments when
  a thread is deleted.
- `app.tsx` registers an always-mounted `experimental_appOverlay`. The overlay
  watches the sidebar DOM for rows
  (`a[data-sidebar-thread-id][data-sidebar-thread-shortcut-target]`). It inserts
  a badge before `.bb-thread-title` and a tag button into
  `[data-sidebar-row-controls]`. It renders the picker as a popover anchored to
  the clicked button. Every injected node carries a `data-thread-tags-*`
  attribute and is removed on unmount.
- The tag editor is a `settingsSection`.

The row markup (`.bb-thread-title`, `[data-sidebar-row-controls]`) belongs to
bb's bundled `thread-list` plugin, not to the public SDK. A bb update that
changes it can hide the badge or the button until this plugin is updated.

## Emoji data

`lib/emoji-data.ts` is generated from `emojibase-data`, a devDependency. It
holds every emoji with its English and Russian search words and is bundled
into the app, so the picker works offline. Regenerate it with
`npm run gen:emoji`.

## Develop

```
npm install --include=dev
bb plugin install .
bb plugin dev          # rebuild + reload on save
```
