// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { AnalysisModal } from '../src/ui/analysis-modal';
import { LinkSuggestionsModal } from '../src/ui/link-modal';
import { DestinationPicker } from '../src/ui/target-picker';
import type { OrganizerController } from '../src/ui/types';
import type { LinkPlan, LinkProposal } from '../src/linking/types';
import { DEFAULT_SETTINGS } from '../src/settings';
import { context } from './helpers';
import { setLocale } from '../src/i18n';

beforeEach(() => setLocale('en'));
afterEach(() => document.body.replaceChildren());
const app = {} as App;
it('requires explicit batch confirmation and passes exactly the selected newest subset', () => {
  const controller = { settings: () => DEFAULT_SETTINGS, previewAnalysis: () => ({ notes: [{ path: 'Inbox/new.md' }, { path: 'Inbox/old.md' }], requestsPerNote: { min: 1, max: 3 }, remainingRequests: 4, recommendedCount: 1 }), analyzeInbox: vi.fn() } as unknown as OrganizerController;
  const modal = new AnalysisModal(app, controller); modal.open();
  expect(controller.analyzeInbox).not.toHaveBeenCalled(); expect(modal.contentEl.textContent).toContain('TypeSafe Jev');
  expect([...modal.contentEl.querySelectorAll('input')].map(input => input.checked)).toEqual([true, false]);
  [...modal.contentEl.querySelectorAll('button')].find(button => button.textContent === 'Analyze 1 notes')!.click();
  expect(controller.analyzeInbox).toHaveBeenCalledExactlyOnceWith(['Inbox/new.md']); expect(modal.contentEl.isConnected).toBe(false);
});
it('does not start analysis when batch confirmation is cancelled', () => {
  const controller = { settings: () => DEFAULT_SETTINGS, previewAnalysis: () => ({ notes: [], requestsPerNote: { min: 1, max: 1 }, remainingRequests: 0, recommendedCount: 0 }), analyzeInbox: vi.fn() } as unknown as OrganizerController;
  const modal = new AnalysisModal(app, controller); modal.open(); modal.close(); expect(controller.analyzeInbox).not.toHaveBeenCalled();
});
it('confirms only two selected links in one batch and marks remaining stale proposals', () => {
  let emit = () => undefined as void;
  const proposals: LinkProposal[] = ['Alpha', 'Beta', 'Gamma'].map((name, index) => ({ id: name, context, selected: index, input: { catalogueEpoch: 1, anchor: { editorSessionId: 's', noteId: 9, sourcePath: 'Inbox/source.md', documentRevision: 1, from: 0, to: name.length, originalText: name, contextFrom: 0, contextText: name + ' is useful.' }, candidates: [{ noteId: index, path: 'Resources/' + name + '.md', title: name, aliases: [], tags: [], description: '', revision: 1 }] } }));
  let current = proposals;
  const controller = {
    state: () => ({ links: current, activePath: 'Inbox/source.md' }), subscribe: (callback: () => void) => { emit = callback; return () => undefined; },
    prepareLink: (proposal: LinkProposal) => ({ id: proposal.id, proposalId: proposal.id, anchor: proposal.input.anchor, target: proposal.input.candidates[0]!, replacement: 'link', catalogueEpoch: 1, settingsRevision: 1 }),
    confirmLinks: vi.fn((plans: readonly LinkPlan[]) => ({ appliedPlanIds: plans.map(plan => plan.id), failures: [] })),
  } as unknown as OrganizerController;
  const modal = new LinkSuggestionsModal(app, controller); modal.open();
  modal.contentEl.querySelectorAll<HTMLInputElement>('input')[1]!.click();
  [...modal.contentEl.querySelectorAll('button')].find(button => button.textContent === 'Add 2 links')!.click();
  expect(controller.confirmLinks).toHaveBeenCalledTimes(1); expect(vi.mocked(controller.confirmLinks).mock.calls[0]![0].map(plan => plan.id)).toEqual(['Alpha', 'Gamma']);
  expect(modal.contentEl.textContent).toContain('Undo once'); current = []; emit(); expect(modal.contentEl.textContent).toContain('Find links again'); modal.close();
});
it('requires a second explicit confirmation before creating a missing destination', async () => {
  const controller = { settings: () => ({ ...DEFAULT_SETTINGS, inbox: 'Inbox', excludedPaths: ['Private'] }), allFolders: () => ['Inbox', 'Resources'], folders: () => [{ id: 'r', path: 'Resources' }], createDestination: vi.fn(async (path: string) => ({ id: 'new', path })) } as unknown as OrganizerController;
  const choose = vi.fn(), picker = new DestinationPicker(app, controller, choose);
  expect(picker.getSuggestions('Private/secret')).toEqual([]); expect(picker.getSuggestions('../outside')).toEqual([]); expect(picker.getSuggestions('Inbox/new')).toEqual([]);
  const suggestion = picker.getSuggestions('Projects/New')[0]!; expect(suggestion).toBeDefined(); picker.onChooseItem(suggestion.item);
  expect(controller.createDestination).not.toHaveBeenCalled(); expect(choose).not.toHaveBeenCalled();
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Create folder')!.click(); await Promise.resolve(); await Promise.resolve();
  expect(controller.createDestination).toHaveBeenCalledExactlyOnceWith('Projects/New'); expect(choose).toHaveBeenCalledExactlyOnceWith('new');
});
