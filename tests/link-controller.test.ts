// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import type { MarkdownFileInfo, Plugin as ObsidianPlugin } from 'obsidian';
import { ObsidianOrganizer } from '../src/obsidian/controller';
import { DEFAULT_SETTINGS } from '../src/settings';
import { FakeApp, Plugin, TFolder, editorInfoField, requestUrl } from './fakes/obsidian';

const cleanup: (() => void)[] = [];
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('requestAnimationFrame', () => 0); vi.stubGlobal('cancelAnimationFrame', () => undefined); });
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function reply(choose: (ids: string[]) => string) {
  requestUrl.mockImplementation(async ({ body }: { body: string }) => {
    const request = JSON.parse(body) as { model: string; questions: Record<string, { criteria: Record<string, unknown> }> };
    return { status: 200, headers: {}, json: { model: request.model, usage: { input_tokens: 5 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const ids = Object.keys(question.criteria), choice = choose(ids);
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(ids.map(item => [item, item === choice ? 1 : 0])) }];
    })) } };
  });
}
async function fixture(text = 'Secret line.\nTransformer encodes audio with Attention here.') {
  const app = new FakeApp(); app.files.set('Inbox', new TFolder('Inbox'));
  const file = app.add('Inbox/source.md', text);
  const ml = app.add('ML/Transformer.md'); app.add('Power/Transformer.md'); app.add('ML/Attention.md');
  const old = app.add('ML/Old.md'); app.caches.set(old, { links: [{ link: 'ML/Transformer', displayText: 'Transformer' }] });
  const plugin = new Plugin(app); plugin.data = { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS, inbox: 'Inbox', secretName: 'key', autoFiling: false }, filingQueue: [], moveJournal: [] };
  const controller = new ObsidianOrganizer(plugin as unknown as ObsidianPlugin); await controller.initialize();
  const posAt = (offset: number) => { const line = view.state.doc.lineAt(offset); return { line: line.number - 1, ch: offset - line.from }; };
  const at = (pos: { line: number; ch: number }) => view.state.doc.line(pos.line + 1).from + pos.ch;
  const editor = { getValue: () => view.state.doc.toString(), offsetToPos: posAt, transaction: ({ changes }: { changes: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string }[] }) => view.dispatch({ changes: changes.map(change => ({ from: at(change.from), to: at(change.to), insert: change.text })) }) };
  const info = { file, editor } as unknown as MarkdownFileInfo;
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: text, extensions: [markdown(), editorInfoField.init(() => info), controller.editors.extension] }) });
  cleanup.push(() => { view.destroy(); void controller.dispose(); plugin.unload(); });
  await vi.waitFor(() => expect(controller.state().indexReady).toBe(true));
  const session = controller.editors.sessionFor(view)!.id;
  const scan = () => controller.scanLinks(session, [{ from: 0, to: view.state.doc.length }]);
  return { app, controller, view, session, scan, ml };
}

it('builds link statistics from metadata and scans locally without any request', async () => {
  const f = await fixture();
  expect([...f.controller.graph.anchorCounts('transformer').keys()]).toEqual([f.controller.vault.id('ML/Transformer.md')]);
  const mentions = f.scan();
  expect(mentions.map(mention => [mention.text, mention.tier])).toEqual([['Transformer', 'uncertain'], ['Attention', 'confident']]);
  expect(mentions[0]!.candidates[0]!.target.path).toBe('ML/Transformer.md');
  expect(requestUrl).not.toHaveBeenCalled();
});

it('verifies an ambiguous mention once with only its sentence, then reuses the verdict', async () => {
  const f = await fixture(); reply(ids => ids.find(id => id !== 'unassigned')!);
  const [transformer] = f.scan();
  const selected = await f.controller.verifyLink(f.session, transformer!);
  expect(requestUrl).toHaveBeenCalledOnce();
  const body = requestUrl.mock.calls[0]![0].body as string;
  expect(body).toContain('Transformer encodes audio'); expect(body).not.toContain('Secret line');
  expect(f.scan()[0]).toMatchObject({ text: 'Transformer', verified: selected });
  expect(await f.controller.verifyLink(f.session, f.scan()[0]!)).toBe(selected); expect(requestUrl).toHaveBeenCalledOnce();
  expect(f.controller.usage().automaticLinkRequests).toBe(1);
  f.view.dispatch({ changes: { from: 0, insert: 'Edit elsewhere. ' } });
  expect(f.scan()[0]).toMatchObject({ text: 'Transformer', verified: selected });
});

it('hides a mention the model says needs no link, and terms the user never wants suggested', async () => {
  const f = await fixture(); reply(() => 'unassigned');
  await f.controller.verifyLink(f.session, f.scan()[0]!);
  expect(f.scan().map(mention => mention.text)).toEqual(['Attention']);
  await f.controller.ignoreLinkTerm('Attention');
  expect(f.scan()).toEqual([]); expect(f.controller.settings().ignoredLinkTerms).toEqual(['Attention']);
});

it('turns a local mention into a confirmed insertion plan through the normal link service', async () => {
  const f = await fixture();
  const attention = f.scan().find(mention => mention.text === 'Attention')!;
  const proposal = f.controller.linkProposalFor(f.session, attention);
  expect(proposal.input.anchor.contextText).toBe('Transformer encodes audio with Attention here.');
  expect(f.controller.prepareLink(proposal, proposal.selected!).replacement).toBe('[[ML/Attention|Attention]]');
  expect(f.controller.searchLinkTargets('transf', 'Inbox/source.md').map(item => item.target.path)).toEqual(['ML/Transformer.md', 'Power/Transformer.md']);
  expect(f.controller.linkMarkdown(f.controller.target(f.controller.vault.id('ML/Transformer.md')!)!, 'Inbox/source.md', '变压器')).toBe('[[ML/Transformer|变压器]]');
});

it('keeps full word boundaries when a viewport cuts into a word', async () => {
  const f = await fixture('SuperAttention works.');
  expect(f.scan()).toEqual([]);
  expect(f.controller.scanLinks(f.session, [{ from: 5, to: f.view.state.doc.length }])).toEqual([]);
});

it('cancels a queued hover check when hover verification is disabled', async () => {
  const f = await fixture(); reply(ids => ids.find(id => id !== 'unassigned')!);
  const response = requestUrl.getMockImplementation()!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  requestUrl.mockImplementationOnce(async args => { await gate; return response(args); });
  const first = f.controller.testConnection(); await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));
  const check = f.controller.verifyLink(f.session, f.scan()[0]!);
  const rejected = expect(check).rejects.toMatchObject({ code: 'stale' });
  await f.controller.saveSettings({ verifyOnHover: false });
  expect(requestUrl).toHaveBeenCalledTimes(1); release(); await first; await rejected;
  expect(requestUrl).toHaveBeenCalledTimes(1); expect(f.controller.usage().automaticLinkRequests).toBe(0);
});

it('rejects an old mention identity after its sentence changes', async () => {
  const f = await fixture(); reply(ids => ids.find(id => id !== 'unassigned')!);
  const mention = f.scan()[0]!;
  const selected = await f.controller.verifyLink(f.session, mention);
  const at = f.view.state.doc.toString().indexOf('audio'); f.view.dispatch({ changes: { from: at, to: at + 5, insert: 'power' } });
  expect(f.scan()[0]).not.toHaveProperty('verified');
  const staleSelection = { ...mention, verified: selected! };
  expect(() => f.controller.linkProposalFor(f.session, staleSelection, selected!)).toThrow();
  await expect(f.controller.verifyLink(f.session, staleSelection)).rejects.toThrow();
});

it('does not publish old confident proposals when an in-flight command is cancelled by editing', async () => {
  const f = await fixture(); reply(ids => ids.find(id => id !== 'unassigned')!);
  f.app.workspace.emit('file-open', f.app.vault.getFileByPath('Inbox/source.md'));
  const response = requestUrl.getMockImplementation()!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  requestUrl.mockImplementationOnce(async args => { await gate; return response(args); });
  const pending = f.controller.findLinks(); const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));
  const at = f.view.state.doc.toString().indexOf('Transformer');
  f.view.dispatch({ changes: { from: at, to: at + 11, insert: 'A component' } });
  await f.controller.findLinks();
  await rejected; release();
  expect(f.controller.state().links).toHaveLength(1);
  expect(f.controller.state().links[0]!.input.anchor.documentRevision).toBe(1);
});

it('rejects query checks outside source scope and late query generations before sending', async () => {
  const f = await fixture(); reply(() => 'unassigned');
  const targets = f.controller.searchLinkTargets('Transformer', 'Inbox/source.md').map(item => item.target);
  await expect(f.controller.verifyLinkQuery('Inbox/source.md', 'Transformer', 'Transformer', targets, () => false)).rejects.toThrow();
  await f.controller.saveSettings({ excludedPaths: ['Inbox'] });
  expect(f.controller.searchLinkTargets('Transformer', 'Inbox/source.md')).toEqual([]);
  await expect(f.controller.verifyLinkQuery('Inbox/source.md', 'Transformer', 'Transformer', targets, () => true)).rejects.toThrow();
  expect(() => f.controller.linkMarkdown(targets[0]!, 'Inbox/source.md')).toThrow();
  expect(requestUrl).not.toHaveBeenCalled();
});

it('rejects query insertion when the selected target version has changed', async () => {
  const f = await fixture();
  const target = f.controller.target(f.controller.vault.id('ML/Transformer.md')!)!;
  f.controller.index.upsert({ ...target, revision: target.revision + 1 });
  expect(() => f.controller.linkMarkdown(target, 'Inbox/source.md')).toThrow();
});

it('rejects a stale candidate identity before creating a proposal or sending a check', async () => {
  const f = await fixture();
  const mention = f.scan()[0]!, target = mention.candidates[0]!.target;
  f.controller.index.upsert({ ...target, revision: target.revision + 1 });
  expect(() => f.controller.linkProposalFor(f.session, mention)).toThrow();
  await expect(f.controller.verifyLink(f.session, mention)).rejects.toThrow();
  expect(requestUrl).not.toHaveBeenCalled();
});

it('rejects a queued query when the UI query generation changes', async () => {
  const f = await fixture(); reply(ids => ids[0]!);
  const response = requestUrl.getMockImplementation()!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  requestUrl.mockImplementationOnce(async args => { await gate; return response(args); });
  const first = f.controller.testConnection(); await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));
  const candidates = f.controller.searchLinkTargets('Transformer', 'Inbox/source.md').map(item => item.target);
  let current = true;
  const pending = f.controller.verifyLinkQuery('Inbox/source.md', 'Transformer', 'Transformer', candidates, () => current);
  const rejected = expect(pending).rejects.toThrow();
  current = false; release(); await first; await rejected;
  expect(requestUrl).toHaveBeenCalledTimes(1);
});

it('keeps sentence-ranked candidates stable across viewport widths and proposal revalidation', async () => {
  const f = await fixture('Power distribution relies on Transformer.');
  f.controller.graph.clear();
  const mention = f.scan()[0]!;
  expect(mention.candidates[0]!.target.path).toBe('Power/Transformer.md');
  const narrow = f.controller.scanLinks(f.session, [{ from: mention.from, to: mention.to }])[0]!;
  expect(narrow.candidates.map(item => item.target.path)).toEqual(mention.candidates.map(item => item.target.path));
  expect(narrow.verdictKey).toBe(mention.verdictKey);
  expect(f.controller.linkProposalFor(f.session, mention).selected).toBe(mention.candidates[0]!.target.noteId);
  reply(ids => ids.find(id => id !== 'unassigned')!);
  await expect(f.controller.verifyLink(f.session, mention)).resolves.toBe(mention.candidates[0]!.target.noteId);
});

it('preserves Chinese word boundaries when the viewport isolates a title inside a longer word', async () => {
  const f = await fixture('这位研究生正在写论文。');
  f.controller.index.upsert({ noteId: 999, path: 'Topics/研究.md', title: '研究', aliases: [], tags: [], description: '', revision: 1 });
  expect(f.scan()).toEqual([]);
  expect(f.controller.scanLinks(f.session, [{ from: 2, to: 4 }])).toEqual([]);
});

it('removes a link at the cursor, keeps its visible text and does not suggest that spot again', async () => {
  const f = await fixture('Transformer encodes audio with [[ML/Attention|attention]] here.');
  const text = '[[ML/Attention|attention]]', from = f.view.state.doc.toString().indexOf(text);
  const link = { from, to: from + text.length, text, display: 'attention', target: 'ML/Attention' };
  f.controller.removeLink(f.session, link);
  expect(f.view.state.doc.toString()).toBe('Transformer encodes audio with attention here.');
  expect(f.scan().map(mention => mention.text)).toEqual(['Transformer']);
  expect(() => f.controller.removeLink(f.session, link)).toThrow();
  expect(f.view.state.doc.toString()).toBe('Transformer encodes audio with attention here.');
});
