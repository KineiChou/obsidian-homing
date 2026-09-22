// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewPanel } from '../src/ui/review-panel';
import type { OrganizerController, ReviewState } from '../src/ui/types';
import { DEFAULT_SETTINGS } from '../src/settings';
import { context, deferred, note } from './helpers';
import type { MovePlan } from '../src/filing/types';

afterEach(() => document.body.replaceChildren());
function fixture() {
  let listener = () => undefined as void;
  const state: ReviewState = { filing: [{ path: note.source.path, status: 'ready', updatedAt: 1, message: null, proposal: { id: 'p', source: note.source, foldersRevision: 1, context, selected: 'f1', ranked: [] } }], links: [], activePath: note.source.path, network: { pending: 0, inFlight: false, paused: false, reason: null }, indexReady: true, message: null };
  const plan: MovePlan = { id: 'move', source: note.source, destination: 'Resources/笔记.md', folderId: 'f1', foldersRevision: 1, settingsRevision: 0 };
  const controller = {
    state: () => state, subscribe: (callback: () => void) => { listener = callback; return () => undefined; }, settings: () => ({ ...DEFAULT_SETTINGS, inbox: 'Inbox', secretName: 'key' }),
    folders: () => [{ id: 'f1', path: 'Resources', directPurpose: '', effectiveRules: [] }, { id: 'f2', path: 'Projects', directPurpose: '', effectiveRules: [] }], recentMoves: () => [],
    prepareMove: vi.fn(async () => plan), confirmMove: vi.fn(async () => undefined), undoMove: vi.fn(async () => undefined), openNote: vi.fn(), analyzeInbox: vi.fn(), analyzeNote: vi.fn(), ignoreNote: vi.fn(), findLinks: vi.fn(async () => undefined),
  } as unknown as OrganizerController;
  const container = document.body.appendChild(document.createElement('div'));
  let choose: (id: string) => void = () => undefined;
  const panel = new ReviewPanel(container, controller, { settings: vi.fn(), folder: callback => { choose = callback; }, target: vi.fn() });
  return { container, controller, panel, state, emit: () => listener(), choose: (id: string) => choose(id), plan };
}
function control(container: HTMLElement, text: string) { const button = [...container.querySelectorAll('button')].find(button => button.textContent === text); if (!button) throw Error('Missing button ' + text); return button; }
describe('quiet confirmation interface', () => {
  it('prepares a preview without moving and accepts exactly one click', async () => {
    const f = fixture(); await Promise.resolve(); expect(f.container.textContent).toContain('Resources/笔记.md'); expect(f.controller.confirmMove).not.toHaveBeenCalled();
    const accept = control(f.container, '归档'); accept.click(); accept.click(); await Promise.resolve(); expect(f.controller.confirmMove).toHaveBeenCalledTimes(1); expect(f.container.textContent).toContain('已归档'); f.panel.destroy();
  });
  it('shows only one destination and reveals alternatives on demand', async () => {
    const f = fixture(); await Promise.resolve(); expect(f.container.textContent).not.toContain('Projects/'); expect(f.container.textContent).not.toContain('100%'); control(f.container, '更改位置').click();
    vi.mocked(f.controller.prepareMove).mockResolvedValueOnce({ ...f.plan, id: 'second', folderId: 'f2', destination: 'Projects/笔记.md' }); f.choose('f2'); await Promise.resolve(); expect(f.container.textContent).toContain('Projects/笔记.md'); expect(f.controller.confirmMove).not.toHaveBeenCalled(); f.panel.destroy();
  });
  it('keeps the latest manual destination when older preview work resolves late', async () => {
    const f = fixture(); await Promise.resolve(); const older = deferred<MovePlan>(), newer = deferred<MovePlan>();
    vi.mocked(f.controller.prepareMove).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise); control(f.container, '更改位置').click(); f.choose('f1'); f.choose('f2');
    newer.resolve({ ...f.plan, id: 'newer', destination: 'Projects/笔记.md' }); await Promise.resolve(); older.resolve(f.plan); await Promise.resolve(); control(f.container, '归档').click();
    expect(f.controller.confirmMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'newer' })); f.panel.destroy();
  });
  it('does not steal focus or change mode when background state updates', async () => {
    const f = fixture(); await Promise.resolve(); const editor = document.body.appendChild(document.createElement('textarea')); editor.focus(); f.emit(); expect(document.activeElement).toBe(editor);
    expect(control(f.container, '收件箱').getAttribute('aria-pressed')).toBe('true'); f.panel.destroy();
  });
  it('preserves a focused footer command when background status changes', async () => {
    const f = fixture(); await Promise.resolve(); const command = control(f.container, '分析已有笔记'); command.focus(); f.emit();
    expect(document.activeElement).toBe(command); expect(command.isConnected).toBe(true); f.panel.destroy();
  });
  it('shows unassigned notes collapsed and releases subscriptions when closed', () => {
    const f = fixture(); (f.state.filing as unknown[]) .push({ path: 'Inbox/unclear.md', status: 'unassigned', updatedAt: 1, message: null }); f.emit();
    const pending = [...f.container.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent === '尚未确定位置'); expect(pending?.open).toBe(false); expect(pending?.textContent).toContain('unclear.md'); f.panel.destroy();
    expect([...f.container.querySelector('.note-organizer-list')!.children].indexOf(pending!)).toBeGreaterThan(0);
  });
});
