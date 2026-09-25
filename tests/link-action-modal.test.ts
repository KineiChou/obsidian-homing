// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/settings';
import { setLocale } from '../src/i18n';
import { LinkActionModal } from '../src/ui/link-action-modal';
import type { LinkMention, OrganizerController } from '../src/ui/types';
import { deferred, target } from './helpers';

beforeEach(() => { setLocale('en'); document.body.replaceChildren(); });
const mention = (tier: LinkMention['tier']): LinkMention => ({ verdictKey: 'k', from: 0, to: 9, text: 'Attention', tier, candidates: [1, 2].map((id, index) => ({ target: target(id, index ? 'Attention (other)' : 'Attention'), kind: 'title' as const, score: 1, commonness: .5, related: 0 })) });
function fixture() {
  const verdict = deferred<number | null>();
  const controller = {
    settings: () => DEFAULT_SETTINGS, verifyLink: vi.fn(() => verdict.promise), removeLink: vi.fn(),
    linkProposalFor: vi.fn(() => ({ id: 'proposal' })), prepareLink: vi.fn(() => ({ id: 'plan' })), confirmLinks: vi.fn(() => ({ appliedPlanIds: ['plan'], failures: [] })),
    dismissLink: vi.fn(), ignoreLinkTerm: vi.fn(async () => undefined),
  };
  const labels = (modal: LinkActionModal) => [...modal.contentEl.querySelectorAll('button')].map(item => item.textContent);
  const choose = (modal: LinkActionModal, text: string) => [...modal.contentEl.querySelectorAll('button')].find(item => item.textContent?.startsWith(text))!.click();
  return { verdict, controller, labels, choose, open: (value: ConstructorParameters<typeof LinkActionModal>[2]) => { const modal = new LinkActionModal({} as App, controller as unknown as OrganizerController, value); modal.open(); return modal; } };
}

it('offers to unlink an existing link and keeps its text', () => {
  const f = fixture(), link = { from: 0, to: 9, text: '[[Us|We]]', display: 'We', target: 'Us' };
  const modal = f.open({ kind: 'link', session: 's', link });
  expect(f.labels(modal)).toEqual(['Remove link, keep “We”']);
  f.choose(modal, 'Remove link'); expect(f.controller.removeLink).toHaveBeenCalledWith('s', link);
});

it('checks an ambiguous mention once and moves the recommended note to the top', async () => {
  const f = fixture(), modal = f.open({ kind: 'mention', session: 's', mention: mention('uncertain') });
  expect(f.controller.verifyLink).toHaveBeenCalledOnce();
  expect(f.labels(modal)).toEqual(['Link to Resources › Attention', 'Link to Resources › Attention (other)', 'Don’t link here', 'Never suggest “Attention”']);
  f.verdict.resolve(2); await vi.waitFor(() => expect(f.labels(modal)[0]).toBe('Link to Resources › Attention (other) (recommended)'));
  f.choose(modal, 'Link to Resources › Attention (other)');
  expect(f.controller.linkProposalFor).toHaveBeenCalledWith('s', expect.objectContaining({ text: 'Attention' }), 2);
  expect(f.controller.confirmLinks).toHaveBeenCalledWith([{ id: 'plan' }]);
});

it('links a clear mention without asking the model, or ignores it here', () => {
  const f = fixture(), modal = f.open({ kind: 'mention', session: 's', mention: mention('confident') });
  expect(f.controller.verifyLink).not.toHaveBeenCalled(); expect(f.labels(modal)[0]).toBe('Link to Resources › Attention (recommended)');
  f.choose(modal, 'Don’t link here'); expect(f.controller.dismissLink).toHaveBeenCalledWith({ id: 'proposal' });
});
