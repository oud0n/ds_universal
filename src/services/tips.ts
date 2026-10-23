/**
 * 投げ銭 (iPhone のアプリのアプリ内課金。消耗型の「ガソリン 1L・5L・10L」)。
 * 何も解放しない。App Store の決まり (3.1.1) で、アプリの中ではアプリ内課金を通す (外の寄付のページへは案内しない)。
 * パソコン版・ブラウザ版は今までどおり Buy Me a Coffee (DonateModal)
 */
import { callNative, nativeCapabilities } from '../native/bridge';
import type { IapProduct } from '../native/contract';

/** App Store Connect の製品 ID (安い順) */
export const TIP_PRODUCT_IDS = [
  'io.github.oud0n.dsuniversal.tip.gas1',
  'io.github.oud0n.dsuniversal.tip.gas5',
  'io.github.oud0n.dsuniversal.tip.gas10'
] as const;

/** 何リットル分か (製品 ID の終わりの数字) */
export const tipLiters = (id: string): number => Number(/gas(\d+)$/.exec(id)?.[1] ?? 0);

/** アプリ内課金の投げ銭が使えるか (アプリが新しく、課金に対応しているとき) */
export async function tipsAvailable(): Promise<boolean> {
  const caps = await nativeCapabilities();
  return !!caps?.features.iap;
}

/** 商品 (名前・その国の通貨での値段)。読めなければ空 */
export async function loadTips(): Promise<IapProduct[]> {
  const { products } = await callNative('iap.products', { ids: [...TIP_PRODUCT_IDS] });
  return products;
}

export async function buyTip(id: string): Promise<'purchased' | 'cancelled' | 'pending'> {
  return (await callNative('iap.purchase', { id })).status;
}
