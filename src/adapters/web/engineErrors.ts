import { tr } from '../../utils/i18n';
import type { EngineFault } from '../../engine/errors';

export function localizeEngineError(error: unknown): unknown {
  if (error instanceof Error && 'messages' in error) {
    const { messages } = error as Error & EngineFault;
    if (messages && typeof messages.ja === 'string' && typeof messages.en === 'string') error.message = tr(messages.ja, messages.en);
  }
  return error;
}
export function withEngineErrors<T extends (...args: any[]) => any>(fn: T): T {
  return function(this: unknown, ...args: Parameters<T>) {
    try {
      const value = fn.apply(this, args);
      return value && typeof value.then === 'function' ? value.catch((error: unknown) => { throw localizeEngineError(error); }) : value;
    } catch (error) { throw localizeEngineError(error); }
  } as T;
}
