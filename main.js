'use strict';

/*
 * Claudian SideNote — Stage 2.1 (polish pass)
 *
 * Visual refactor matching the reference inspo:
 *  - Header: "Comments" title + tabs (All / Unresolved (N)) + cog menu
 *  - Comments: hairline-separated rows, not bordered cards
 *  - Messages: avatar circle (initial) + bold name + relative timestamp
 *  - Quiet status affordances (orphan dot, resolved icon) instead of chunky badges
 *  - Reply: subtle inline "↳ Reply" link (Stage 5 will wire it up)
 *
 * No functional changes; data flow / filtering / sorting all untouched.
 */

const obsidian = require('obsidian');
const cmView = require('@codemirror/view');
const cmState = require('@codemirror/state');
const { ViewPlugin, Decoration, EditorView } = cmView;
const { RangeSetBuilder } = cmState;

const SOURCE_PLUGIN_ID = 'side-note';
const VIEW_TYPE = 'claudian-side-note-panel';

const DEFAULT_SETTINGS = {
  showHighlights: true,
  showResolvedComments: false,         // legacy (kept for backward read; tabFilter is canonical)
  tabFilter: 'unresolved',             // 'unresolved' | 'all' | 'resolved'
  highlightColor: '#FFC800',
  highlightOpacity: 0.2,
  commentSortOrder: 'position',
  panelScope: 'current-file',           // 'current-file' | 'all-files'

  authorName: 'Me',                     // display name for your (human-authored) comments & replies
  conradColor: '#FF8C42',               // avatar/initial colour for your messages
  claudianColor: '#5DADE2',

  schemaVersion: 1,
  comments: [],

  // File paths whose group header is collapsed in the all-files view.
  // Persisted so the accordion state survives reloads.
  collapsedGroups: []
};

class ClaudianSideNote extends obsidian.Plugin {

  async onload() {
    console.log('[claudian-side-note] loading');

    await this.loadSettings();

    if (!this.settings.comments || this.settings.comments.length === 0) {
      const migrated = await this.tryMigrateFromSideNote();
      if (migrated > 0) {
        new obsidian.Notice(`Claudian SideNote: migrated ${migrated} comments from SideNote`);
      }
    }

    this.registerView(VIEW_TYPE, (leaf) => new ClaudianSideNoteView(leaf, this));

    // Editor highlighting — Live Preview / Source mode (CodeMirror 6)
    this.registerEditorExtension(createHighlightExtension(this));

    // Editor highlighting — Reading mode (rendered markdown)
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!ctx || !ctx.sourcePath) return;
      this.applyReadingModeHighlights(el, ctx);
    });

    // Transient state — the in-flight comment draft, before the user has
    // typed and saved it. Lives on the plugin instance (not in settings) so
    // it's never persisted across reloads.
    this.pendingDraft = null;

    // Comments currently awaiting a Claudian reply (after @-mention). Transient.
    this.awaitingClaudianFor = new Set();

    // In-progress reply inputs — both *which* comments have an open reply
    // box and *what* the user has typed into each. Survives re-renders so a
    // watcher refresh doesn't wipe in-flight typing.
    this.openReplyFor = new Set();
    this.pendingReplyTexts = new Map();

    // Auto-reload data.json when it's modified out-of-band (Claudian writing
    // replies, manual edits). vault.on('modify') doesn't fire for files under
    // .obsidian/, so we poll mtime.
    this.dataJsonPath = `.obsidian/plugins/${this.manifest.id}/data.json`;
    this.lastKnownMtime = 0;
    this.suppressWatcherUntil = 0;
    this.setupDataJsonWatcher();

    this.addRibbonIcon('message-square', 'Open Claudian SideNote panel', () => this.activateView());

    this.addSettingTab(new ClaudianSideNoteSettingTab(this.app, this));

    this.addCommand({ id: 'open-panel', name: 'Open panel', callback: () => this.activateView() });

    // Stage 4 — create a new comment from the current editor selection.
    // Unbound by default; users assign their own hotkey via Settings → Hotkeys.
    this.addCommand({
      id: 'add-comment-on-selection',
      name: 'Add comment on selection',
      editorCheckCallback: (checking, editor, view) => {
        const hasSelection = editor.getSelection().length > 0;
        if (checking) return hasSelection;
        this.startDraftFromEditor(editor, view);
      }
    });

    // Right-click menu — only when there's a non-empty selection.
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      if (!editor.getSelection()) return;
      menu.addItem((item) => {
        item
          .setTitle('Add comment')
          .setIcon('message-square')
          .onClick(() => this.startDraftFromEditor(editor, view));
      });
    }));

    // Vault lifecycle — keep comment.filePath in sync with renames/moves,
    // and flag (but don't delete) comments whose file gets deleted.
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.handleFileRename(file, oldPath);
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      this.handleFileDelete(file);
    }));

    this.addCommand({
      id: 'remigrate-from-side-note',
      name: 'Re-migrate comments from SideNote (overwrites current)',
      callback: async () => {
        const ok = confirm('Overwrite Claudian SideNote comments with a fresh copy of SideNote\'s data.json?');
        if (!ok) return;
        this.settings.comments = [];
        const n = await this.tryMigrateFromSideNote();
        await this.saveSettings();
        this.refreshAllViews();
        new obsidian.Notice(`Re-migrated ${n} comments from SideNote`);
      }
    });

    this.addCommand({
      id: 'show-stats',
      name: 'Show comment store stats',
      callback: () => {
        const total = this.settings.comments.length;
        const orphaned = this.settings.comments.filter(c => c.isOrphaned).length;
        const resolved = this.settings.comments.filter(c => c.resolved).length;
        const threaded = this.settings.comments.filter(c => (c.thread || []).length > 0).length;
        new obsidian.Notice(
          `Claudian SideNote stats:\n  total: ${total}\n  orphaned: ${orphaned}\n  resolved: ${resolved}\n  threaded: ${threaded}`,
          8000
        );
      }
    });
  }

  onunload() {
    console.log('[claudian-side-note] unloading');
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
    if (!Array.isArray(this.settings.comments)) this.settings.comments = [];

    // Migrate legacy boolean → enum if tabFilter wasn't set.
    if (!this.settings.tabFilter) {
      this.settings.tabFilter = this.settings.showResolvedComments ? 'all' : 'unresolved';
    }
  }

  async saveSettings() {
    // Tell the watcher to ignore changes for the next second — covers the
    // window between writing and the next poll picking up the new mtime.
    this.suppressWatcherUntil = Date.now() + 1000;
    await this.saveData(this.settings);
    try {
      const stat = await this.app.vault.adapter.stat(this.dataJsonPath);
      if (stat) this.lastKnownMtime = stat.mtime;
    } catch (e) { /* ignore */ }
    this.refreshAllEditors();
  }

  /**
   * Poll mtime of our data.json. When it changes outside of our own writes
   * (Claudian editing the file, manual edits, sync clients), reload settings
   * and refresh UI. Also clears awaitingClaudianFor for any comment whose
   * thread grew since the last reload — that's how the "thinking" indicator
   * disappears when a reply lands.
   */
  setupDataJsonWatcher() {
    // Establish baseline mtime so we don't fire immediately on startup.
    this.app.vault.adapter.stat(this.dataJsonPath)
      .then(stat => { if (stat) this.lastKnownMtime = stat.mtime; })
      .catch(() => { /* ignore */ });

    this.registerInterval(window.setInterval(async () => {
      if (Date.now() < this.suppressWatcherUntil) return;
      let stat;
      try { stat = await this.app.vault.adapter.stat(this.dataJsonPath); } catch (e) { return; }
      if (!stat) return;
      if (stat.mtime <= this.lastKnownMtime + 200) return;

      this.lastKnownMtime = stat.mtime;

      // Capture previous thread lengths so we can detect new replies.
      const prevThreadLens = new Map();
      for (const c of this.settings.comments) {
        prevThreadLens.set(c.id, Array.isArray(c.thread) ? c.thread.length : 0);
      }

      await this.loadSettings();

      // Clear awaiting state for comments whose thread grew.
      for (const c of this.settings.comments) {
        const prev = prevThreadLens.get(c.id);
        const cur = Array.isArray(c.thread) ? c.thread.length : 0;
        if (prev !== undefined && cur > prev) {
          this.awaitingClaudianFor.delete(c.id);
        }
      }

      this.refreshAllViews();
      this.refreshAllEditors();
    }, 1500));
  }

  /**
   * Capture the current editor selection into a draft and open the panel
   * so the user can type their comment in the inline draft row. The draft
   * lives only in memory until they hit Save (then it becomes a comment)
   * or Cancel (then it's dropped).
   */
  async startDraftFromEditor(editor, view) {
    const selection = editor.getSelection();
    if (!selection) return;
    const file = view && view.file;
    if (!file) {
      new obsidian.Notice('Claudian SideNote: no file context for selection');
      return;
    }
    const from = editor.getCursor('from');
    const to = editor.getCursor('to');

    this.pendingDraft = {
      filePath: file.path,
      selectedText: selection,
      startLine: from.line,
      startChar: from.ch,
      endLine: to.line,
      endChar: to.ch
    };

    await this.activateView();
    this.refreshAllViews();
  }

  /**
   * Promote the in-flight draft into a real comment, persist, refresh
   * everything. `commentText` is the textarea contents at save time.
   */
  async saveDraft(commentText) {
    if (!this.pendingDraft) return;
    const d = this.pendingDraft;
    const hash = await sha256Hex(d.selectedText);
    const newComment = {
      id: crypto.randomUUID(),
      filePath: d.filePath,
      startLine: d.startLine,
      startChar: d.startChar,
      endLine: d.endLine,
      endChar: d.endChar,
      selectedText: d.selectedText,
      selectedTextHash: hash,
      comment: commentText,
      timestamp: Date.now(),
      isOrphaned: false,
      resolved: false,
      resolvedAt: null,
      thread: []
    };
    this.settings.comments.push(newComment);
    this.pendingDraft = null;
    await this.saveSettings(); // also refreshes editors
    this.refreshAllViews();

    if (this.hasClaudianMention(commentText)) {
      this.pingClaudian(newComment, 'comment');
    }
  }

  cancelDraft() {
    this.pendingDraft = null;
    this.refreshAllViews();
  }

  /**
   * Editor → panel navigation. Clicking a highlight in any editor mode lands
   * here. Opens the panel if closed, finds the matching comment card, scrolls
   * it into view, and pulses it briefly so the user can see where they landed.
   *
   * If the matching card isn't currently rendered (e.g. the comment is on
   * another file and panelScope === 'current-file'), we don't switch scope
   * automatically — that would be jarring. We just open the panel; the user
   * can switch tabs themselves.
   */
  async focusCommentInPanel(commentId) {
    if (!commentId) return;

    await this.activateView();

    // Defer to next tick so the panel's DOM exists after activateView.
    setTimeout(() => {
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
      for (const leaf of leaves) {
        const view = leaf.view;
        if (!view || !view.contentEl) continue;
        const card = view.contentEl.querySelector(`.csn-comment[data-comment-id="${commentId}"]`);
        if (!card) continue;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('csn-flash'); // restart animation if re-clicked
        void card.offsetWidth; // force reflow so the keyframe replays
        card.classList.add('csn-flash');
        setTimeout(() => card.classList.remove('csn-flash'), 1500);
        return;
      }
    }, 50);
  }

  /**
   * Execute a structured action attached to a thread message. Action shapes:
   *   { type: 'resolve' }
   *   { type: 'replace', filePath, from: {line, ch}, to: {line, ch}, newText }
   *   { type: 'navigate', filePath, line }
   * Returns true on success, false on failure (with a notice).
   */
  async executeMessageAction(commentId, action) {
    if (!action || !action.type) return false;

    try {
      switch (action.type) {
        case 'resolve': {
          const c = this.settings.comments.find(c => c.id === commentId);
          if (!c) return false;
          c.resolved = true;
          c.resolvedAt = new Date().toISOString();
          await this.saveSettings();
          this.refreshAllViews();
          return true;
        }

        case 'replace': {
          if (!action.filePath || !action.from || !action.to || action.newText === undefined) {
            new obsidian.Notice('Replace action missing required fields.');
            return false;
          }
          const file = this.app.vault.getAbstractFileByPath(action.filePath);
          if (!(file instanceof obsidian.TFile)) {
            new obsidian.Notice(`File not found: ${action.filePath}`);
            return false;
          }
          // Use vault.process for an atomic read-modify-write.
          await this.app.vault.process(file, (content) => {
            const lines = content.split('\n');
            const { from, to, newText } = action;
            if (from.line < 0 || to.line >= lines.length || from.line > to.line) return content;

            if (from.line === to.line) {
              const line = lines[from.line];
              lines[from.line] = line.slice(0, from.ch) + newText + line.slice(to.ch);
            } else {
              const head = lines[from.line].slice(0, from.ch);
              const tail = lines[to.line].slice(to.ch);
              const replaced = (head + newText + tail).split('\n');
              lines.splice(from.line, to.line - from.line + 1, ...replaced);
            }
            return lines.join('\n');
          });
          new obsidian.Notice('Applied.');
          return true;
        }

        case 'navigate': {
          if (!action.filePath) return false;
          const file = this.app.vault.getAbstractFileByPath(action.filePath);
          if (!(file instanceof obsidian.TFile)) {
            new obsidian.Notice(`File not found: ${action.filePath}`);
            return false;
          }
          await this.app.workspace.getLeaf(false).openFile(file, {
            active: true,
            eState: { line: action.line || 0 }
          });
          return true;
        }

        default:
          new obsidian.Notice(`Unknown action type: ${action.type}`);
          return false;
      }
    } catch (err) {
      console.error('[claudian-side-note] action failed', err);
      new obsidian.Notice('Action failed — see console.');
      return false;
    }
  }

  /**
   * Look for `@claude` / `@claudian` mentions (case-insensitive, word boundary).
   */
  hasClaudianMention(text) {
    if (!text) return false;
    return /(^|\s|[^\w@])@(claude|claudian)\b/i.test(text);
  }

  /**
   * Send a prompt into the Claudian chat plugin so Claude can act on a
   * comment that mentioned them. Best-effort: if Claudian isn't installed or
   * the API surface has shifted, we surface a notice and bail without
   * disrupting normal comment creation.
   */
  async pingClaudian(comment, mentionFrom) {
    const claudian = this.app.plugins.plugins.realclaudian;
    if (!claudian) {
      new obsidian.Notice('Claudian plugin not available — @-mention ignored.');
      return;
    }

    const prompt = this.buildClaudianPrompt(comment, mentionFrom);

    // Mark the comment as awaiting a reply — surfaces the "thinking" indicator.
    this.awaitingClaudianFor.add(comment.id);
    this.refreshAllViews();

    // Remember active leaf so we can restore focus after.
    const prevLeaf = this.app.workspace.activeLeaf;

    try {
      // Find an existing Claudian view without activating; if none, open one
      // in the background (active: false) so the user's focus doesn't shift.
      let view = typeof claudian.getView === 'function' ? claudian.getView() : null;
      if (!view) {
        const placement = (claudian.settings && claudian.settings.chatViewPlacement) || 'right-sidebar';
        let leaf;
        if (placement === 'left-sidebar') leaf = this.app.workspace.getLeftLeaf(false);
        else if (placement === 'main-tab') leaf = this.app.workspace.getLeaf('tab');
        else leaf = this.app.workspace.getRightLeaf(false);

        if (leaf) {
          await leaf.setViewState({ type: 'claudian-view', active: false });
          view = typeof claudian.getView === 'function' ? claudian.getView() : null;
        }
      }
      if (!view) throw new Error('Could not open Claudian view');

      const tabManager = typeof view.getTabManager === 'function' ? view.getTabManager() : null;
      const tab = tabManager && typeof tabManager.getActiveTab === 'function' ? tabManager.getActiveTab() : null;
      const ic = tab && tab.controllers && tab.controllers.inputController;
      if (!ic || typeof ic.sendMessage !== 'function') {
        throw new Error('Could not reach Claudian input controller');
      }
      await ic.sendMessage({ content: prompt });
    } catch (err) {
      console.error('[claudian-side-note] pingClaudian failed', err);
      this.awaitingClaudianFor.delete(comment.id);
      this.refreshAllViews();
      new obsidian.Notice('Failed to ping Claudian — see console.');
      return;
    }

    // Snap focus back to the user's previous view if it shifted.
    if (prevLeaf && this.app.workspace.activeLeaf !== prevLeaf) {
      this.app.workspace.setActiveLeaf(prevLeaf, { focus: true });
    }
  }

  /**
   * Build the prompt sent into Claudian's chat input when @-mentioned.
   * Includes the anchor, the full thread, and a structured spec for replying
   * (including optional `actions` so Claudian can offer one-click apply).
   */
  buildClaudianPrompt(comment, mentionFrom) {
    const fileLink = `[[${comment.filePath}]]`;
    const anchor = (comment.selectedText || '').slice(0, 400);
    const name = this.settings.authorName || 'Me';
    const threadText = (comment.thread || [])
      .map(m => `> ${m.author === 'claudian' ? 'You (Claudian)' : name}: ${m.text}`)
      .join('\n');
    const mentionLine = mentionFrom === 'reply'
      ? `${name} replied with an @-mention.`
      : `${name} created a comment with an @-mention.`;

    return [
      `${mentionLine} On ${fileLink} (comment id \`${comment.id}\`):`,
      '',
      'Anchored text:',
      `> ${anchor.replace(/\n/g, '\n> ')}`,
      `Source position: line ${comment.startLine + 1}, chars ${comment.startChar}-${comment.endChar}.`,
      '',
      'Comment thread:',
      `> ${name}: ${comment.comment}`,
      threadText || null,
      '',
      `Read surrounding context in ${fileLink}, then reply by appending a thread entry to this comment in \`.obsidian/plugins/claudian-side-note/data.json\`. Find the comment with \`"id": "${comment.id}"\` and push onto its \`thread\` array:`,
      '',
      '```json',
      '{',
      '  "author": "claudian",',
      '  "text": "<your reply, markdown ok>",',
      '  "timestamp": <Date.now()>,',
      '  "actions": [    // optional — only when you\'re proposing concrete next steps',
      '    { "label": "Apply", "type": "replace", "filePath": "<path>", "from": {"line": N, "ch": N}, "to": {"line": N, "ch": N}, "newText": "<replacement>" },',
      '    { "label": "Resolve", "type": "resolve" }',
      '  ]',
      '}',
      '```',
      '',
      'Action types supported by the panel: `resolve` (marks this comment resolved), `replace` (text replacement at the given range), `navigate` (`{type:"navigate", filePath, line}`). Omit `actions` entirely if the reply is just a discussion.'
    ].filter(Boolean).join('\n');
  }

  /**
   * Permanently delete a comment from the store. Confirms via Obsidian
   * Notice but the actual confirm dialog lives in the panel (since the
   * plugin shouldn't block on `confirm()`).
   */
  async deleteComment(commentId) {
    const idx = this.settings.comments.findIndex(c => c.id === commentId);
    if (idx === -1) return;
    this.settings.comments.splice(idx, 1);
    this.awaitingClaudianFor.delete(commentId);
    await this.saveSettings();
    this.refreshAllViews();
  }

  /**
   * Append a reply (always authored as Conrad in this UI) to a comment's
   * thread, persist, and refresh both panel and editor.
   *
   * Claudian-authored replies don't go through this method — those are
   * written into data.json directly when I edit the file from the chat.
   */
  async addReplyToComment(commentId, text) {
    if (!text) return;
    const c = this.settings.comments.find(c => c.id === commentId);
    if (!c) return;
    if (!Array.isArray(c.thread)) c.thread = [];
    // Check whether Claudian was already part of this thread BEFORE we push
    // the new entry — that determines whether the reply auto-pings.
    const claudianAlreadyInThread = c.thread.some(m => m && m.author === 'claudian');
    c.thread.push({
      author: 'conrad',
      text,
      timestamp: Date.now()
    });
    await this.saveSettings(); // also refreshes editors
    this.refreshAllViews();

    // Ping Claudian if either:
    //   (a) the user explicitly @-mentioned, or
    //   (b) Claudian is already in the thread — replying continues the convo.
    if (this.hasClaudianMention(text) || claudianAlreadyInThread) {
      this.pingClaudian(c, 'reply');
    }
  }

  /**
   * Flip a comment's resolved state. Sets `resolvedAt` on transition to
   * resolved, clears it on transition back. Persists + refreshes both panel
   * and editor highlights (so a resolved comment disappears from "Unresolved"
   * tab + hides its highlight when `showResolvedComments === false`).
   */
  async toggleResolve(commentId) {
    const c = this.settings.comments.find(c => c.id === commentId);
    if (!c) return;
    c.resolved = !c.resolved;
    c.resolvedAt = c.resolved ? new Date().toISOString() : null;
    await this.saveSettings(); // also refreshes editors
    this.refreshAllViews();
  }

  /**
   * Open the file the comment anchors to and scroll/select its source range.
   * If the file is already open in a leaf, reuse that leaf; otherwise open in
   * a new leaf. Selection lands exactly on the anchored text so the user can
   * see what was originally selected.
   */
  async jumpToComment(comment) {
    if (!comment || !comment.filePath) return;
    const file = this.app.vault.getAbstractFileByPath(comment.filePath);
    if (!(file instanceof obsidian.TFile)) {
      new obsidian.Notice(`Claudian SideNote: file not found — ${comment.filePath}`);
      return;
    }

    // Prefer an already-open leaf for this file so we don't fragment the layout.
    let targetLeaf = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf && leaf.view;
      if (v && v.file && v.file.path === comment.filePath) targetLeaf = leaf;
    });
    const fileAlreadyOpen = !!targetLeaf;
    if (!targetLeaf) targetLeaf = this.app.workspace.getLeaf(false);

    if (!fileAlreadyOpen) {
      // openFile's eState is the official Obsidian API for "scroll to line on open"
      // — works in both source and preview modes.
      await targetLeaf.openFile(file, {
        active: true,
        eState: { line: comment.startLine, ch: comment.startChar }
      });
    } else {
      this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
    }

    // Even if the file was already open we still need to navigate to the line.
    // Defer so the view has time to mount its editor / preview DOM.
    setTimeout(() => {
      const view = targetLeaf.view;
      if (!view) return;

      // getMode() returns 'source' (Live Preview + Source) or 'preview' (Reading).
      // view.editor exists in both — don't use its presence as a mode check.
      const mode = view.getMode && view.getMode();

      if (mode === 'preview') {
        // Reading mode. setEphemeralState({line}) is what Obsidian's own
        // internal navigation uses — scrolls the preview to the line.
        if (typeof view.setEphemeralState === 'function') {
          try { view.setEphemeralState({ line: comment.startLine }); } catch (e) { /* ignore */ }
        }
        // Fallback: preview.applyScroll if available
        if (view.previewMode && typeof view.previewMode.applyScroll === 'function') {
          try { view.previewMode.applyScroll(comment.startLine); } catch (e) { /* ignore */ }
        }
        return;
      }

      // Source / Live Preview — select the anchored range and focus.
      const editor = view.editor;
      if (!editor) return;
      const from = { line: comment.startLine, ch: comment.startChar };
      const to = { line: comment.endLine, ch: comment.endChar };
      editor.setSelection(from, to);
      editor.scrollIntoView({ from, to }, true);
      editor.focus();
    }, 50);
  }

  /**
   * Rename/move handler — fired by Obsidian when a file is renamed or moved
   * within the vault. We re-point every comment that referenced the old
   * path. Char positions are unchanged (file contents are the same).
   */
  async handleFileRename(file, oldPath) {
    let changed = 0;
    for (const c of this.settings.comments) {
      if (c.filePath === oldPath) {
        c.filePath = file.path;
        changed++;
      }
    }
    if (changed > 0) {
      await this.saveSettings(); // saveSettings also refreshes editors
      this.refreshAllViews();
      new obsidian.Notice(
        `Claudian SideNote: updated ${changed} comment${changed === 1 ? '' : 's'} after rename`
      );
    }
  }

  /**
   * Delete handler — we keep the comments in storage but the panel will
   * render their group with a "file deleted" affordance + bulk-remove action.
   * Rationale: if the user restores the file from system trash / a backup,
   * we don't want their commentary gone too.
   */
  handleFileDelete(file) {
    const count = this.settings.comments.filter(c => c.filePath === file.path).length;
    if (count === 0) return;
    this.refreshAllViews();
    new obsidian.Notice(
      `Claudian SideNote: ${count} comment${count === 1 ? '' : 's'} now reference a deleted file`,
      6000
    );
  }

  /**
   * Bulk-remove every comment that references `filePath`. Called from the
   * panel's "(deleted) — remove" action.
   */
  async deleteAllCommentsForPath(filePath) {
    const before = this.settings.comments.length;
    this.settings.comments = this.settings.comments.filter(c => c.filePath !== filePath);
    const removed = before - this.settings.comments.length;
    if (removed > 0) {
      await this.saveSettings();
      this.refreshAllViews();
      new obsidian.Notice(`Removed ${removed} comment${removed === 1 ? '' : 's'}`);
    }
  }

  /**
   * Re-sync highlights in every open note after comments/filter change.
   *  - Live Preview / Source: a no-op transaction makes the highlight
   *    ViewPlugin rebuild its decorations.
   *  - Reading mode: the highlight MarkdownPostProcessor only runs when the
   *    preview re-renders, so it goes STALE on a filter/resolve/delete (the
   *    highlight stays painted while the comment leaves the panel). Force a
   *    preview re-render so its highlights recompute against current settings.
   */
  refreshAllEditors() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf && leaf.view;
      if (!v) return;
      if (v.editor && v.editor.cm) {
        try { v.editor.cm.dispatch({}); } catch (e) { /* ignore */ }
      }
      const preview = v.previewMode;
      if (preview && typeof preview.rerender === 'function') {
        try { preview.rerender(true); } catch (e) { /* ignore */ }
      }
    });
  }

  /**
   * Wrap comment selections with highlight spans inside rendered markdown.
   *
   * Preferred path: ctx.getSectionInfo(el) returns {text, lineStart, lineEnd}
   * — the source markdown and line range for this rendered block. We use it
   * to (a) filter comments to ones whose line range overlaps the section,
   * and (b) derive the highlight needle from the live source slice (not the
   * stored selectedText, which can be stale or include surrounding context).
   *
   * Fallback path: when section info isn't available (embeds, transclusions,
   * Dataview output), strip selectedText and search the rendered element.
   *
   * In both paths, wrapTextInElement handles multi-text-node spans so
   * highlights cross <strong>/<em>/<a> boundaries cleanly.
   */
  applyReadingModeHighlights(el, ctx) {
    const filePath = ctx.sourcePath;
    if (!filePath) return;

    let comments = this.settings.comments.filter(c =>
      c.filePath === filePath && !c.isOrphaned
    );
    comments = applyTabFilter(comments, this.settings.tabFilter);
    if (comments.length === 0) return;

    const bg = hexToRgba(this.settings.highlightColor, this.settings.highlightOpacity);
    const makeWrapper = (c) => (matchText) => {
      const wrap = document.createElement('span');
      wrap.className = 'csn-highlight';
      wrap.style.backgroundColor = bg;
      wrap.dataset.commentId = c.id;
      wrap.textContent = matchText;
      // Reading mode is plain DOM — wire click directly. (Live Preview /
      // Source mode go through the CodeMirror domEventHandlers extension.)
      wrap.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.focusCommentInPanel(c.id);
      });
      const authorName = this.settings.authorName || 'Me';
      wrap.title = (c.thread && c.thread.length > 0)
        ? `${authorName}: ${c.comment} (+${c.thread.length} replies)`
        : `${authorName}: ${c.comment}`;
      return wrap;
    };

    const sectionInfo = typeof ctx.getSectionInfo === 'function'
      ? ctx.getSectionInfo(el)
      : null;

    if (sectionInfo) {
      const { text, lineStart, lineEnd } = sectionInfo;
      const sourceLines = text.split('\n');

      // Only attempt comments whose line range overlaps this section.
      const relevant = comments.filter(c =>
        c.endLine >= lineStart && c.startLine <= lineEnd
      );

      for (const c of relevant) {
        // Clip the comment's range to this section's range — so multi-section
        // comments get a portion-per-section highlight rather than failing
        // to match a whole-comment needle that spans across blocks.
        const needle = sliceCommentToSection(sourceLines, c, lineStart, lineEnd);
        if (!needle) continue;
        const stripped = stripMarkdown(needle).trim();
        if (stripped.length < 3) continue;
        wrapTextInElement(el, stripped, makeWrapper(c));
      }
      return;
    }

    // Fallback: no section info. Strip stored selectedText and try.
    for (const c of comments) {
      const raw = c.selectedText;
      if (!raw) continue;
      const stripped = stripMarkdown(raw).trim();
      if (stripped.length < 3) continue;
      wrapTextInElement(el, stripped, makeWrapper(c));
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  refreshAllViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => {
      if (leaf.view && typeof leaf.view.render === 'function') leaf.view.render();
    });
  }

  async tryMigrateFromSideNote() {
    try {
      const configDir = this.app.vault.configDir;
      const sourcePath = `${configDir}/plugins/${SOURCE_PLUGIN_ID}/data.json`;

      const exists = await this.app.vault.adapter.exists(sourcePath);
      if (!exists) return 0;

      const raw = await this.app.vault.adapter.read(sourcePath);
      const sourceData = JSON.parse(raw);
      if (!Array.isArray(sourceData.comments)) return 0;

      const migrated = sourceData.comments.map(c => ({
        id: c.id,
        filePath: c.filePath,
        startLine: c.startLine,
        startChar: c.startChar,
        endLine: c.endLine,
        endChar: c.endChar,
        selectedText: c.selectedText,
        selectedTextHash: c.selectedTextHash,
        comment: c.comment,
        timestamp: c.timestamp,
        isOrphaned: !!c.isOrphaned,
        resolved: !!c.resolved,
        resolvedAt: c.resolvedAt || null,
        thread: Array.isArray(c.thread) ? c.thread : []
      }));

      this.settings.comments = migrated;

      if (sourceData.highlightColor) this.settings.highlightColor = sourceData.highlightColor;
      if (sourceData.highlightOpacity != null) this.settings.highlightOpacity = sourceData.highlightOpacity;
      if (sourceData.showResolvedComments != null) this.settings.showResolvedComments = sourceData.showResolvedComments;
      if (sourceData.commentSortOrder) this.settings.commentSortOrder = sourceData.commentSortOrder;
      if (sourceData.showHighlights != null) this.settings.showHighlights = sourceData.showHighlights;

      await this.saveSettings();

      console.log(`[claudian-side-note] migrated ${migrated.length} comments`);
      return migrated.length;
    } catch (err) {
      console.error('[claudian-side-note] migration failed:', err);
      new obsidian.Notice('Claudian SideNote: migration failed — see developer console');
      return 0;
    }
  }
}

/* ------------------------------------------------------------------------- */
/* View                                                                       */
/* ------------------------------------------------------------------------- */

class ClaudianSideNoteView extends obsidian.ItemView {

  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Comments'; }
  getIcon() { return 'message-square'; }

  async onOpen() {
    this.render();
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.render()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.render()));
  }

  async onClose() {
    this.contentEl.empty();
  }

  render() {
    const container = this.contentEl;

    // Capture focus + cursor state before we wipe the DOM. We restore after
    // the new tree is built so watcher-driven refreshes don't yank focus away
    // mid-typing.
    const focusContext = this.captureFocusContext();

    container.empty();
    container.addClass('claudian-sidenote-panel');

    this.renderHeader(container);

    // Inline draft row — only when there's a pending draft. Lives above the
    // normal comment list so it's the first thing the user sees & types into.
    if (this.plugin.pendingDraft) {
      this.renderDraft(container, this.plugin.pendingDraft);
    }

    const scope = this.plugin.settings.panelScope;
    const activeFile = this.app.workspace.getActiveFile();

    if (scope === 'current-file' && !activeFile) {
      this.renderEmpty(container, 'No active file');
      this.restoreFocusContext(focusContext);
      return;
    }

    // Filter
    let comments = this.plugin.settings.comments.slice();
    if (scope === 'current-file') {
      comments = comments.filter(c => c.filePath === activeFile.path);
    }
    comments = applyTabFilter(comments, this.plugin.settings.tabFilter);

    // Sort by file then position
    comments.sort((a, b) => {
      if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.startChar - b.startChar;
    });

    if (comments.length === 0) {
      this.renderEmpty(
        container,
        scope === 'current-file' ? 'No comments on this file' : 'No comments yet'
      );
      this.restoreFocusContext(focusContext);
      return;
    }

    const body = container.createDiv('csn-body');
    if (scope === 'all-files') {
      this.renderGroupedByFile(body, comments);
    } else {
      this.renderFlatList(body, comments);
    }

    this.restoreFocusContext(focusContext);
  }

  /**
   * Capture which textarea (if any) in our panel was focused, and where the
   * cursor was. Used to survive watcher-driven re-renders mid-typing.
   */
  captureFocusContext() {
    const ae = document.activeElement;
    if (!ae || !this.contentEl.contains(ae)) return null;
    if (typeof ae.selectionStart !== 'number') return null; // not a text input

    const base = {
      selectionStart: ae.selectionStart,
      selectionEnd: ae.selectionEnd
    };

    if (ae.classList.contains('csn-draft-input')) {
      return { type: 'draft', ...base };
    }
    if (ae.classList.contains('csn-reply-input')) {
      const card = ae.closest('.csn-comment');
      const cid = card && card.getAttribute('data-comment-id');
      if (cid) return { type: 'reply', commentId: cid, ...base };
    }
    return null;
  }

  /**
   * Restore focus to the matching textarea after a re-render. Best-effort —
   * silently no-ops if the target isn't present anymore (e.g. the comment was
   * deleted while we were typing — unlikely but cheap to guard).
   */
  restoreFocusContext(ctx) {
    if (!ctx) return;
    let target = null;
    if (ctx.type === 'draft') {
      target = this.contentEl.querySelector('.csn-draft-input');
    } else if (ctx.type === 'reply') {
      const card = this.contentEl.querySelector(`.csn-comment[data-comment-id="${ctx.commentId}"]`);
      target = card && card.querySelector('.csn-reply-input');
    }
    if (!target) return;
    target.focus();
    try { target.setSelectionRange(ctx.selectionStart, ctx.selectionEnd); } catch (e) { /* ignore */ }
  }

  /* Header --------------------------------------------------------------- */

  renderHeader(container) {
    const header = container.createDiv('csn-header');

    // Title row: "Comments" + cog
    const titleRow = header.createDiv('csn-title-row');
    titleRow.createEl('h4', { text: 'Comments', cls: 'csn-title' });

    const actions = titleRow.createDiv('csn-header-actions');

    const refreshBtn = actions.createEl('button', { cls: 'csn-icon-btn', attr: { 'aria-label': 'Refresh' } });
    obsidian.setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.render());

    const cogBtn = actions.createEl('button', { cls: 'csn-icon-btn', attr: { 'aria-label': 'Settings' } });
    obsidian.setIcon(cogBtn, 'settings');
    cogBtn.addEventListener('click', (ev) => this.openSettingsMenu(ev));

    // Tabs: All / Unresolved (N) / Resolved (N).
    // Counts respect the current panel scope so the badge agrees with the list below.
    const tabRow = header.createDiv('csn-tab-row');

    const scope = this.plugin.settings.panelScope;
    const activeFile = this.app.workspace.getActiveFile();
    let scoped = this.plugin.settings.comments;
    if (scope === 'current-file' && activeFile) {
      scoped = scoped.filter(c => c.filePath === activeFile.path);
    } else if (scope === 'current-file' && !activeFile) {
      scoped = [];
    }
    const unresolvedCount = scoped.filter(c => !c.resolved).length;
    const resolvedCount = scoped.filter(c => c.resolved).length;

    const current = this.plugin.settings.tabFilter || 'unresolved';

    const makeTab = (key, label, count) => {
      const tab = tabRow.createDiv('csn-tab');
      tab.createSpan({ text: label });
      if (count != null) {
        tab.createSpan({ cls: 'csn-count-pill', text: String(count) });
      }
      if (current === key) tab.addClass('csn-tab-active');
      tab.addEventListener('click', async () => {
        this.plugin.settings.tabFilter = key;
        // Keep legacy boolean in sync so older read paths still behave sanely.
        this.plugin.settings.showResolvedComments = (key === 'all' || key === 'resolved');
        await this.plugin.saveSettings();
        this.render();
      });
    };

    makeTab('all',        'All',        null);
    makeTab('unresolved', 'Unresolved', unresolvedCount);
    makeTab('resolved',   'Resolved',   resolvedCount);
  }

  openSettingsMenu(ev) {
    const menu = new obsidian.Menu();
    const scope = this.plugin.settings.panelScope;

    menu.addItem(item => item
      .setTitle('Current file only')
      .setIcon(scope === 'current-file' ? 'check' : '')
      .onClick(async () => {
        this.plugin.settings.panelScope = 'current-file';
        await this.plugin.saveSettings();
        this.render();
      })
    );

    menu.addItem(item => item
      .setTitle('All files')
      .setIcon(scope === 'all-files' ? 'check' : '')
      .onClick(async () => {
        this.plugin.settings.panelScope = 'all-files';
        await this.plugin.saveSettings();
        this.render();
      })
    );

    menu.addSeparator();

    menu.addItem(item => item
      .setTitle('Re-migrate from SideNote')
      .setIcon('download')
      .onClick(async () => {
        const ok = confirm('Overwrite Claudian SideNote comments with a fresh copy from SideNote?');
        if (!ok) return;
        this.plugin.settings.comments = [];
        const n = await this.plugin.tryMigrateFromSideNote();
        await this.plugin.saveSettings();
        this.render();
        new obsidian.Notice(`Re-migrated ${n} comments`);
      })
    );

    menu.showAtMouseEvent(ev);
  }

  /* Body ---------------------------------------------------------------- */

  renderEmpty(container, text) {
    container.createEl('p', { text, cls: 'csn-empty' });
  }

  /**
   * Inline draft for a brand-new comment. Shows the quoted selection, a
   * textarea for the comment body, and Save/Cancel buttons. Cmd/Ctrl+Enter
   * saves; Escape cancels.
   */
  renderDraft(container, draft) {
    const draftEl = container.createDiv('csn-draft');

    const header = draftEl.createDiv('csn-draft-header');
    header.createSpan({ text: 'New comment', cls: 'csn-draft-title' });
    const baseName = draft.filePath.split('/').pop().replace(/\.md$/, '');
    header.createSpan({ text: baseName, cls: 'csn-draft-file' });

    // Quote — show the selected text so the user can confirm what they're commenting on.
    const quote = draftEl.createDiv('csn-draft-quote');
    obsidian.MarkdownRenderer.render(
      this.app,
      draft.selectedText,
      quote,
      draft.filePath || '',
      this
    );

    // Textarea — auto-focused.
    const textarea = draftEl.createEl('textarea', {
      cls: 'csn-draft-input',
      attr: { placeholder: 'Your comment…', rows: '3' }
    });
    // Restore in-progress text if a previous render captured it.
    textarea.value = draft.text || '';
    // Persist on every keystroke so watcher-driven re-renders don't wipe input.
    textarea.addEventListener('input', () => { draft.text = textarea.value; });
    attachMentionAutocomplete(textarea);

    const actions = draftEl.createDiv('csn-draft-actions');
    const cancelBtn = actions.createEl('button', { text: 'Cancel', cls: 'csn-draft-cancel' });
    const saveBtn = actions.createEl('button', { text: 'Save', cls: 'csn-draft-save mod-cta' });

    const doSave = () => {
      const text = textarea.value.trim();
      if (!text) {
        textarea.focus();
        return;
      }
      this.plugin.saveDraft(text);
    };

    cancelBtn.addEventListener('click', () => this.plugin.cancelDraft());
    saveBtn.addEventListener('click', doSave);

    textarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        doSave();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.plugin.cancelDraft();
      }
    });

    // Auto-focus only on the very first render of this draft (when the user
    // just opened it). Subsequent watcher-driven re-renders mustn't steal
    // focus from wherever the user has moved to.
    if (!draft._rendered) {
      draft._rendered = true;
      setTimeout(() => textarea.focus(), 0);
    }
  }

  renderFlatList(container, comments) {
    const list = container.createDiv('csn-comment-list');
    for (const c of comments) {
      this.renderComment(list, c);
    }
  }

  renderGroupedByFile(container, comments) {
    const groups = new Map();
    for (const c of comments) {
      if (!groups.has(c.filePath)) groups.set(c.filePath, []);
      groups.get(c.filePath).push(c);
    }

    const collapsedSet = new Set(this.plugin.settings.collapsedGroups || []);

    for (const [filePath, group] of groups) {
      const isCollapsed = collapsedSet.has(filePath);
      // File is "deleted" if it no longer resolves in the vault. Comments
      // survive deletion (data is kept) but the group is flagged so the
      // user can choose to clean them up.
      const fileExists = this.app.vault.getAbstractFileByPath(filePath) != null;

      const groupEl = container.createDiv('csn-file-group');
      if (isCollapsed) groupEl.addClass('csn-collapsed');
      if (!fileExists) groupEl.addClass('csn-file-deleted');

      const groupHeader = groupEl.createDiv('csn-file-group-header');

      // Chevron — rotates via CSS based on parent's csn-collapsed class
      const chevron = groupHeader.createSpan('csn-chevron');
      obsidian.setIcon(chevron, 'chevron-down');

      const baseName = filePath.split('/').pop().replace(/\.md$/, '');
      groupHeader.createSpan({ text: baseName, cls: 'csn-file-name' });

      if (!fileExists) {
        groupHeader.createSpan({ text: 'deleted', cls: 'csn-deleted-badge', attr: { title: filePath } });
      }

      groupHeader.createSpan({ text: `${group.length}`, cls: 'csn-count-pill' });

      // For deleted files, offer an inline "remove" affordance. Clicking it
      // shouldn't toggle the collapse — stopPropagation.
      if (!fileExists) {
        const removeBtn = groupHeader.createEl('button', {
          text: '×',
          cls: 'csn-deleted-remove',
          attr: { 'aria-label': `Remove all comments for ${baseName}` }
        });
        removeBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const ok = confirm(
            `Remove all ${group.length} comment${group.length === 1 ? '' : 's'} for the deleted file:\n\n${filePath}\n\nThis can't be undone.`
          );
          if (!ok) return;
          await this.plugin.deleteAllCommentsForPath(filePath);
        });
      }

      // Click anywhere on the header toggles collapsed state
      groupHeader.addEventListener('click', async () => {
        const cur = new Set(this.plugin.settings.collapsedGroups || []);
        if (cur.has(filePath)) cur.delete(filePath);
        else cur.add(filePath);
        this.plugin.settings.collapsedGroups = Array.from(cur);
        await this.plugin.saveSettings();
        this.render();
      });

      // Comment list (hidden via CSS when parent is collapsed)
      const list = groupEl.createDiv('csn-comment-list');
      for (const c of group) {
        this.renderComment(list, c);
      }
    }
  }

  renderComment(container, comment) {
    const card = container.createDiv('csn-comment');
    card.setAttribute('data-comment-id', comment.id);
    if (comment.resolved) card.addClass('csn-resolved');
    if (comment.isOrphaned) card.addClass('csn-orphaned');

    // Header row of the comment (first message: Conrad's initial comment)
    // Treat the legacy `comment` field as the first message in the thread.
    const firstMsg = {
      author: 'conrad',
      text: comment.comment || '',
      timestamp: comment.timestamp
    };

    this.renderMessage(card, firstMsg, comment, /* isFirst */ true);

    // Additional thread items
    for (const msg of (comment.thread || [])) {
      this.renderMessage(card, msg, comment, false);
    }

    // Thinking indicator — shown while a Claudian reply is in flight.
    if (this.plugin.awaitingClaudianFor && this.plugin.awaitingClaudianFor.has(comment.id)) {
      const thinking = card.createDiv('csn-thinking-row');
      const dot = thinking.createSpan('csn-thinking-dot');
      void dot;
      thinking.createSpan({ text: 'Claudian is thinking…', cls: 'csn-thinking-text' });
    }

    // Reply affordance — click to expand an inline reply input on this card.
    const replyRow = card.createDiv('csn-reply-row');
    const replyLink = replyRow.createSpan('csn-reply-link');
    obsidian.setIcon(replyLink, 'corner-down-right');
    replyLink.appendText(' Reply');
    replyLink.title = 'Reply';
    replyLink.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // If an input already exists, focus it instead of stacking another.
      const existing = card.querySelector(':scope > .csn-reply-input-row');
      if (existing) {
        const ta = existing.querySelector('textarea');
        if (ta) ta.focus();
        return;
      }
      // Track open state so refreshes auto-reopen.
      this.plugin.openReplyFor.add(comment.id);
      replyRow.style.display = 'none';
      this.renderReplyInput(card, comment, replyRow);
    });

    // Auto-reopen reply input if it was open before a re-render.
    // Pass autoReopened so it doesn't steal focus from elsewhere.
    if (this.plugin.openReplyFor.has(comment.id)) {
      replyRow.style.display = 'none';
      this.renderReplyInput(card, comment, replyRow, { autoReopened: true });
    }
  }

  /**
   * Inline reply input — appended to a comment card when the user clicks
   * "↳ Reply". Cmd/Ctrl+Enter saves, Esc cancels. `replyRow` is the parent
   * affordance we hide while the input is open and restore on close.
   */
  renderReplyInput(card, comment, replyRow, opts = {}) {
    const row = card.createDiv('csn-reply-input-row');

    const textarea = row.createEl('textarea', {
      cls: 'csn-reply-input',
      attr: { placeholder: 'Reply…', rows: '2' }
    });
    // Restore in-progress text if any.
    textarea.value = this.plugin.pendingReplyTexts.get(comment.id) || '';
    // Persist on every keystroke so refreshes don't wipe input.
    textarea.addEventListener('input', () => {
      this.plugin.pendingReplyTexts.set(comment.id, textarea.value);
    });
    attachMentionAutocomplete(textarea);

    const actions = row.createDiv('csn-reply-actions');
    const cancelBtn = actions.createEl('button', { text: 'Cancel', cls: 'csn-reply-cancel' });
    const saveBtn = actions.createEl('button', { text: 'Reply', cls: 'csn-reply-save mod-cta' });

    const close = () => {
      row.remove();
      if (replyRow) replyRow.style.display = '';
      this.plugin.openReplyFor.delete(comment.id);
      this.plugin.pendingReplyTexts.delete(comment.id);
    };
    const doSave = async () => {
      const text = textarea.value.trim();
      if (!text) { textarea.focus(); return; }
      this.plugin.openReplyFor.delete(comment.id);
      this.plugin.pendingReplyTexts.delete(comment.id);
      await this.plugin.addReplyToComment(comment.id, text);
      // Full re-render happens via refreshAllViews — replyRow comes back naturally.
    };

    cancelBtn.addEventListener('click', (ev) => { ev.stopPropagation(); close(); });
    saveBtn.addEventListener('click', (ev) => { ev.stopPropagation(); doSave(); });

    textarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        doSave();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
      }
    });

    if (!opts.autoReopened) {
      setTimeout(() => textarea.focus(), 0);
    }
  }

  renderMessage(container, msg, parentComment, isFirst) {
    const msgEl = container.createDiv('csn-message');
    msgEl.addClass(msg.author === 'claudian' ? 'csn-msg-claudian' : 'csn-msg-conrad');

    // Header: avatar + name + timestamp + (status icons on first)
    const header = msgEl.createDiv('csn-msg-header');

    const avatar = header.createDiv('csn-avatar');
    avatar.style.backgroundColor = msg.author === 'claudian'
      ? this.plugin.settings.claudianColor
      : this.plugin.settings.conradColor;
    const authorName = this.plugin.settings.authorName || 'Me';
    avatar.setText(msg.author === 'claudian' ? 'AI' : (authorName.trim().charAt(0).toUpperCase() || 'M'));

    const meta = header.createDiv('csn-msg-meta');
    meta.createSpan({ text: msg.author === 'claudian' ? 'Claudian' : authorName, cls: 'csn-msg-name' });
    if (msg.timestamp) {
      meta.createSpan({ text: this.formatRelativeTime(msg.timestamp), cls: 'csn-msg-time' });
    }

    // Status icons + actions (only on the first/root message of a thread)
    if (isFirst) {
      const statusGroup = header.createDiv('csn-msg-status');

      if (parentComment.isOrphaned) {
        const o = statusGroup.createSpan({ cls: 'csn-status-icon csn-status-orphan', attr: { 'aria-label': 'Anchor text orphaned' } });
        obsidian.setIcon(o, 'unlink');
        o.title = 'Anchor text orphaned';
      }

      // Resolve toggle — always visible on first message. Icon swaps:
      // filled check when resolved, open circle when not.
      const resolveBtn = statusGroup.createEl('button', {
        cls: 'csn-status-icon csn-resolve-toggle',
        attr: {
          'aria-label': parentComment.resolved ? 'Mark unresolved' : 'Mark resolved'
        }
      });
      if (parentComment.resolved) resolveBtn.addClass('is-resolved');
      obsidian.setIcon(resolveBtn, parentComment.resolved ? 'check-circle-2' : 'circle');
      resolveBtn.title = parentComment.resolved ? 'Resolved — click to reopen' : 'Mark as resolved';
      resolveBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.plugin.toggleResolve(parentComment.id);
      });

      // Delete — destructive. Confirm before firing.
      const deleteBtn = statusGroup.createEl('button', {
        cls: 'csn-status-icon csn-delete-btn',
        attr: { 'aria-label': 'Delete comment' }
      });
      obsidian.setIcon(deleteBtn, 'trash-2');
      deleteBtn.title = 'Delete comment';
      deleteBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const replyCount = (parentComment.thread || []).length;
        const detail = replyCount > 0
          ? `This comment has ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}. Delete anyway?`
          : 'Delete this comment? This cannot be undone.';
        if (!confirm(detail)) return;
        await this.plugin.deleteComment(parentComment.id);
      });
    }

    // Body — the actual note. Rendered FIRST so the user's comment is always
    // the prominent content, even when the anchored selection below is long.
    if (msg.text) {
      const body = msgEl.createDiv('csn-msg-body');
      // Render markdown — handles bold/italics/links/lists/blockquotes/code/etc.
      // `this` is the MarkdownRenderChild lifecycle hook (ItemView extends Component).
      obsidian.MarkdownRenderer.render(
        this.app,
        msg.text,
        body,
        parentComment.filePath || '',
        this
      );
    }

    // Anchor quote (only on first message) — the quoted source text, shown as
    // secondary context *below* the note. Click to jump to the source.
    if (isFirst && parentComment.selectedText) {
      const quote = msgEl.createDiv('csn-anchor-quote');
      // Render the anchor as markdown so bold/italics/links/lists land as HTML.
      // No truncation here — CSS max-height + scroll handles visual constraint
      // (truncating raw markdown can cut markup in half).
      obsidian.MarkdownRenderer.render(
        this.app,
        parentComment.selectedText,
        quote,
        parentComment.filePath || '',
        this
      );
      quote.title = 'Click to jump to this text';
      quote.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.plugin.jumpToComment(parentComment);
      });
    }

    // Action buttons — only on Claudian-authored messages with `actions` array.
    if (msg.author === 'claudian' && Array.isArray(msg.actions) && msg.actions.length > 0) {
      const actionsEl = msgEl.createDiv('csn-msg-actions');
      for (const action of msg.actions) {
        if (!action || !action.type) continue;
        const btn = actionsEl.createEl('button', {
          text: action.label || action.type,
          cls: 'csn-msg-action ' + (action.type === 'replace' ? 'mod-cta' : '')
        });
        btn.title = this.actionTooltip(action);
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          btn.disabled = true;
          const ok = await this.plugin.executeMessageAction(parentComment.id, action);
          if (ok) {
            // Visually consume so the user knows it landed.
            btn.classList.add('csn-msg-action-done');
            btn.setText('✓ ' + (action.label || action.type));
          } else {
            btn.disabled = false;
          }
        });
      }
    }
  }

  /** Human-readable summary for action button tooltip. */
  actionTooltip(action) {
    switch (action.type) {
      case 'resolve': return 'Mark this comment resolved';
      case 'replace':
        return action.filePath && action.from
          ? `Replace text at ${action.filePath}:${action.from.line + 1}`
          : 'Apply the suggested text change';
      case 'navigate':
        return action.filePath ? `Open ${action.filePath}` : 'Navigate';
      default: return action.type;
    }
  }

  /* Helpers ------------------------------------------------------------ */

  formatRelativeTime(timestamp) {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '';
    const now = Date.now();
    const diffMs = now - date.getTime();
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const week = 7 * day;

    if (diffMs < minute) return 'just now';
    if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
    if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
    if (diffMs < week) return `${Math.floor(diffMs / day)}d ago`;

    // Older — fall back to short date
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return sameYear
      ? date.toLocaleDateString([], { month: 'short', day: 'numeric' })
      : date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  }

  truncate(s, n) {
    if (!s) return '';
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
  }
}

/* ------------------------------------------------------------------------- */
/* Editor highlighting (CodeMirror 6)                                          */
/* ------------------------------------------------------------------------- */

function createHighlightExtension(plugin) {
  const decorator = ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = buildEditorDecorations(view, plugin);
    }
    update(update) {
      // Rebuild on every update — cheap at our scale, avoids missing settings changes.
      this.decorations = buildEditorDecorations(update.view, plugin);
    }
  }, {
    decorations: v => v.decorations
  });

  // Click on a highlight in Live Preview / Source mode → focus the matching
  // comment in the panel. Don't prevent the normal click.
  const clickHandler = EditorView.domEventHandlers({
    click: (event /*, view */) => {
      const target = event.target;
      if (!target || !target.closest) return false;
      const highlight = target.closest('.csn-highlight');
      if (!highlight) return false;
      const id = highlight.getAttribute('data-comment-id');
      if (!id) return false;
      plugin.focusCommentInPanel(id);
      return false;
    }
  });

  return [decorator, clickHandler];
}

function buildEditorDecorations(view, plugin) {
  const filePath = getFilePathFromCmView(view, plugin.app);
  if (!filePath) return Decoration.none;

  let comments = plugin.settings.comments.filter(c =>
    c.filePath === filePath && !c.isOrphaned
  );
  comments = applyTabFilter(comments, plugin.settings.tabFilter);
  if (comments.length === 0) return Decoration.none;

  // RangeSetBuilder requires sorted input
  comments.sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.startChar - b.startChar;
  });

  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  const bg = hexToRgba(plugin.settings.highlightColor, plugin.settings.highlightOpacity);

  for (const c of comments) {
    try {
      // SideNote stores line numbers 0-indexed; CM doc.line() is 1-indexed.
      const startLineNum = c.startLine + 1;
      const endLineNum = c.endLine + 1;
      if (startLineNum < 1 || startLineNum > doc.lines) continue;
      if (endLineNum < 1 || endLineNum > doc.lines) continue;

      const startLine = doc.line(startLineNum);
      const endLine = doc.line(endLineNum);
      const from = Math.min(startLine.from + c.startChar, startLine.to);
      const to = Math.min(endLine.from + c.endChar, endLine.to);
      if (from >= to) continue;

      const decoration = Decoration.mark({
        class: 'csn-highlight',
        attributes: {
          style: `background-color: ${bg};`,
          'data-comment-id': c.id
        }
      });
      builder.add(from, to, decoration);
    } catch (err) {
      console.warn('[claudian-side-note] failed to build decoration for comment', c.id, err);
    }
  }

  return builder.finish();
}

function getFilePathFromCmView(cmView, app) {
  const leaves = app.workspace.getLeavesOfType('markdown');
  for (const leaf of leaves) {
    const v = leaf.view;
    if (v && v.editor && v.editor.cm === cmView) {
      return v.file ? v.file.path : null;
    }
  }
  return null;
}

/**
 * Slice a comment's anchored text, clipped to the line range of the section
 * we're currently rendering.
 *
 * Reading mode's postprocessor fires once per block-level section. A comment
 * that spans multiple sections (e.g. crosses a paragraph break) can't be
 * matched whole inside any one section's textContent — so for each affected
 * section we extract only the slice of the comment that lives inside it,
 * and wrap that slice independently. Visually the highlight reads as
 * continuous across the rendered blocks.
 *
 * `sourceLines` is the full document split by '\n'. `sectionStart`/`sectionEnd`
 * are the section's absolute file line bounds. The comment's positions are
 * also absolute.
 */
function sliceCommentToSection(sourceLines, comment, sectionStart, sectionEnd) {
  const start = Math.max(comment.startLine, sectionStart);
  const end = Math.min(comment.endLine, sectionEnd);
  if (start > end || start >= sourceLines.length) return null;

  const parts = [];
  for (let i = start; i <= end && i < sourceLines.length; i++) {
    let line = sourceLines[i];
    if (line == null) continue;
    // Trim the first and last lines of the comment's range to honour char offsets;
    // lines fully inside the comment use the full line.
    if (i === comment.startLine && i === comment.endLine) {
      line = line.slice(comment.startChar, comment.endChar);
    } else if (i === comment.startLine) {
      line = line.slice(comment.startChar);
    } else if (i === comment.endLine) {
      line = line.slice(0, comment.endChar);
    }
    parts.push(line);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Strip the common markdown syntax that lives inside selectedText so we can
 * substring-match against rendered (plain-text) HTML. Order matters: links
 * before brackets, bold before italic, etc.
 */
function stripMarkdown(text) {
  return text
    // links: [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // images: ![alt](url) -> alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // wiki-links: [[note|alias]] -> alias, [[note]] -> note
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    // bold: **text** or __text__
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // italic: *text* or _text_
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1$2')
    // strikethrough
    .replace(/~~([^~]+)~~/g, '$1')
    // Obsidian highlight ==text==
    .replace(/==([^=]+)==/g, '$1')
    // inline code: `text`
    .replace(/`([^`]+)`/g, '$1')
    // leading list bullets and ordered list numbers
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    // leading heading hashes
    .replace(/^#+[ \t]+/gm, '')
    // leading blockquote markers
    .replace(/^[ \t]*>[ \t]?/gm, '');
}

/**
 * Find `searchText` inside `rootEl`'s concatenated textContent (first match
 * only) and wrap each text-node segment that the match spans, using the
 * provided `makeWrapper(matchSegment)` factory.
 *
 * Handles the multi-node case where a match crosses <strong>, <em>, <a>, etc.
 * Returns true if a match was wrapped.
 */
function wrapTextInElement(rootEl, searchText, makeWrapper) {
  // Collect text nodes, skipping anything already inside a highlight.
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.parentElement && n.parentElement.closest('.csn-highlight')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const entries = [];
  let offset = 0;
  let n;
  while ((n = walker.nextNode())) {
    entries.push({ node: n, start: offset, end: offset + n.nodeValue.length });
    offset += n.nodeValue.length;
  }

  if (entries.length === 0) return false;

  const fullText = entries.map(e => e.node.nodeValue).join('');
  const idx = fullText.indexOf(searchText);
  if (idx === -1) return false;
  const endIdx = idx + searchText.length;

  // Wrap each overlapping text-node segment. Iterate a stable copy because
  // we'll mutate the tree as we go.
  for (const entry of entries) {
    if (entry.end <= idx || entry.start >= endIdx) continue;
    const localStart = Math.max(0, idx - entry.start);
    const localEnd = Math.min(entry.node.nodeValue.length, endIdx - entry.start);

    const node = entry.node;
    const value = node.nodeValue;
    const before = value.slice(0, localStart);
    const match = value.slice(localStart, localEnd);
    const after = value.slice(localEnd);
    if (!match) continue;

    const wrap = makeWrapper(match);
    const parent = node.parentNode;
    if (!parent) continue;
    if (before) parent.insertBefore(document.createTextNode(before), node);
    parent.insertBefore(wrap, node);
    if (after) parent.insertBefore(document.createTextNode(after), node);
    parent.removeChild(node);
  }

  return true;
}

/**
 * Filter a list of comments according to the panel's tab selection.
 * 'unresolved' (default): only !resolved
 * 'resolved': only resolved
 * 'all': no filtering
 */
function applyTabFilter(comments, tabFilter) {
  switch (tabFilter) {
    case 'all':       return comments;
    case 'resolved':  return comments.filter(c => c.resolved);
    case 'unresolved':
    default:          return comments.filter(c => !c.resolved);
  }
}

/**
 * Attach a minimal `@`-mention autocomplete to a textarea. When the user
 * types `@` (at start or after whitespace) followed by a prefix matching
 * "claudian", a floating chip appears with the completion. Tab accepts.
 *
 * Returns a cleanup function that the caller can invoke to remove the popup
 * (we don't bother — DOM is torn down when the panel re-renders).
 */
function attachMentionAutocomplete(textarea) {
  const SUGGESTION = '@claudian';
  const PREFIX = 'claudian'; // what the partial after @ must be a prefix of

  const popup = document.createElement('div');
  popup.className = 'csn-mention-popup';
  popup.style.display = 'none';
  popup.innerHTML = `<span class="csn-mention-suggestion">${SUGGESTION}</span><span class="csn-mention-hint">Tab</span>`;
  document.body.appendChild(popup);

  let active = false;

  const hide = () => {
    if (!active) return;
    active = false;
    popup.style.display = 'none';
  };

  const reposition = () => {
    const rect = textarea.getBoundingClientRect();
    popup.style.left = `${rect.left + 8}px`;
    popup.style.top = `${rect.bottom + 4}px`;
  };

  const refresh = () => {
    const cursor = textarea.selectionStart;
    const before = textarea.value.slice(0, cursor);
    // Match `@` at start-of-string or after whitespace, followed by 0+ word chars.
    const match = before.match(/(^|\s)@(\w{0,16})$/);
    if (!match) { hide(); return; }
    const partial = match[2].toLowerCase();
    if (partial && !PREFIX.startsWith(partial) && !'claude'.startsWith(partial)) {
      hide();
      return;
    }
    active = true;
    popup.style.display = 'flex';
    reposition();
  };

  const accept = () => {
    if (!active) return false;
    const cursor = textarea.selectionStart;
    const before = textarea.value.slice(0, cursor);
    const after = textarea.value.slice(cursor);
    const match = before.match(/(^|\s)@(\w{0,16})$/);
    if (!match) { hide(); return false; }
    // Strip the @ + partial we matched, then insert the full suggestion + space.
    const stripLen = 1 + match[2].length; // '@' + partial
    const prefix = before.slice(0, before.length - stripLen);
    const insertion = SUGGESTION + ' ';
    textarea.value = prefix + insertion + after;
    const newCursor = (prefix + insertion).length;
    textarea.setSelectionRange(newCursor, newCursor);
    hide();
    // Fire input so any downstream listeners (auto-resize, etc.) update.
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };

  textarea.addEventListener('input', refresh);
  textarea.addEventListener('click', refresh);
  textarea.addEventListener('keyup', (ev) => {
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') {
      refresh();
    }
  });
  textarea.addEventListener('keydown', (ev) => {
    if (!active) return;
    if (ev.key === 'Tab') {
      ev.preventDefault();
      accept();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      hide();
    }
  });
  textarea.addEventListener('blur', () => {
    // Give a click-on-popup chance to land (not implemented yet but cheap).
    setTimeout(hide, 150);
  });
  window.addEventListener('scroll', () => { if (active) reposition(); }, true);
  window.addEventListener('resize', () => { if (active) reposition(); });

  return () => popup.remove();
}

/**
 * SHA-256 hex digest of a string. Matches side-note's `selectedTextHash`
 * format so our new comments are schema-compatible.
 */
async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToRgba(hex, opacity) {
  if (!hex || typeof hex !== 'string' || hex.length < 7) {
    return `rgba(255, 200, 0, ${opacity != null ? opacity : 0.2})`;
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const o = opacity != null ? opacity : 0.2;
  return `rgba(${r}, ${g}, ${b}, ${o})`;
}

class ClaudianSideNoteSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h3', { text: 'Claudian SideNote' });

    new obsidian.Setting(containerEl)
      .setName('Your name')
      .setDesc('Display name shown on your comments and replies (the human side of a thread).')
      .addText(text => text
        .setPlaceholder('Me')
        .setValue(this.plugin.settings.authorName)
        .onChange(async (value) => {
          this.plugin.settings.authorName = value.trim() || 'Me';
          await this.plugin.saveSettings();
          this.plugin.refreshAllViews();
        }));

    new obsidian.Setting(containerEl)
      .setName('Your colour')
      .setDesc('Avatar colour for your messages.')
      .addColorPicker(cp => cp
        .setValue(this.plugin.settings.conradColor)
        .onChange(async (value) => {
          this.plugin.settings.conradColor = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAllViews();
        }));

    new obsidian.Setting(containerEl)
      .setName("Claudian's colour")
      .setDesc('Avatar colour for AI (Claudian) messages.')
      .addColorPicker(cp => cp
        .setValue(this.plugin.settings.claudianColor)
        .onChange(async (value) => {
          this.plugin.settings.claudianColor = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAllViews();
        }));
  }
}

module.exports = ClaudianSideNote;
