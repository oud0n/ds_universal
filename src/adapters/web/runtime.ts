import type { SchedulerPort } from '../../engine/ports';
export const webScheduler: SchedulerPort = { schedule: (task, ms) => setTimeout(task, ms), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), defer: task => queueMicrotask(task) };

export const webPreferences = { read: (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } }, write: (key: string, value: string | null): void => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* 次回の起動では既定値を使う。 */ } } };
