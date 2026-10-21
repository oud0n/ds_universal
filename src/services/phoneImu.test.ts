import { describe, expect, it } from 'vitest';
import { carFrameFromGravity, toCar } from './phoneImu';

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe('iPhone の G センサーの、車の向きへの読み替え', () => {
  it('縦向きでホルダーに立て、画面が運転者を向く: 前は背面、右は画面の右', () => {
    const f = carFrameFromGravity([0, -1, 0])!;
    close(f.up, [0, 1, 0]);
    close(f.forward, [0, 0, -1]);
    close(f.right, [1, 0, 0]);
    // 背面の向きへ加速 = 前へ加速
    expect(toCar(f, [0, 0, -0.5]).long).toBeCloseTo(0.5);
    // 画面の右へ動く = 右へ曲がる
    expect(toCar(f, [0.8, 0, 0]).lat).toBeCloseTo(0.8);
  });

  it('横向き (上端を左) でも、前は背面・右は運転者から見て右', () => {
    // 上端を左に倒すと、重力は iPhone の −X へ
    const f = carFrameFromGravity([-1, 0, 0])!;
    close(f.forward, [0, 0, -1]);
    // 運転者から見て右 = iPhone の −Y (下端の向き)
    close(f.right, [0, -1, 0]);
  });

  it('少し傾けて付けても、前後と上下を分ける', () => {
    const tilt = 20 * Math.PI / 180;
    // 上端が後ろへ 20 度倒れている (重力が背面の向きへ少し寄る)
    const f = carFrameFromGravity([0, -Math.cos(tilt), -Math.sin(tilt)])!;
    // 水平に前へ 1 G (車の前 = 水平に直した背面の向き)
    const a = f.forward.map(v => v * 1) as [number, number, number];
    const car = toCar(f, a);
    expect(car.long).toBeCloseTo(1);
    expect(car.vert).toBeCloseTo(0);
  });

  it('平らに置いて背面が下を向くときは、iPhone の上端を前にする', () => {
    const f = carFrameFromGravity([0, 0, -1])!;
    close(f.up, [0, 0, 1]);
    close(f.forward, [0, 1, 0]);
  });
});
