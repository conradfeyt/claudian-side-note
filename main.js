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
const { ViewPlugin, Decoration } = cmView;
const { RangeSetBuilder } = cmState;

const SOURCE_PLUGIN_ID = 'side-note';
const VIEW_TYPE = 'claudian-side-note-panel';

const DEFAULT_SETTINGS = {
  showHighlights: true,
  showResolvedComments: false,         // false → "Unresolved" tab; true → "All" tab
  highlightColor: '#FFC800',
  highlightOpacity: 0.2,
  commentSortOrder: 'position',
  panelScope: 'current-file',           // 'current-file' | 'all-files'

  conradColor: '#FF8C42',
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
    this.registerEditorExtension([createHighlightExtension(this)]);

    // Editor highlighting — Reading mode (rendered markdown)
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!ctx || !ctx.sourcePath) return;
      this.applyReadingModeHighlights(el, ctx);
    });

    // Transient state — the in-flight comment draft, before the user has
    // typed and saved it. Lives on the plugin instance (not in settings) so
    // it's never persisted across reloads.
    this.pendingDraft = null;

    this.addRibbonIcon('message-square', 'Open Claudian SideNote panel', () => this.activateView());

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
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshAllEditors();
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
  }

  cancelDraft() {
    this.pendingDraft = null;
    this.refreshAllViews();
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
   * Dispatch a no-op transaction on every open CodeMirror editor so the
   * highlight ViewPlugin re-builds decorations from current settings.
   */
  refreshAllEditors() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf && leaf.view;
      if (v && v.editor && v.editor.cm) {
        try { v.editor.cm.dispatch({}); } catch (e) { /* ignore */ }
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
    if (!this.settings.showResolvedComments) {
      comments = comments.filter(c => !c.resolved);
    }
    if (comments.length === 0) return;

    const bg = hexToRgba(this.settings.highlightColor, this.settings.highlightOpacity);
    const makeWrapper = (c) => (matchText) => {
      const wrap = document.createElement('span');
      wrap.className = 'csn-highlight';
      wrap.style.backgroundColor = bg;
      wrap.dataset.commentId = c.id;
      wrap.textContent = matchText;
      wrap.title = (c.thread && c.thread.length > 0)
        ? `Conrad: ${c.comment} (+${c.thread.length} replies)`
        : `Conrad: ${c.comment}`;
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
      return;
    }

    // Filter
    let comments = this.plugin.settings.comments.slice();
    if (scope === 'current-file') {
      comments = comments.filter(c => c.filePath === activeFile.path);
    }
    if (!this.plugin.settings.showResolvedComments) {
      comments = comments.filter(c => !c.resolved);
    }

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
      return;
    }

    const body = container.createDiv('csn-body');
    if (scope === 'all-files') {
      this.renderGroupedByFile(body, comments);
    } else {
      this.renderFlatList(body, comments);
    }
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

    // Tabs: All / Unresolved (N)
    const tabRow = header.createDiv('csn-tab-row');
    const all = this.plugin.settings.comments;
    const unresolvedCount = all.filter(c => !c.resolved).length;

    const allTab = tabRow.createDiv('csn-tab');
    allTab.setText('All');
    if (this.plugin.settings.showResolvedComments) allTab.addClass('csn-tab-active');
    allTab.addEventListener('click', async () => {
      this.plugin.settings.showResolvedComments = true;
      await this.plugin.saveSettings();
      this.render();
    });

    const unresolvedTab = tabRow.createDiv('csn-tab');
    unresolvedTab.createSpan({ text: 'Unresolved' });
    const countPill = unresolvedTab.createSpan({ cls: 'csn-count-pill', text: String(unresolvedCount) });
    if (!this.plugin.settings.showResolvedComments) unresolvedTab.addClass('csn-tab-active');
    unresolvedTab.addEventListener('click', async () => {
      this.plugin.settings.showResolvedComments = false;
      await this.plugin.saveSettings();
      this.render();
    });
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
    quote.textContent = draft.selectedText;

    // Textarea — auto-focused.
    const textarea = draftEl.createEl('textarea', {
      cls: 'csn-draft-input',
      attr: { placeholder: 'Your comment…', rows: '3' }
    });

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
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        doSave();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.plugin.cancelDraft();
      }
    });

    // Defer focus so the textarea is actually mounted before we focus.
    setTimeout(() => textarea.focus(), 0);
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

    // Subtle reply affordance (Stage 5 turns this into an input)
    const replyRow = card.createDiv('csn-reply-row');
    const replyLink = replyRow.createSpan('csn-reply-link');
    obsidian.setIcon(replyLink, 'corner-down-right');
    replyLink.appendText(' Reply');
    replyLink.title = 'Reply UI coming in Stage 5';
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
    avatar.setText(msg.author === 'claudian' ? 'AI' : 'C');

    const meta = header.createDiv('csn-msg-meta');
    meta.createSpan({ text: msg.author === 'claudian' ? 'Claudian' : 'Conrad', cls: 'csn-msg-name' });
    if (msg.timestamp) {
      meta.createSpan({ text: this.formatRelativeTime(msg.timestamp), cls: 'csn-msg-time' });
    }

    // Status icons (only on the first/root message of a thread)
    if (isFirst) {
      const statusGroup = header.createDiv('csn-msg-status');
      if (parentComment.isOrphaned) {
        const o = statusGroup.createSpan({ cls: 'csn-status-icon csn-status-orphan', attr: { 'aria-label': 'Anchor text orphaned' } });
        obsidian.setIcon(o, 'unlink');
        o.title = 'Anchor text orphaned';
      }
      if (parentComment.resolved) {
        const r = statusGroup.createSpan({ cls: 'csn-status-icon csn-status-resolved', attr: { 'aria-label': 'Resolved' } });
        obsidian.setIcon(r, 'check-circle-2');
        r.title = 'Resolved';
      }
    }

    // Anchor quote (only on first message)
    if (isFirst && parentComment.selectedText) {
      const quote = msgEl.createDiv('csn-anchor-quote');
      quote.setText(this.truncate(parentComment.selectedText, 240));
    }

    // Body
    if (msg.text) {
      const body = msgEl.createDiv('csn-msg-body');
      body.setText(msg.text);
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
  return ViewPlugin.fromClass(class {
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
}

function buildEditorDecorations(view, plugin) {
  const filePath = getFilePathFromCmView(view, plugin.app);
  if (!filePath) return Decoration.none;

  let comments = plugin.settings.comments.filter(c =>
    c.filePath === filePath && !c.isOrphaned
  );
  if (!plugin.settings.showResolvedComments) {
    comments = comments.filter(c => !c.resolved);
  }
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

module.exports = ClaudianSideNote;
