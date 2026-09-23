// The host App survives bundle reloads; module-level state does not.
const handoff = Symbol.for('note-organizer.lifecycle');
interface HostLifecycle { [handoff]?: Promise<void> }
export interface LifecycleLease { readonly previous: Promise<void>; release(): void }
export function claimLifecycle(app: object): LifecycleLease {
  const host = app as HostLifecycle;
  const previous = host[handoff] ?? Promise.resolve();
  let resolve!: () => void;
  const current = new Promise<void>(done => { resolve = done; });
  host[handoff] = current;
  return { previous, release: () => { resolve(); if (host[handoff] === current) delete host[handoff]; } };
}
