// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import type { Editor, MarkdownFileInfo } from 'obsidian';
import { editorInfoField, TFile } from './fakes/obsidian';
import { EditorSessions } from '../src/obsidian/editor-extension';
import { MemoryMetadataIndex } from '../src/linking/metadata-index';
import { LocalMentionMatcher } from '../src/linking/mention-matcher';
import { ConfirmedLinkService } from '../src/linking/link-service';
import { context, target } from './helpers';

const cleanup: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('requestAnimationFrame', () => 0); vi.stubGlobal('cancelAnimationFrame', () => undefined); });
afterEach(() => { for (const close of cleanup.splice(0)) close(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture(text: string) {
  const file = new TFile('Inbox/source.md', text); const changed = vi.fn(), idle = vi.fn();
  const sessions = new EditorSessions({ identity: () => 99, linkedTargets: () => new Set(), changed, idle });
  const editor = {
    offsetToPos: (offset: number) => { const line = view.state.doc.lineAt(offset); return { line: line.number - 1, ch: offset - line.from }; },
    transaction: (transaction: Parameters<Editor['transaction']>[0]) => {
      const changes = (transaction.changes ?? []).map(change => ({ from: view.state.doc.line(change.from.line + 1).from + change.from.ch, to: change.to ? view.state.doc.line(change.to.line + 1).from + change.to.ch : undefined, insert: change.text }));
      view.dispatch({ changes });
    },
  } as Editor;
  const info = { file, editor } as unknown as MarkdownFileInfo;
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: text, extensions: [markdown(), editorInfoField.init(() => info), sessions.extension] }) });
  cleanup.push(() => { view.destroy(); sessions.dispose(); });
  const session = sessions.active(file.path)!;
  const index = new MemoryMetadataIndex(); index.upsert(target());
  return { view, session, sessions, index, matcher: new LocalMentionMatcher(index), changed, idle };
}
describe('CodeMirror integration', () => {
  it('excludes code, links and YAML from both anchors and outgoing context', () => {
    const f = fixture('---\nsecret: Transformer-private\n---\n\nTransformer text\n\n```js\nTransformer\n```\n\n[[Transformer]]');
    const inputs = f.matcher.inputs(f.session.snapshot()!, () => true);
    expect(inputs).toHaveLength(1); expect(inputs[0]?.anchor.originalText).toBe('Transformer'); expect(inputs[0]?.anchor.contextText).not.toContain('private'); expect(inputs[0]?.anchor.contextText).not.toContain('```');
  });
  it('keeps typing local, invalidates revisions immediately and defers analysis until idle', async () => {
    const f = fixture('Transformer'); const old = f.session.snapshot()!;
    f.view.dispatch({ changes: { from: 11, insert: ' ' } }); expect(f.changed).toHaveBeenCalledTimes(1); expect(f.session.currentRevision).toBe(old.revision + 1); expect(f.idle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999); expect(f.idle).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); expect(f.idle).toHaveBeenCalledTimes(1);
    const snapshot = f.session.snapshot()!; expect(snapshot.text.length).toBeLessThanOrEqual(1200);
  });
  it('inserts through Editor.transaction and suppresses the anchor after undo', () => {
    const f = fixture('Transformer'); const input = f.matcher.inputs(f.session.snapshot()!, () => true)[0]!;
    const service = new ConfirmedLinkService(f.index, { editor: id => f.sessions.get(id)?.forConfirmation(), generateLink: () => '[[Resources/Transformer|Transformer]]', resolvesTo: () => true, allowed: () => true, settingsRevision: () => 0 });
    const plan = service.prepare({ id: 'p', input, context, selected: 1 }, 1); f.session.rememberInsertion(plan.anchor, plan.replacement, 1); service.confirm(plan.id);
    expect(f.view.state.doc.toString()).toBe(plan.replacement);
    f.view.dispatch({ changes: { from: 0, to: plan.replacement.length, insert: 'Transformer' }, userEvent: 'undo' });
    const next = f.matcher.inputs(f.session.snapshot()!, () => true)[0]!; expect(f.session.suppressed(next.anchor)).toBe(true);
  });
  it('retains dismissal when text is inserted elsewhere and frees sessions on destroy', () => {
    const f = fixture('Transformer'); const input = f.matcher.inputs(f.session.snapshot()!, () => true)[0]!; f.session.suppress(input.anchor, 1);
    f.view.dispatch({ changes: { from: 0, insert: '学习 ' } }); const next = f.matcher.inputs(f.session.snapshot()!, () => true)[0]!; expect(f.session.suppressed(next.anchor)).toBe(true);
    f.sessions.dispose(); expect(f.sessions.get(f.session.id)).toBeUndefined();
  });
});
