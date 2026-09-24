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
  const info = { file, editor: { getValue: () => view.state.doc.toString() } } as unknown as MarkdownFileInfo;
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
  expect(f.controller.linkMarkdown('ML/Transformer.md', 'Inbox/source.md', '变压器')).toBe('[[ML/Transformer|变压器]]');
});
