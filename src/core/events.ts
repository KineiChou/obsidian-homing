export type Unsubscribe = () => void;
export class Emitter {
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): Unsubscribe { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(): void { for (const listener of this.listeners) listener(); }
  clear(): void { this.listeners.clear(); }
}
