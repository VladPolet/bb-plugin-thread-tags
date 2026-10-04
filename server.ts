// bb-plugin-thread-tags — backend entry.
//
// One configurable set of tags (an emoji or short text on a colored
// background) and at most one tag per thread. Both live in bb.storage.kv and
// serve three surfaces: the sidebar tag button and badges (app.tsx, over RPC),
// the tag editor on the plugin's settings page, and the `bb thread-tags` CLI
// that agents use (skills/thread-tags/SKILL.md). Every write publishes a
// realtime signal so every open client refetches.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const TAG_LABEL_MAX = 12;

const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb color")
  .transform((value) => value.toLowerCase());
const labelSchema = z.string().trim().min(1).max(TAG_LABEL_MAX);

const tagSchema = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string(),
});
export type Tag = z.infer<typeof tagSchema>;

const stateSchema = z.object({
  tags: z.array(tagSchema),
  /** threadId → tagId */
  assignments: z.record(z.string(), z.string()),
});
export type TagState = z.infer<typeof stateSchema>;

export const rpcContract = defineRpcContract({
  state_get: { input: z.null(), output: stateSchema },
  tag_create: {
    input: z.object({ label: labelSchema, color: colorSchema }),
    output: tagSchema,
  },
  tag_update: {
    input: z.object({ id: z.string(), label: labelSchema, color: colorSchema }),
    output: tagSchema,
  },
  tag_delete: {
    input: z.object({ id: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  thread_set_tag: {
    input: z.object({ threadId: z.string().min(1), tagId: z.string().nullable() }),
    output: z.object({ tagId: z.string().nullable() }),
  },
});

/** Realtime channel app.tsx listens on. */
const TAGS_CHANGED = "tags-changed";

const DEFAULT_TAGS: Tag[] = [
  { id: "urgent", label: "🔥", color: "#ef4444" },
  { id: "review", label: "👀", color: "#f59e0b" },
  { id: "blocked", label: "⛔", color: "#6b7280" },
  { id: "done", label: "✅", color: "#22c55e" },
];

export default async function plugin(bb: BbPluginApi) {
  async function readTags(): Promise<Tag[]> {
    return (await bb.storage.kv.get<Tag[]>("tags")) ?? DEFAULT_TAGS;
  }
  async function readAssignments(): Promise<Record<string, string>> {
    return (await bb.storage.kv.get<Record<string, string>>("assignments")) ?? {};
  }
  async function readState(): Promise<TagState> {
    return { tags: await readTags(), assignments: await readAssignments() };
  }
  function changed() {
    bb.realtime.publish(TAGS_CHANGED, {});
  }

  // Writes are serialized so two quick clicks cannot lose an update.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  const createTag = (label: string, color: string) =>
    serialized(async () => {
      const tag: Tag = { id: randomUUID().slice(0, 8), label, color };
      await bb.storage.kv.set("tags", [...(await readTags()), tag]);
      changed();
      return tag;
    });

  const updateTag = (id: string, label: string, color: string) =>
    serialized(async () => {
      const tags = await readTags();
      const tag = tags.find((candidate) => candidate.id === id);
      if (tag === undefined) return null;
      tag.label = label;
      tag.color = color;
      await bb.storage.kv.set("tags", tags);
      changed();
      return tag;
    });

  const deleteTag = (id: string) =>
    serialized(async () => {
      const tags = await readTags();
      const remaining = tags.filter((tag) => tag.id !== id);
      if (remaining.length === tags.length) return false;
      const assignments = await readAssignments();
      for (const [threadId, tagId] of Object.entries(assignments)) {
        if (tagId === id) delete assignments[threadId];
      }
      await bb.storage.kv.set("tags", remaining);
      await bb.storage.kv.set("assignments", assignments);
      changed();
      return true;
    });

  const setThreadTag = (threadId: string, tagId: string | null) =>
    serialized(async () => {
      if (tagId !== null && !(await readTags()).some((tag) => tag.id === tagId)) {
        throw new Error(`No tag with id ${tagId}`);
      }
      const assignments = await readAssignments();
      if ((assignments[threadId] ?? null) === tagId) return tagId;
      if (tagId === null) delete assignments[threadId];
      else assignments[threadId] = tagId;
      await bb.storage.kv.set("assignments", assignments);
      changed();
      return tagId;
    });

  bb.rpc.register(rpcContract, {
    state_get: () => readState(),
    tag_create: ({ label, color }) => createTag(label, color),
    tag_update: async ({ id, label, color }) => {
      const tag = await updateTag(id, label, color);
      if (tag === null) throw new Error(`No tag with id ${id}`);
      return tag;
    },
    tag_delete: async ({ id }) => ({ removed: await deleteTag(id) }),
    thread_set_tag: async ({ threadId, tagId }) => ({
      tagId: await setThreadTag(threadId, tagId),
    }),
  });

  // A deleted thread never comes back, so drop its tag.
  bb.events.on("thread.deleted", async ({ thread }) => {
    const assignments = await readAssignments();
    if (assignments[thread.id] !== undefined) await setThreadTag(thread.id, null);
  });

  // ── CLI ────────────────────────────────────────────────────────────────
  const usage = [
    "Usage:",
    "  bb thread-tags list [--json]                       List tags",
    "  bb thread-tags get [--thread <id>] [--json]        Show a thread's tag",
    "  bb thread-tags set <tag> [--thread <id>] [--json]  Tag a thread (tag id or label)",
    "  bb thread-tags clear [--thread <id>] [--json]      Remove a thread's tag",
    "  bb thread-tags create <label> --color <#rrggbb> [--json]",
    "  bb thread-tags delete <tag> [--json]",
    "",
    "--thread defaults to the thread the command runs in.",
  ].join("\n");

  function formatTag(tag: Tag): string {
    return `${tag.id}  ${tag.label}  ${tag.color}`;
  }
  function findTag(tags: Tag[], ref: string): Tag | undefined {
    return (
      tags.find((tag) => tag.id === ref) ??
      tags.find((tag) => tag.label.toLowerCase() === ref.toLowerCase())
    );
  }

  bb.cli.register({
    name: "thread-tags",
    summary: "Tag threads in the sidebar with an emoji or short text",
    commands: [
      { name: "list", summary: "List configured tags", usage: "bb thread-tags list [--json]" },
      { name: "get", summary: "Show a thread's tag", usage: "bb thread-tags get [--thread <id>] [--json]" },
      { name: "set", summary: "Tag a thread", usage: "bb thread-tags set <tag> [--thread <id>] [--json]" },
      { name: "clear", summary: "Remove a thread's tag", usage: "bb thread-tags clear [--thread <id>] [--json]" },
      { name: "create", summary: "Create a tag", usage: "bb thread-tags create <label> --color <#rrggbb> [--json]" },
      { name: "delete", summary: "Delete a tag", usage: "bb thread-tags delete <tag> [--json]" },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const rest = argv.filter((arg) => arg !== "--json");
      const takeFlag = (flag: string): string | undefined => {
        const index = rest.indexOf(flag);
        if (index === -1) return undefined;
        const [, value] = rest.splice(index, 2);
        return value;
      };
      const threadFlag = takeFlag("--thread");
      const colorFlag = takeFlag("--color");
      const [command, ...args] = rest;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      const threadId = threadFlag ?? ctx.threadId;
      const needThread = () =>
        fail("No thread: pass --thread <id> or run inside a bb thread.");

      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "list": {
          const tags = await readTags();
          return reply(tags, tags.length === 0 ? "No tags." : tags.map(formatTag).join("\n"));
        }
        case "get": {
          if (threadId === undefined) return needThread();
          const state = await readState();
          const tag = state.tags.find((t) => t.id === state.assignments[threadId]) ?? null;
          return reply({ threadId, tag }, tag === null ? "No tag." : formatTag(tag));
        }
        case "set": {
          if (threadId === undefined) return needThread();
          const ref = args.join(" ").trim();
          if (ref === "") break;
          const tag = findTag(await readTags(), ref);
          if (tag === undefined) return fail(`No tag "${ref}". Run "bb thread-tags list".`);
          await setThreadTag(threadId, tag.id);
          return reply({ threadId, tag }, `Tagged ${threadId} with ${tag.label}`);
        }
        case "clear": {
          if (threadId === undefined) return needThread();
          await setThreadTag(threadId, null);
          return reply({ threadId, tag: null }, `Cleared tag on ${threadId}`);
        }
        case "create": {
          const label = labelSchema.safeParse(args.join(" "));
          const color = colorSchema.safeParse(colorFlag ?? "");
          if (!label.success) return fail(`Label must be 1–${TAG_LABEL_MAX} characters.`);
          if (!color.success) return fail("Pass --color as #rrggbb.");
          const tag = await createTag(label.data, color.data);
          return reply(tag, `Created ${formatTag(tag)}`);
        }
        case "delete": {
          const ref = args.join(" ").trim();
          if (ref === "") break;
          const tag = findTag(await readTags(), ref);
          if (tag === undefined) return fail(`No tag "${ref}".`);
          await deleteTag(tag.id);
          return reply({ removed: true, id: tag.id }, `Deleted ${tag.label}`);
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
