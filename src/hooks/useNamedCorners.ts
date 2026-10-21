import { useEffect, useMemo } from 'react';
import { detectCorners, type Corner, type LapGeometry } from '../services/drivingAnalysis';
import { placeCorners, type CornerFile } from '../services/cornerNames';
import { ensureAutoCorners, folderForCircuitName, useCourseCorners } from '../services/courseCorners';

export type NamedCornerOnLap = Corner & { name?: string };

/** 表に出す名前 (名前がなければ、見つけた順の C1…) */
export const cornerLabel = (c: NamedCornerOnLap) => c.name ?? `C${c.number}`;

export interface CourseCornersState {
  /** 基準の周の上のコーナー (名前があれば名前付き) */
  corners: NamedCornerOnLap[];
  /** コースのフォルダ (保管場所の。分からなければ null) */
  folder: string | null;
  /** corners.json (ない・読めないときは null) */
  file: CornerFile | null;
  /** 曲がり具合から見つけたコーナー (作り直すとき) */
  found: Corner[];
}

/**
 * 基準の周のコーナー (PLAN-27)。コースのフォルダに corners.json があれば、その名前と位置で置く。
 * なければ今までどおり見つけた順。保管場所があって corners.json がまだなければ、この周から自動で作る
 */
export function useNamedCorners(geo: LapGeometry | undefined, circuitName: string | undefined): CourseCornersState {
  const folder = useMemo(() => folderForCircuitName(circuitName), [circuitName]);
  const file = useCourseCorners(folder);
  const found = useMemo(() => (geo ? detectCorners(geo) : []), [geo]);
  useEffect(() => {
    if (folder && geo && found.length) void ensureAutoCorners(folder, geo, found);
  }, [folder, geo, found]);
  const corners = useMemo(() => {
    if (!geo || !file || file.corners.length === 0) return found;
    return placeCorners(geo, file.corners).filter((c): c is NonNullable<typeof c> => c !== null);
  }, [geo, file, found]);
  return { corners, folder, file, found };
}
