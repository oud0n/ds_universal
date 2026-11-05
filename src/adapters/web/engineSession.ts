import {createEngineSession} from '../../engine/EngineSession';
import {withEngineErrors} from './engineErrors';
/** 状態は同じインスタンス。ホストの言語による例外表示だけを付ける。 */
export function createWebEngineSession(options:Parameters<typeof createEngineSession>[0]) {
 const session=createEngineSession(options);
 session.assign=withEngineErrors(session.assign);
 session.selectCarsAtLapStart=withEngineErrors(session.selectCarsAtLapStart);
 return session;
}
