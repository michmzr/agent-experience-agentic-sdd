import type { DebriefKey, DebriefTerminalHost, DebriefTerminalSize } from '../../src/review/debrief-terminal.js';

export class FakeDebriefTerminalHost implements DebriefTerminalHost {
  readonly interactive: boolean;
  readonly color: boolean;
  readonly frames: string[] = [];
  readonly output: string[] = [];
  readonly requestedSizes: DebriefTerminalSize[] = [];
  enterCalls = 0;
  leaveCalls = 0;
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  private handlers: Parameters<DebriefTerminalHost['subscribe']>[0] | undefined;
  private readonly failEnter: boolean;
  private readonly failFrame: boolean;
  private readonly failLeave: boolean;
  private readonly failUnsubscribe: boolean;

  constructor(options: { interactive?: boolean; color?: boolean; size?: DebriefTerminalSize; failEnter?: boolean; failFrame?: boolean; failLeave?: boolean; failUnsubscribe?: boolean } = {}) {
    this.interactive = options.interactive ?? true;
    this.color = options.color ?? false;
    this.currentSize = options.size ?? { width: 100, height: 30 };
    this.failEnter = options.failEnter ?? false;
    this.failFrame = options.failFrame ?? false;
    this.failLeave = options.failLeave ?? false;
    this.failUnsubscribe = options.failUnsubscribe ?? false;
  }

  private currentSize: DebriefTerminalSize;

  size(): DebriefTerminalSize { this.requestedSizes.push(this.currentSize); return this.currentSize; }
  enter(): void { this.enterCalls += 1; if (this.failEnter) throw new Error('enter failed'); this.output.push('enter'); }
  writeFrame(frame: string): void { if (this.failFrame) throw new Error('frame failed'); this.frames.push(frame); this.output.push(frame); }
  subscribe(handlers: Parameters<DebriefTerminalHost['subscribe']>[0]): () => void {
    this.subscribeCalls += 1;
    this.handlers = handlers;
    return () => { this.unsubscribeCalls += 1; this.handlers = undefined; if (this.failUnsubscribe) throw new Error('unsubscribe failed'); };
  }
  leave(): void { this.leaveCalls += 1; this.output.push('leave'); if (this.failLeave) throw new Error('leave failed'); }
  key(key: DebriefKey): void { queueMicrotask(() => this.handlers?.key(key)); }
  resize(size: DebriefTerminalSize): void { this.currentSize = size; queueMicrotask(() => this.handlers?.resize(size)); }
  end(): void { queueMicrotask(() => this.handlers?.end()); }
  error(): void { queueMicrotask(() => this.handlers?.error()); }
  interrupt(): void { queueMicrotask(() => this.handlers?.interrupt()); }
}
