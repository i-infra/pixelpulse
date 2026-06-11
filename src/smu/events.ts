/**
 * Minimal typed event emitter.
 *
 * Local copy (matches src/dataserver.ts) so the smu/ library has no
 * dependencies outside this directory and can be reused standalone.
 */

export class TypedEvent<T extends unknown[] = []> {
  private listeners: Array<(...args: T) => void> = [];

  subscribe(func: (...args: T) => void): void {
    this.listeners.push(func);
  }

  listen = this.subscribe;

  unListen(func: (...args: T) => void): void {
    const i = this.listeners.indexOf(func);
    if (i !== -1) this.listeners.splice(i, 1);
  }

  notify(...args: T): void {
    for (const func of this.listeners) {
      func(...args);
    }
  }
}
