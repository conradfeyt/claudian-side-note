# Claudian SideNote

> ### ⚠️ Dependency notice
> The **`@claude` AI-reply feature requires a separate companion plugin, [`realclaudian`](#the-claude-feature-needs-realclaudian), which is bespoke and *not publicly released*.** On a normal install that feature will not work.
> **Everything else — threaded inline comments — works fully standalone.** If you just want inline comments, you're good to go. See [details below](#the-claude-feature-needs-realclaudian).

An [Obsidian](https://obsidian.md) plugin for **threaded inline comments anchored to text** — a [SideNote](https://github.com/cumany/obsidian-side-note)-style review layer with conversation threads, plus an optional **`@claude` workflow** that lets an embedded Claude reply to your comments in place.

Select text → add a comment → reply in a thread. Comments live in the side panel (All / Unresolved / Resolved tabs) with two-way navigation: click a quote to jump to its source, click a highlight to focus its comment.

## The `@claude` feature needs `realclaudian`

The headline trick — mention `@claude` (or `@claudian`) in a comment and have Claude reply, with **Apply / Resolve / Navigate** actions written back into the thread — depends on a separate, **bespoke** plugin (`realclaudian`, an embedded Claude chat panel) that is **not publicly distributed**.

**Without `realclaudian`, this still works as a fully functional threaded-comments plugin** — you just won't get the AI replies. If you only want inline comments, install away.

## Install

Not in the community store. Two options:

**BRAT (auto-updating):**
1. Install the *BRAT* plugin from Community Plugins.
2. `BRAT: Add a beta plugin` → `conradfeyt/claudian-side-note`.

**Manual:**
1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/conradfeyt/claudian-side-note/releases).
2. Drop them in `<your vault>/.obsidian/plugins/claudian-side-note/`.
3. Enable it in Settings → Community plugins.

## Data

Comments are stored in `data.json` inside the plugin folder (schema: id, file path, anchor range + hashed selected text, comment, timestamp, resolved/orphaned flags, `thread[]`). It's **gitignored** — your comment content never leaves your vault.

## Known limitations

- The comment author is currently hardcoded as **"Conrad"** in a few UI strings — not yet a setting. PRs welcome.
- `@claude` replies require the unreleased `realclaudian` plugin (see above).
- Re-anchoring as files change is still rough; editing a highlighted span can orphan a comment.

## License

MIT — see [`LICENSE`](./LICENSE).
