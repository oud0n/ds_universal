export const CIRCUIT_EN: Record<string, string> = {
  '富士スピードウェイ (FSW)': 'Fuji Speedway (FSW)',
  '鈴鹿サーキット (Suzuka Circuit)': 'Suzuka Circuit',
  '筑波サーキット コース2000 (TC2000)': 'Tsukuba Circuit TC2000',
  '筑波サーキット コース1000 (TC1000)': 'Tsukuba Circuit TC1000',
  '日光サーキット (Nikko Circuit)': 'Nikko Circuit',
  'モビリティリゾートもてぎ (Motegi Road Course)': 'Mobility Resort Motegi (Road Course)',
  'スポーツランドSUGO (Sportsland SUGO)': 'Sportsland SUGO',
  'オートポリス (Autopolis)': 'Autopolis',
  '岡山国際サーキット (Okayama International)': 'Okayama International Circuit',
  '袖ヶ浦フォレストレースウェイ (Sodegaura)': 'Sodegaura Forest Raceway',
  '本庄サーキット (Honjo Circuit)': 'Honjo Circuit',
  'エビスサーキット 東コース (Ebisu East)': 'Ebisu Circuit East Course',
  '名阪スポーツランド (Meihan Sportsland)': 'Meihan Sportsland'
};

/** 内蔵のサーキットの表にある英語名。無ければ名前のまま (記録のフォルダの名前を決めるのに使う。フォルダの名前が変わらないよう、表だけを見る) */
export function circuitTableName(name: string): string {
  return CIRCUIT_EN[name] ?? name;
}

