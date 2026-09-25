import { editorInfoField } from 'obsidian';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { EditorChange, EditorPort, EditorSnapshot, LinkInsertion, TextAnchor, TextRange } from '../linking/types';
import { OrganizerError } from '../core/errors';

interface Suppressed { from: number; to: number; text: string; target: number | null }
export interface EditorBridge {
  identity(path: string): number | null;
  linkedTargets(path: string, text?: string): ReadonlySet<number>;
  changed(sessionId: string, path: string, change?: EditorChange): void;
  idle(sessionId: string): void;
}

export class EditorSessions {
  private readonly sessions = new Map<string, NoteEditorSession>();
  private readonly views = new WeakMap<EditorView, NoteEditorSession>();
  private focused: string | null = null;
  readonly extension: Extension;
  constructor(private readonly bridge: EditorBridge) {
    this.extension = ViewPlugin.define(view => {
      const session = new NoteEditorSession(view, this.bridge, () => { this.focused = session.id; });
      this.sessions.set(session.id, session); this.views.set(view, session);
      if (view.hasFocus) this.focused = session.id;
      return {
        update: (update: ViewUpdate) => session.update(update),
        destroy: () => { session.destroy(); this.sessions.delete(session.id); },
      };
    });
  }
  active(path: string | null): NoteEditorSession | undefined {
    const recent = this.focused ? this.sessions.get(this.focused) : undefined;
    if (recent?.path === path) return recent;
    return [...this.sessions.values()].find(session => session.path === path);
  }
  get(id: string): NoteEditorSession | undefined { return this.sessions.get(id); }
  sessionFor(view: EditorView): NoteEditorSession | undefined { return this.views.get(view); }
  editing(path: string): boolean { return [...this.sessions.values()].some(session => session.path === path && session.focused); }
  dispose(): void { for (const session of this.sessions.values()) session.destroy(); this.sessions.clear(); }
}

export class NoteEditorSession implements EditorPort {
  readonly id = crypto.randomUUID();
  private revision = 0;
  private timer: number | undefined;
  private dirty: TextRange[] = [];
  private suppressions: Suppressed[] = [];
  private insertions: { from: number; original: string; replacement: string; target: number }[] = [];
  private alive = true;
  constructor(private readonly view: EditorView, private readonly bridge: EditorBridge, private readonly focus: () => void) {}
  get path(): string | null { return this.view.state.field(editorInfoField, false)?.file?.path ?? null; }
  get focused(): boolean { return this.view.hasFocus; }
  get currentRevision(): number | null { return this.alive ? this.revision : null; }
  update(update: ViewUpdate): void {
    if (update.focusChanged && this.view.hasFocus) this.focus();
    if (update.docChanged) {
      this.revision++;
      this.suppressions = this.suppressions.flatMap(record => {
        const from = update.changes.mapPos(record.from, 1), to = update.changes.mapPos(record.to, -1);
        return from <= to && this.read(from, to) === record.text ? [{ ...record, from, to }] : [];
      });
      this.dirty = this.dirty.map(range => ({ from: update.changes.mapPos(range.from, -1), to: update.changes.mapPos(range.to, 1) }));
      update.changes.iterChangedRanges((_from, _to, from, to) => { this.dirty.push({ from, to }); });
      this.dirty = this.dirty.slice(-8);
      const undo = update.transactions.some(transaction => transaction.isUserEvent('undo'));
      this.insertions = this.insertions.flatMap(previous => {
        const restoredFrom = update.changes.mapPos(previous.from, -1);
        if (undo && this.read(restoredFrom, restoredFrom + previous.original.length) === previous.original) {
          this.suppressions.push({ from: restoredFrom, to: restoredFrom + previous.original.length, text: previous.original, target: previous.target });
          return [];
        }
        const from = update.changes.mapPos(previous.from, 1);
        return this.read(from, from + previous.replacement.length) === previous.replacement ? [{ ...previous, from }] : [];
      });
      const revision = this.revision;
      if (this.path) this.bridge.changed(this.id, this.path, {
        dirtyRanges: [...this.dirty],
        mapAnchor: anchor => {
          if (anchor.editorSessionId !== this.id || anchor.documentRevision !== revision - 1) return null;
          let touched = false;
          update.changes.iterChangedRanges((from, to) => {
            const end = anchor.contextFrom + anchor.contextText.length;
            if (from <= end && to >= anchor.contextFrom) touched = true;
          });
          if (touched) return null;
          return { ...anchor, documentRevision: revision, from: update.changes.mapPos(anchor.from, 1),
            to: update.changes.mapPos(anchor.to, -1), contextFrom: update.changes.mapPos(anchor.contextFrom, 1) };
        },
      });
    }
    if (update.docChanged || update.selectionSet || update.focusChanged) this.schedule();
  }
  private schedule(): void {
    window.clearTimeout(this.timer);
    if (!this.alive) return;
    this.timer = window.setTimeout(() => {
      if (this.view.composing) { this.schedule(); return; }
      if (this.path) this.bridge.idle(this.id);
    }, 1000);
  }
  snapshot(options?: { dirtyOnly?: boolean }): EditorSnapshot | null {
    const path = this.path, noteId = path ? this.bridge.identity(path) : null;
    if (!this.alive || !path || noteId === null || this.view.composing) return null;
    const selection = this.view.state.selection.main;
    const last = this.dirty[this.dirty.length - 1];
    const center = last ? last.to : selection.head;
    let from = Math.max(0, center - 600), to = Math.min(this.view.state.doc.length, from + 1200);
    from = Math.max(0, to - 1200);
    if (from > 0 && /[\uDC00-\uDFFF]/.test(this.read(from, from + 1))) from++;
    if (to < this.view.state.doc.length && /[\uD800-\uDBFF]/.test(this.read(to - 1, to))) to--;
    const dirtyRanges = options?.dirtyOnly ? [...this.dirty] : undefined;
    return { ...(dirtyRanges ? { dirtyRanges } : {}), sessionId: this.id, noteId, path, revision: this.revision, contextFrom: from, text: this.read(from, to), allowedRanges: this.allowedRanges(from, to), linkedNoteIds: this.bridge.linkedTargets(path) };
  }
  acknowledgeAnalysis(snapshot: EditorSnapshot): void {
    if (snapshot.sessionId !== this.id || snapshot.revision !== this.revision) return;
    const end = snapshot.contextFrom + snapshot.text.length;
    this.dirty = this.dirty.filter(range => range.to < snapshot.contextFrom || range.from > end);
  }
  get length(): number { return this.view.state.doc.length; }
  get head(): number { return this.view.state.selection.main.head; }
  /** Text ranges where a link may be suggested; `parse` waits briefly for a complete syntax tree (whole-note scans). */
  allowedRangesIn(from: number, to: number, parse = false): TextRange[] { return this.allowedRanges(from, to, parse); }
  suppressedAt(from: number, to: number, text: string): boolean { return this.suppressions.some(record => record.from === from && record.to === to && record.text === text); }
  private allowedRanges(from: number, to: number, parse = false): TextRange[] {
    const tree = (parse ? ensureSyntaxTree(this.view.state, to, 200) : null) ?? syntaxTree(this.view.state);
    if (tree.length < to) return [];
    const blocked: TextRange[] = [];
    tree.iterate({ from, to, enter(node) {
      if (/code|math|link|url|image|frontmatter|yaml|html|comment|footnote/i.test(node.name)) {
        blocked.push({ from: Math.max(from, node.from), to: Math.min(to, node.to) });
        return false;
      }
    } });
    // Conservative lexical checks also cover Obsidian-specific syntax tokens.
    const text = this.read(from, to);
    for (const match of text.matchAll(/!?(?:\[\[[\s\S]*?\]\]|\[[^\]\n]*\]\([^\n]*?\))|`+[^\n]*?`+|\$[^\n]*?\$/g)) {
      blocked.push({ from: from + match.index, to: from + match.index + match[0].length });
    }
    if (this.view.state.doc.sliceString(0, 4).startsWith('---')) {
      const frontmatter = this.view.state.doc.sliceString(0, Math.min(this.view.state.doc.length, 1200));
      const end = /^---\s*$/gm;
      end.exec(frontmatter);
      const closing = end.exec(frontmatter);
      blocked.push({ from: 0, to: closing ? closing.index + closing[0].length : this.view.state.doc.length });
    }
    blocked.sort((a, b) => a.from - b.from);
    const ranges: TextRange[] = []; let cursor = from;
    for (const range of blocked) { if (range.from > cursor) ranges.push({ from: cursor, to: range.from }); cursor = Math.max(cursor, range.to); }
    if (cursor < to) ranges.push({ from: cursor, to });
    return ranges;
  }
  read(from: number, to: number): string { return this.view.state.doc.sliceString(Math.max(0, from), Math.min(this.view.state.doc.length, to)); }
  allows(from: number, to: number): boolean { return this.alive && !this.view.composing && this.allowedRanges(from, to).some(range => range.from <= from && range.to >= to); }
  replace(from: number, to: number, replacement: string): void {
    this.replaceMany([{ from, to, replacement }]);
  }
  replaceMany(changes: readonly { from: number; to: number; replacement: string }[]): void {
    const info = this.view.state.field(editorInfoField, false);
    const sorted = [...changes].sort((a, b) => a.from - b.from);
    if (!info?.editor || sorted.some((change, index) => !this.allows(change.from, change.to) ||
        (index > 0 && sorted[index - 1]!.to > change.from))) throw new OrganizerError('stale', 'error.linkStale');
    const editor = info.editor;
    editor.transaction({ changes: sorted.map(change => ({ from: editor.offsetToPos(change.from), to: editor.offsetToPos(change.to), text: change.replacement })) }, 'note-organizer');
  }
  /** Replaces exactly `expected` at [from, to) in one undoable transaction, e.g. to unlink. Link syntax is allowed here. */
  replaceVerified(from: number, to: number, expected: string, replacement: string): void {
    const info = this.view.state.field(editorInfoField, false);
    if (!this.alive || this.view.composing || !info?.editor || this.read(from, to) !== expected) throw new OrganizerError('stale', 'error.linkStale');
    const editor = info.editor;
    editor.transaction({ changes: [{ from: editor.offsetToPos(from), to: editor.offsetToPos(to), text: replacement }] }, 'note-organizer');
  }
  suppressRange(from: number, to: number, text: string): void { this.suppressions.push({ from, to, text, target: null }); this.suppressions = this.suppressions.slice(-256); }
  rememberInsertion(anchor: TextAnchor, replacement: string, target: number): void { this.rememberInsertions([{ anchor, replacement, target }]); }
  rememberInsertions(insertions: readonly LinkInsertion[]): void {
    this.insertions = [...this.insertions, ...insertions.map(({ anchor, replacement, target }) => ({ from: anchor.from, original: anchor.originalText, replacement, target }))].slice(-256);
  }
  suppress(anchor: TextAnchor, target: number | null): void { this.suppressions.push({ from: anchor.from, to: anchor.to, text: anchor.originalText, target }); this.suppressions = this.suppressions.slice(-256); }
  suppressed(anchor: TextAnchor): boolean { return this.suppressions.some(record => record.from === anchor.from && record.to === anchor.to && record.text === anchor.originalText); }
  clearSuppressions(): void { this.suppressions = []; this.dirty = []; }
  forConfirmation(): EditorPort {
    return { snapshot: () => { const snapshot = this.snapshot(); return snapshot ? { ...snapshot, linkedNoteIds: this.bridge.linkedTargets(snapshot.path, this.view.state.doc.toString()) } : null; }, read: (a, b) => this.read(a, b), allows: (a, b) => this.allows(a, b), replace: (a, b, text) => this.replace(a, b, text), replaceMany: changes => this.replaceMany(changes), rememberInsertions: insertions => this.rememberInsertions(insertions), suppress: (anchor, target) => this.suppress(anchor, target) };
  }
  destroy(): void { this.alive = false; window.clearTimeout(this.timer); this.suppressions = []; }
}
