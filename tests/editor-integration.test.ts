// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorChange } from '../src/linking/types';
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
  const undoChanges: import('@codemirror/state').ChangeSet[] = [];
  const editor = {
    offsetToPos: (offset: number) => { const line = view.state.doc.lineAt(offset); return { line: line.number - 1, ch: offset - line.from }; },
    transaction: vi.fn((spec: Parameters<Editor['transaction']>[0]) => {
      const changes = (spec.changes ?? []).map(change => ({ from: view.state.doc.line(change.from.line + 1).from + change.from.ch, to: change.to ? view.state.doc.line(change.to.line + 1).from + change.to.ch : undefined, insert: change.text }));
      const transaction = view.state.update({ changes });
      undoChanges.push(transaction.changes.invert(view.state.doc));
      view.dispatch(transaction);
    }),
  } as unknown as Editor;
  const info = { file, editor } as unknown as MarkdownFileInfo;
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: text, extensions: [markdown(), editorInfoField.init(() => info), sessions.extension] }) });
  cleanup.push(() => { view.destroy(); sessions.dispose(); });
  const session = sessions.active(file.path)!;
  const index = new MemoryMetadataIndex(); index.upsert(target());
  return { view, session, sessions, index, matcher: new LocalMentionMatcher(index), changed, idle, editor, undo: () => { view.dispatch({ changes: undoChanges.pop()!, userEvent: 'undo' }); } };
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


describe('mapped proposals and atomic confirmations', () => {
  function serviceFor(f: ReturnType<typeof fixture>) {
    return new ConfirmedLinkService(f.index, { editor: id => f.sessions.get(id)?.forConfirmation(), generateLink: (target, _path, alias) => `[[${target.path}|${alias}]]`, resolvesTo: () => true, allowed: () => true, settingsRevision: () => 0 });
  }
  it('maps untouched sentences and safely inserts at the shifted UTF-16 anchor', () => {
    const f = fixture('Opening.Transformer here.Elsewhere.');
    const original = f.matcher.inputs(f.session.snapshot()!, () => true)[0]!;
    f.view.dispatch({ changes: { from: 0, insert: '中文 ' } });
    const change = f.changed.mock.calls[0]![2] as EditorChange;
    const anchor = change.mapAnchor(original.anchor)!;
    expect(anchor.from).toBe(original.anchor.from + 3);
    const service = serviceFor(f);
    const plan = service.prepare({ id: 'mapped', input: { ...original, anchor }, context, selected: 1 }, 1);
    service.confirm(plan.id);
    expect(f.view.state.doc.toString()).toBe('中文 Opening.[[Resources/Transformer.md|Transformer]] here.Elsewhere.');
  });
  it('discards anchors when their decisive sentence changes and limits automatic matching to dirty sentences', () => {
    const f = fixture('Transformer here.Elsewhere.');
    const original = f.matcher.inputs(f.session.snapshot()!, () => true)[0]!;
    f.view.dispatch({ changes: { from: 12, insert: 'changed ' } });
    expect((f.changed.mock.calls[0]![2] as EditorChange).mapAnchor(original.anchor)).toBeNull();
    const analyzed = f.session.snapshot({ dirtyOnly: true })!;
    expect(f.matcher.inputs(analyzed, () => true)).toHaveLength(1);
    f.session.acknowledgeAnalysis(analyzed);
    f.view.dispatch({ changes: { from: f.view.state.doc.length, insert: 'more' } });
    expect(f.matcher.inputs(f.session.snapshot({ dirtyOnly: true })!, () => true)).toHaveLength(0);
  });
  it('inserts two of three in one transaction and one inverted CM6 transaction restores and suppresses both', () => {
    const f = fixture('Transformer. Attention. Learning.');
    f.index.upsert(target(2, 'Attention')); f.index.upsert(target(3, 'Learning'));
    const service = serviceFor(f);
    const plans = f.matcher.inputs(f.session.snapshot()!, () => true).map((input, i) => service.prepare({ id: `p${i}`, input, context, selected: i + 1 }, i + 1));
    const result = service.confirmMany([plans[0]!.id, plans[2]!.id]);
    expect(result.appliedPlanIds).toHaveLength(2); expect(result.failures).toEqual([]);
    expect(f.editor.transaction).toHaveBeenCalledTimes(1);
    expect(f.view.state.doc.toString()).toContain('. Attention.');
    expect(() => service.confirm(plans[1]!.id)).toThrow();
    f.undo();
    expect(f.view.state.doc.toString()).toBe('Transformer. Attention. Learning.');
    const inputs = f.matcher.inputs(f.session.snapshot()!, () => true);
    expect(inputs.map(input => f.session.suppressed(input.anchor))).toEqual([true, false, true]);
  });
  it('skips stale, duplicate and overlapping plans without extra transactions', () => {
    const f = fixture('Transformer. Attention.'); f.index.upsert(target(2, 'Attention'));
    const service = serviceFor(f); const inputs = f.matcher.inputs(f.session.snapshot()!, () => true);
    const first = service.prepare({ id: 'first', input: inputs[0]!, context, selected: 1 }, 1);
    const overlap = service.prepare({ id: 'overlap', input: inputs[0]!, context, selected: 1 }, 1);
    const second = service.prepare({ id: 'second', input: inputs[1]!, context, selected: 2 }, 2);
    const result = service.confirmMany(['missing', first.id, first.id, overlap.id, second.id]);
    expect(result.appliedPlanIds).toEqual([first.id, second.id]); expect(result.failures).toHaveLength(3);
    expect(f.editor.transaction).toHaveBeenCalledTimes(1);
  });
  it('rejects a second session while applying valid items from the first session only', () => {
    const f = fixture('Transformer.'); const other = fixture('Transformer.');
    const service = new ConfirmedLinkService(f.index, { editor: id => (f.sessions.get(id) ?? other.sessions.get(id))?.forConfirmation(), generateLink: () => '[[Transformer]]', resolvesTo: () => true, allowed: () => true, settingsRevision: () => 0 });
    const plans = [f, other].map((fixture, i) => service.prepare({ id: `p${i}`, input: fixture.matcher.inputs(fixture.session.snapshot()!, () => true)[0]!, context, selected: 1 }, 1));
    const result = service.confirmMany(plans.map(plan => plan.id));
    expect(result.appliedPlanIds).toEqual([plans[0]!.id]); expect(result.failures[0]?.planId).toBe(plans[1]!.id);
    expect(other.view.state.doc.toString()).toBe('Transformer.'); expect(other.editor.transaction).not.toHaveBeenCalled();
  });
  it('skips a stale target and applies the remaining valid plan in a single transaction', () => {
    const f = fixture('Transformer. Attention.'); f.index.upsert(target(2, 'Attention'));
    const service = serviceFor(f);
    const plans = f.matcher.inputs(f.session.snapshot()!, () => true).map((input, i) => service.prepare({ id: `p${i}`, input, context, selected: i + 1 }, i + 1));
    f.index.upsert(target(1, 'Transformer', { revision: 2 }));
    const result = service.confirmMany(plans.map(plan => plan.id));
    expect(result.appliedPlanIds).toEqual([plans[1]!.id]); expect(result.failures[0]?.planId).toBe(plans[0]!.id);
    expect(f.view.state.doc.toString()).toBe('Transformer. [[Resources/Attention.md|Attention]].');
    expect(f.editor.transaction).toHaveBeenCalledTimes(1);
  });

  it('keeps insertion tracking through unrelated typing and its undo', () => {
    const f = fixture('Transformer. Elsewhere.'); const service = serviceFor(f);
    const input = f.matcher.inputs(f.session.snapshot()!, () => true)[0]!;
    service.confirm(service.prepare({ id: 'first', input, context, selected: 1 }, 1).id);
    const typing = f.view.state.update({ changes: { from: 0, insert: 'prefix ' } });
    const undoTyping = typing.changes.invert(f.view.state.doc);
    f.view.dispatch(typing);
    f.view.dispatch({ changes: undoTyping, userEvent: 'undo' });
    f.undo();
    expect(f.session.suppressed(f.matcher.inputs(f.session.snapshot()!, () => true)[0]!.anchor)).toBe(true);
  });
  it('retains both confirmation batches until each is actually undone', () => {
    const f = fixture('Transformer. Attention.'); f.index.upsert(target(2, 'Attention'));
    const service = serviceFor(f);
    for (const id of [1, 2]) {
      const input = f.matcher.inputs(f.session.snapshot()!, () => true).find(item => item.candidates[0]!.noteId === id)!;
      service.confirm(service.prepare({ id: `p${id}`, input, context, selected: id }, id).id);
    }
    f.undo(); f.undo();
    expect(f.matcher.inputs(f.session.snapshot()!, () => true).map(input => f.session.suppressed(input.anchor))).toEqual([true, true]);
  });
  it('retains dirty sentences after an obsolete analysis and consumes them only after a current analysis', () => {
    const f = fixture('Transformer here. Attention there.'); f.index.upsert(target(2, 'Attention'));
    f.view.dispatch({ changes: { from: 12, insert: 'new ' } });
    const pending = f.session.snapshot({ dirtyOnly: true })!;
    f.view.dispatch({ changes: { from: f.view.state.doc.length - 1, insert: ' changed' } });
    f.session.acknowledgeAnalysis(pending);
    const current = f.session.snapshot({ dirtyOnly: true })!;
    expect(f.matcher.inputs(current, () => true)).toHaveLength(2);
    f.session.acknowledgeAnalysis(current);
    expect(f.matcher.inputs(f.session.snapshot({ dirtyOnly: true })!, () => true)).toHaveLength(0);
  });

});
