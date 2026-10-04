// bb-plugin-thread-tags — frontend entry.
//
// bb's sidebar rows are owned by the thread-list plugin, so this plugin
// decorates them from an always-mounted app overlay:
//   - a tag badge just left of each tagged thread's title, and
//   - a tag button in each row's hover controls (beside Archive and ⋯) that
//     opens the tag picker, anchored to the button.
// Rows are found through the documented DOM contract every thread list keeps
// (`a[data-sidebar-thread-id][data-sidebar-thread-shortcut-target]`). Every
// node this plugin adds carries a `data-thread-tags-*` attribute and is
// removed on unmount.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Tag, TagState } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { EMOJI_CATEGORIES } from "@/lib/emoji-data";
import { cn } from "@/lib/utils";

const TAG_LABEL_MAX = 12;

const PALETTE = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#6b7280",
];

// ── shared state ─────────────────────────────────────────────────────────

function useTagState() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<TagState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("state_get").then((next) => {
      setState(next);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(refetch, [refetch]);
  useRealtime("tags-changed", refetch);
  return { rpc, state, error, report, refetch };
}

// ── badge ────────────────────────────────────────────────────────────────

/** Black or white, whichever reads better on `hex`. */
function foregroundFor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(
    (channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    },
  );
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return luminance > 0.4 ? "#111827" : "#ffffff";
}

/** A single grapheme (one emoji or one character) renders as a square icon. */
function isSingleGlyph(label: string): boolean {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter === undefined) return [...label].length <= 1;
  return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(label)].length <= 1;
}

/** String values only, so the same object styles React and plain DOM nodes. */
function badgeStyle(tag: Pick<Tag, "label" | "color">): Record<string, string> {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: "0",
    boxSizing: "border-box",
    height: "16px",
    minWidth: "16px",
    padding: isSingleGlyph(tag.label) ? "0" : "0 4px",
    borderRadius: "4px",
    background: tag.color,
    color: foregroundFor(tag.color),
    fontSize: "10px",
    fontWeight: "600",
    lineHeight: "16px",
    whiteSpace: "nowrap",
    userSelect: "none",
  };
}

function TagBadge({
  tag,
  large = false,
}: {
  tag: Pick<Tag, "label" | "color">;
  large?: boolean;
}) {
  const style = badgeStyle(tag) as CSSProperties;
  const sized: CSSProperties = large
    ? { ...style, height: 24, minWidth: 24, fontSize: 13, lineHeight: "24px", borderRadius: 6, padding: isSingleGlyph(tag.label) ? 0 : "0 6px" }
    : style;
  return (
    <span style={sized} aria-hidden>
      {tag.label}
    </span>
  );
}

// ── sidebar DOM decoration ───────────────────────────────────────────────

const ROW_ANCHOR = "a[data-sidebar-thread-id][data-sidebar-thread-shortcut-target]";
const BADGE_ATTR = "data-thread-tags-badge";
const BUTTON_ATTR = "data-thread-tags-button";

// lucide "tag"
const TAG_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:1rem;height:1rem"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/></svg>';

function applyBadge(el: HTMLElement, tag: Tag) {
  const signature = `${tag.label}\u0000${tag.color}`;
  if (el.dataset.signature === signature) return;
  el.dataset.signature = signature;
  el.textContent = tag.label;
  el.title = tag.label;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", `Tag ${tag.label}`);
  Object.assign(el.style, badgeStyle(tag), { marginRight: "6px" });
}

function rowOf(anchor: Element): Element | null {
  return anchor.closest('[class*="group/thread-row"]') ?? anchor.parentElement?.parentElement ?? null;
}

type OpenPicker = (threadId: string, button: HTMLElement) => void;

function syncSidebar(
  tagsById: ReadonlyMap<string, Tag>,
  assignments: Readonly<Record<string, string>>,
  openPicker: { current: OpenPicker },
) {
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>(ROW_ANCHOR)) {
    const threadId = anchor.dataset.sidebarThreadId;
    const row = rowOf(anchor);
    if (threadId === undefined || row === null) continue;

    // Badge, left of the title text.
    const title = row.querySelector<HTMLElement>(".bb-thread-title");
    const titleParent = title?.parentElement ?? null;
    const tagId = assignments[threadId];
    const tag = tagId === undefined ? undefined : tagsById.get(tagId);
    let badge = titleParent?.querySelector<HTMLElement>(`:scope > [${BADGE_ATTR}]`) ?? null;
    if (tag === undefined || title === null || titleParent === null) {
      badge?.remove();
    } else {
      if (badge === null) {
        badge = document.createElement("span");
        badge.setAttribute(BADGE_ATTR, "");
      }
      if (badge.nextElementSibling !== title) titleParent.insertBefore(badge, title);
      applyBadge(badge, tag);
    }

    // Tag button, first in the hover controls.
    const controls = row.querySelector<HTMLElement>("[data-sidebar-row-controls]");
    if (controls === null || controls.querySelector(`[${BUTTON_ATTR}]`) !== null) continue;
    const template = controls.querySelector("button");
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(BUTTON_ATTR, "");
    button.setAttribute("aria-label", "Tag thread");
    button.title = "Tag";
    button.className =
      template?.className ??
      "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent";
    button.innerHTML = TAG_ICON_SVG;
    const stop = (event: Event) => event.stopPropagation();
    button.addEventListener("pointerdown", stop);
    button.addEventListener("keydown", stop);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPicker.current(threadId, button);
    });
    controls.insertBefore(button, controls.firstChild);
  }
}

const STYLE_ATTR = "data-thread-tags-style";
const OPEN_ATTR = "data-thread-tags-open";

// bb pads the title on hover by exactly the width of its own two controls
// (Archive, ⋯). The tag button adds a third, so widen that padding by one
// button plus the controls' gap, and keep it while the picker is open.
const INSET_CSS = `
@media not ((width <= 767px) and (pointer: coarse)) {
  .bb-sidebar-hover-actions-row:has([${BUTTON_ATTR}]):is(:hover, :has(:focus-visible), :has([data-sidebar-hover-actions-open="true"]), [${OPEN_ATTR}])
    :has(> ${ROW_ANCHOR}) {
    padding-right: calc(var(--spacing, 0.25rem) * 15) !important;
  }
}`;

function installStyle() {
  if (document.querySelector(`style[${STYLE_ATTR}]`) !== null) return;
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTR, "");
  style.textContent = INSET_CSS;
  document.head.appendChild(style);
}

function markOpenRow(threadId: string | null) {
  for (const row of document.querySelectorAll(`[${OPEN_ATTR}]`)) row.removeAttribute(OPEN_ATTR);
  if (threadId === null) return;
  const anchor = document.querySelector(`${ROW_ANCHOR}[data-sidebar-thread-id="${CSS.escape(threadId)}"]`);
  anchor?.closest(".bb-sidebar-hover-actions-row")?.setAttribute(OPEN_ATTR, "");
}

function removeDecorations() {
  for (const node of document.querySelectorAll(
    `[${BADGE_ATTR}], [${BUTTON_ATTR}], style[${STYLE_ATTR}]`,
  )) {
    node.remove();
  }
  markOpenRow(null);
}

// ── picker ───────────────────────────────────────────────────────────────

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`Color ${color}`}
          aria-pressed={value === color}
          onClick={() => onChange(color)}
          className={cn(
            "size-5 rounded-full border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === color && "ring-2 ring-ring ring-offset-1 ring-offset-background",
          )}
          style={{ background: color }}
        />
      ))}
      <label
        className="relative flex size-5 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-border text-muted-foreground"
        title="Custom color"
        style={PALETTE.includes(value) ? undefined : { background: value }}
      >
        {PALETTE.includes(value) ? <Icon name="Plus" className="size-3" /> : null}
        <input
          type="color"
          aria-label="Custom color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

// ── emoji panel ──────────────────────────────────────────────────────────

const SEARCH_LIMIT = 200;

/** Every emoji by category, with a search over English and Russian names. */
function EmojiPanel({ onPick }: { onPick: (emoji: string) => void }) {
  const [categoryId, setCategoryId] = useState(EMOJI_CATEGORIES[0]!.id);
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const entries = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return EMOJI_CATEGORIES.find((category) => category.id === categoryId)!.emojis;
    }
    const matches: string[] = [];
    for (const category of EMOJI_CATEGORIES) {
      for (const entry of category.emojis) {
        const keywords = entry.slice(entry.indexOf("|") + 1);
        if (words.every((word) => keywords.includes(word))) matches.push(entry);
        if (matches.length === SEARCH_LIMIT) return matches;
      }
    }
    return matches;
  }, [categoryId, query]);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-1.5">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search emoji, e.g. fire / огонь"
        aria-label="Search emoji"
        className="h-7 text-xs"
        autoFocus
      />
      {!searching ? (
        <div className="flex justify-between" role="tablist" aria-label="Emoji categories">
          {EMOJI_CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              role="tab"
              aria-selected={category.id === categoryId}
              aria-label={category.label}
              title={category.label}
              onClick={() => setCategoryId(category.id)}
              className={cn(
                "flex size-6 items-center justify-center rounded text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                category.id === categoryId ? "bg-accent" : "opacity-60 hover:opacity-100",
              )}
            >
              {category.icon}
            </button>
          ))}
        </div>
      ) : null}
      <div className="grid h-40 grid-cols-8 content-start overflow-y-auto">
        {entries.length === 0 ? (
          <p className="col-span-8 py-4 text-center text-xs text-muted-foreground">
            Nothing found
          </p>
        ) : (
          entries.map((entry) => {
            const separator = entry.indexOf("|");
            const emoji = entry.slice(0, separator);
            const name = entry.slice(separator + 1).split(" ").slice(0, 4).join(" ");
            return (
              <button
                key={emoji}
                type="button"
                title={name}
                aria-label={name}
                onClick={() => onPick(emoji)}
                className="flex aspect-square items-center justify-center rounded text-lg leading-none outline-none hover:bg-accent focus-visible:bg-accent"
              >
                {emoji}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function TagForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Pick<Tag, "label" | "color">;
  submitLabel: string;
  onSubmit: (label: string, color: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [color, setColor] = useState(initial?.color ?? PALETTE[5]!);
  const [pending, setPending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const trimmed = label.trim();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (trimmed === "" || pending) return;
    setPending(true);
    try {
      await onSubmit(trimmed, color);
      if (initial === undefined) setLabel("");
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <TagBadge tag={{ label: trimmed === "" ? "?" : trimmed, color }} large />
        <Input
          value={label}
          maxLength={TAG_LABEL_MAX}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Emoji or text, e.g. 🚀 or WIP"
          aria-label="Tag label"
          className="h-8"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("size-8 shrink-0 text-muted-foreground", emojiOpen && "bg-accent text-foreground")}
          aria-label={emojiOpen ? "Hide emoji" : "Choose emoji"}
          aria-expanded={emojiOpen}
          onClick={() => setEmojiOpen((open) => !open)}
        >
          {/* lucide "smile" */}
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4"
            aria-hidden
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
            <line x1="9" x2="9.01" y1="9" y2="9" />
            <line x1="15" x2="15.01" y1="9" y2="9" />
          </svg>
        </Button>
      </div>
      {emojiOpen ? (
        <EmojiPanel
          onPick={(emoji) => {
            setLabel(emoji);
            setEmojiOpen(false);
          }}
        />
      ) : null}
      <ColorPicker value={color} onChange={setColor} />
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={trimmed === "" || pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function PickerBody({
  threadId,
  state,
  rpc,
  report,
  onDone,
}: {
  threadId: string;
  state: TagState;
  rpc: ReturnType<typeof useTagState>["rpc"];
  report: (cause: unknown) => void;
  onDone: () => void;
}) {
  const current = state.assignments[threadId] ?? null;
  const [creating, setCreating] = useState(state.tags.length === 0);
  const [managing, setManaging] = useState(false);
  const assign = (tagId: string | null) => {
    rpc.call("thread_set_tag", { threadId, tagId }).then(onDone, report);
  };
  if (managing) {
    return (
      <div className="flex flex-col gap-2" onPointerDown={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Manage tags</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setManaging(false)}>
            Done
          </Button>
        </div>
        {state.tags.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">No tags left.</p>
        ) : (
          <TagList state={state} rpc={rpc} report={report} compact />
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" onPointerDown={(event) => event.stopPropagation()}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Tag thread</span>
        {state.tags.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            aria-label="Manage tags"
            onClick={() => setManaging(true)}
          >
            <Icon name="Settings" className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {state.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-1">
          {state.tags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              title={tag.label}
              aria-label={`Tag ${tag.label}`}
              aria-pressed={current === tag.id}
              onClick={() => assign(current === tag.id ? null : tag.id)}
              className={cn(
                "rounded-md p-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                current === tag.id && "bg-accent ring-2 ring-ring",
              )}
            >
              <TagBadge tag={tag} large />
            </button>
          ))}
        </div>
      ) : null}
      {current !== null ? (
        <button
          type="button"
          onClick={() => assign(null)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent"
        >
          <Icon name="X" className="size-4" />
          Remove tag
        </button>
      ) : null}
      <div className="border-t border-border pt-2">
        {creating ? (
          <TagForm
            submitLabel="Create & apply"
            onCancel={state.tags.length > 0 ? () => setCreating(false) : undefined}
            onSubmit={async (label, color) => {
              try {
                const tag = await rpc.call("tag_create", { label, color });
                await rpc.call("thread_set_tag", { threadId, tagId: tag.id });
                onDone();
              } catch (cause) {
                report(cause);
              }
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
          >
            <Icon name="Plus" className="size-4" />
            New tag
          </button>
        )}
      </div>
    </div>
  );
}

interface PickerTarget {
  threadId: string;
  rect: { top: number; left: number; width: number; height: number };
}

function SidebarTags() {
  const { rpc, state, error, report } = useTagState();
  const [target, setTarget] = useState<PickerTarget | null>(null);

  const openPicker = useRef<OpenPicker>(() => {});
  openPicker.current = (threadId, button) => {
    const { top, left, width, height } = button.getBoundingClientRect();
    setTarget((prev) =>
      prev?.threadId === threadId ? null : { threadId, rect: { top, left, width, height } },
    );
  };

  const tagsById = useMemo(
    () => new Map((state?.tags ?? []).map((tag) => [tag.id, tag])),
    [state],
  );
  const assignments = state?.assignments;

  useEffect(() => {
    if (assignments === undefined) return;
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncSidebar(tagsById, assignments, openPicker);
      });
    };
    syncSidebar(tagsById, assignments, openPicker);
    // Rows mount, re-render, and scroll into view at any time; syncing is
    // idempotent, so our own writes settle after one extra pass.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [tagsById, assignments]);

  useEffect(() => {
    installStyle();
    return removeDecorations;
  }, []);

  const openThreadId = target?.threadId ?? null;
  useEffect(() => {
    markOpenRow(openThreadId);
  }, [openThreadId, state]);

  useEffect(() => {
    if (error !== null) console.warn("[thread-tags]", error);
  }, [error]);

  if (target === null || state === null) return null;
  return (
    <Popover open onOpenChange={(open) => (open ? undefined : setTarget(null))}>
      <PopoverAnchor asChild>
        <div
          aria-hidden
          style={{
            position: "fixed",
            top: target.rect.top,
            left: target.rect.left,
            width: target.rect.width,
            height: target.rect.height,
            pointerEvents: "none",
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        className="max-h-[var(--radix-popover-content-available-height)] w-72 overflow-y-auto p-2"
        collisionPadding={8}
        mobileTitle="Tag thread"
        onInteractOutside={(event) => {
          // A click on the same tag button toggles the picker itself.
          const node = event.target as Element | null;
          if (node?.closest?.(`[${BUTTON_ATTR}]`)) event.preventDefault();
        }}
      >
        <PickerBody
          key={target.threadId}
          threadId={target.threadId}
          state={state}
          rpc={rpc}
          report={report}
          onDone={() => setTarget(null)}
        />
      </PopoverContent>
    </Popover>
  );
}

// ── settings ─────────────────────────────────────────────────────────────

function TagRow({
  tag,
  count,
  compact = false,
  onSave,
  onDelete,
}: {
  tag: Tag;
  count: number;
  compact?: boolean;
  onSave: (label: string, color: string) => Promise<void>;
  onDelete: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm-delete">("view");
  const threads = `${count} ${count === 1 ? "thread" : "threads"}`;
  if (mode === "edit") {
    return (
      <li className={compact ? "py-2" : "py-3"}>
        <TagForm
          initial={tag}
          submitLabel="Save"
          onCancel={() => setMode("view")}
          onSubmit={async (label, color) => {
            await onSave(label, color);
            setMode("view");
          }}
        />
      </li>
    );
  }
  if (mode === "confirm-delete") {
    return (
      <li className={cn("flex items-center gap-2 text-sm", compact ? "py-1.5" : "py-2.5")}>
        <TagBadge tag={tag} large />
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          {count > 0 ? `Delete? Removes it from ${threads}.` : "Delete this tag?"}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => setMode("view")}>
          Cancel
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={onDelete}>
          Delete
        </Button>
      </li>
    );
  }
  return (
    <li className={cn("flex items-center text-sm", compact ? "gap-2 py-1" : "gap-3 py-2.5")}>
      <TagBadge tag={tag} large />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {compact ? null : tag.color}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{threads}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        aria-label={`Edit ${tag.label}`}
        onClick={() => setMode("edit")}
      >
        <Icon name="Edit" className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-destructive"
        aria-label={`Delete ${tag.label}`}
        onClick={() => setMode("confirm-delete")}
      >
        <Icon name="Trash2" className="size-4" />
      </Button>
    </li>
  );
}

/** The editable tag list shared by the picker's Manage view and Settings. */
function TagList({
  state,
  rpc,
  report,
  compact = false,
}: {
  state: TagState;
  rpc: ReturnType<typeof useTagState>["rpc"];
  report: (cause: unknown) => void;
  compact?: boolean;
}) {
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const tagId of Object.values(state.assignments)) {
      result.set(tagId, (result.get(tagId) ?? 0) + 1);
    }
    return result;
  }, [state]);
  return (
    <ul
      className={cn(
        "divide-y divide-border",
        !compact && "rounded-lg border border-border bg-card px-4",
      )}
    >
      {state.tags.map((tag) => (
        <TagRow
          key={tag.id}
          tag={tag}
          compact={compact}
          count={counts.get(tag.id) ?? 0}
          onSave={(label, color) =>
            rpc.call("tag_update", { id: tag.id, label, color }).then(() => undefined, report)
          }
          onDelete={() => {
            rpc.call("tag_delete", { id: tag.id }).catch(report);
          }}
        />
      ))}
    </ul>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function TagSettings() {
  const { rpc, state, error, report } = useTagState();
  return (
    <div className="flex flex-col gap-4">
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {state === null ? (
        <EmptyState>Loading tags…</EmptyState>
      ) : state.tags.length === 0 ? (
        <EmptyState>No tags yet. Create one below.</EmptyState>
      ) : (
        <TagList state={state} rpc={rpc} report={report} />
      )}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 text-sm font-medium">New tag</div>
        <TagForm
          submitLabel="Create"
          onSubmit={(label, color) =>
            rpc.call("tag_create", { label, color }).then(() => undefined, report)
          }
        />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "sidebar-tags", component: SidebarTags });
  app.slots.settingsSection({
    id: "tags",
    title: "Tags",
    description:
      "Tags show as a badge left of a thread's title in the sidebar. Hover a thread and click the tag button to apply one.",
    component: TagSettings,
  });
});
