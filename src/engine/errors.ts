export interface ErrorMessages { ja: string; en: string }
export interface EngineFault { code: string; messages: ErrorMessages }

/** 表示言語・UIを参照しない失敗。ホストがcode/messagesから表示を決める。 */
export class EngineError extends Error implements EngineFault {
  constructor(public readonly code: string, public readonly messages: ErrorMessages) {
    super(messages.en);this.name = 'EngineError';
  }
}
export function fault(code: string, messages: ErrorMessages, range = false): Error & EngineFault {
  return range ? Object.assign(new RangeError(messages.en), { code, messages }) : new EngineError(code, messages);
}
/** 形式名などの既定の表記。実行環境の言語設定は読み込まない。 */
export const defaultText = (_ja: string, en: string): string => en;
