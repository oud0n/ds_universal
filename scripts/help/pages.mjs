// 使い方のページの中身 (PLAN-39)。[ ] はボタンの名前、** ** は強調。dev: phone (iPhone・Android) / desktop / browser / pc (デスクトップ・ブラウザ)
// 写真: img: { phone: '<ページ>/phone-<番号>', desktop: '<ページ>/desktop-<番号>' } (日本語・英語の 2 枚が要る)

const PHONE_ONLY = {
  dev: 'pc',
  note: [
    'この操作は、iPhone・Android のアプリだけです (デスクトップ版・ブラウザ版にはありません)。上で iPhone か Android を選ぶと手順が出ます。',
    'This is only in the iPhone and Android apps (not in the desktop app or the browser version). Choose iPhone or Android above to see the steps.'
  ]
};
const NO_STORAGE = {
  dev: 'browser',
  note: [
    '**ブラウザ版には「走行」の画面がありません。**保管場所 (走行のファイルを置くフォルダ) を使えないためです。ログのファイルは [ファイルを開く] で開いてください。',
    '**The browser version has no Runs screen,** because it cannot use a storage folder. Open log files with [Open file].'
  ]
};

export const PAGES = [
  {
    id: 'A1', file: 'a1-start.html',
    title: ['はじめに: インストールと保管場所', 'Getting started: install and storage folder'],
    lead: [
      'LapLoupe は、iPhone・Android のアプリ、デスクトップ版 (Mac・Windows)、ブラウザ版で使えます。走行のファイルは「保管場所」のフォルダにまとめます。iCloud Drive の同じフォルダを選ぶと、iPhone で測った走行を PC でもそのまま開けます。',
      'LapLoupe runs as an iPhone / Android app, a desktop app (Mac / Windows) and in the browser. Your runs live in a "storage folder"; choose the same iCloud Drive folder on each device and the runs you time on the iPhone open on the PC as they are.'
    ],
    blocks: [{
      steps: [
        {
          text: {
            iphone: ['App Store で「LapLoupe」を入れます (公開の準備中です。それまでは TestFlight の試験版を使います)。', 'Install "LapLoupe" from the App Store (being prepared for release; until then, use the TestFlight test version).'],
            android: ['Android 版は、今は試験版です (配られた APK を入れます)。', 'The Android app is a test version for now (install the APK you were given).'],
            desktop: ['GitHub の Releases から Mac 版・Windows 版を落として入れます。Mac 版は Apple の公証を受けた署名付きなので、そのまま開けます。', 'Download the Mac or Windows build from GitHub Releases. The Mac build is signed and notarized by Apple, so it opens as is.'],
            browser: ['https://oud0n.github.io/ds_universal/ を開くだけです (入れる物はありません)。', 'Just open https://oud0n.github.io/ds_universal/ (nothing to install).']
          }
        },
        {
          dev: 'phone desktop',
          text: {
            phone: ['右上の設定のボタン (つまみの絵) を押し、[保管場所] の [フォルダを選ぶ (iCloud Drive など)] で、iCloud Drive に作った **LapLoupe** フォルダを選びます。選ばなければ、この端末の中に置きます。', 'Tap the settings button (sliders icon, top right), then under Storage tap [Choose a folder (iCloud Drive etc.)] and pick the **LapLoupe** folder you made in iCloud Drive. Without it, runs stay inside the app.'],
            desktop: ['左下の [設定] の保管場所で、iPhone と同じ iCloud Drive の **LapLoupe** フォルダを選びます。', 'In [Settings] (bottom left), choose the same iCloud Drive **LapLoupe** folder as on the iPhone.']
          },
          img: { phone: 'a1/phone-1', desktop: 'a1/desktop-1' }
        },
        {
          dev: 'phone desktop',
          text: [
            '保管場所の中は、サーキットごとのフォルダ (例: sodegaura) → 日付のフォルダ → 走行のファイルと動画、と並びます。ラップタイマーで測った走行は自動で入ります。GoPro の動画は、走行と同じ日付のフォルダに入れておくと、走行を開いたときに一緒に出ます。',
            'Inside, there is a folder per circuit (e.g. sodegaura), then a folder per day with the run files and videos. Runs from the lap timer go in automatically. Put GoPro videos in the same day folder as the run and they open with it.'
          ]
        },
        {
          dev: 'iphone',
          text: [
            'デジスパイスのコースデータ (digspice フォルダ) を保管場所に置いたときは、「ファイル」アプリでその **digspice** フォルダを長押しし、[ダウンロードを保持] を選んでください。iCloud にだけあると、アプリを開くたびに 200 個ほどのファイルを取り込むので、走行や動画を開くのが遅くなります。小さなファイルなので、端末の空きはほとんど使いません。',
            'If you put DigSpice course data (the digspice folder) in the storage folder, long-press that **digspice** folder in the Files app and choose [Keep Downloaded]. While it lives only in iCloud, the app downloads about 200 files each time it opens, which slows down opening runs and videos. The files are small and take almost no space.'
          ]
        }
      ]
    }, NO_STORAGE]
  },
  {
    id: 'A2', file: 'a2-devices.html',
    title: ['機器を登録する', 'Registering devices'],
    lead: [
      'デジスパイスや RaceBox などの GPS ロガー、心拍計・OBD のセンサー、GoPro を、アプリから Bluetooth でつなぎます。1 度登録すれば、次からはラップタイマーを開くと自動でつながります。',
      'Connect GPS loggers (DigSpice, RaceBox), sensors (heart rate, OBD) and GoPro cameras over Bluetooth from the app. Once registered, they connect automatically when you open the lap timer.'
    ],
    blocks: [{
      dev: 'phone',
      steps: [
        {
          text: ['設定 → [機器] を開きます。デジスパイスは、本体のスライドスイッチを **BLE** にして [探す] を押し、見つかった機器を選びます。', 'Open Settings → [Devices]. For a DigSpice, set the slide switch on the logger to **BLE**, tap [Search] and pick it.'],
          img: { phone: 'a2/phone-1' }
        },
        {
          text: ['ほかの機器は [機器の登録] のタブ ([位置]・[センサー]・[カメラ]) から足します。登録するときに「ファイル名用の名前」(例: obd_nd5rc) を付けると、センサーの値は走行の横の `<走行>.<名前>.csv` に記録されます (→ G1)。', 'Add other devices from the tabs under [Devices (Bluetooth)] ([Position], [Sensors], [Cameras]). The "file name" you give (e.g. obd_nd5rc) names the sensor log saved next to the run as `<run>.<name>.csv` (→ G1).']
        }
      ]
    }, {
      dev: 'pc',
      note: [
        'Bluetooth の機器の登録は、iPhone・Android のアプリだけです。デスクトップ版・ブラウザ版 (Chrome・Edge) では、デジスパイスを USB でつないで吸い出せます (→ B3)。',
        'Registering Bluetooth devices is only in the iPhone and Android apps. In the desktop app and in Chrome / Edge you can connect a DigSpice by USB and download its logs (→ B3).'
      ]
    }]
  },
  {
    id: 'B1', file: 'b1-timer.html', video: 'V1_timer',
    title: ['サーキットで測る (ラップタイマー)', 'Timing at the circuit (lap timer)'],
    lead: [
      'スマートフォンをホルダーに付けて、周のタイムを測りながら記録します。測った走行は「走行」に入り、あとで解析・動画で見返せます。',
      'Mount the phone and it times your laps while recording. Runs go to Runs, ready to review in Analysis and Video.'
    ],
    blocks: [{
      dev: 'phone',
      steps: [
        {
          text: ['下のタブの [タイマー] を押します。左上の札で、測る機器 (デジスパイス・この端末の GPS など) を確かめます。コースは近くのコースを自動で選びます (札を押すと選び直せます)。', 'Tap [Timer]. The badge at the top left shows the position source (DigSpice, this phone\'s GPS, ...). The course is picked automatically from your location (tap it to change).'],
          img: { phone: 'b1/phone-1' }
        },
        {
          text: ['[測定開始] を押して走り出します。計測線を越えるたびに周を数えます。周を終えると、そのタイムとベストとの差が大きく出ます。下には前の周・ベスト・セクターのタイムが出ます。', 'Tap [Start] and drive. Each time you cross the line a lap is counted; the lap time and the gap to your best flash up. Last lap, best and sector times are shown below.'],
          img: { phone: 'b1/phone-2' }
        },
        {
          text: ['終えるときは [測定終了] → [はい、終了] を押します。走っている間に誤って押しても止まらないよう、確かめの画面が出ます (10 秒で [いいえ、続ける] に戻ります)。', 'To finish, tap [Stop] → [Yes, stop]. A confirmation appears so a stray touch does not stop timing (it returns to [No, keep timing] after 10 s).'],
          img: { phone: 'b1/phone-3' }
        }
      ]
    }, {
      dev: 'phone',
      note: [
        '測っている間は、画面を消さず、アプリを前に出しておいてください。画面の向きは、測定開始のときの向きで固まります (測り終えると戻ります)。',
        'Keep the screen on and the app in front while timing. The screen orientation is locked to the way the phone faces when you start, and released when you stop.'
      ]
    }, PHONE_ONLY]
  },
  {
    id: 'B2', file: 'b2-camera.html',
    title: ['内蔵カメラ・GoPro で一緒に撮る', 'Recording with the camera or a GoPro'],
    lead: [
      '測っている間、スマートフォンのカメラか GoPro で車載動画を撮れます。動画は走行と同じフォルダに入り、時刻が自動で合います。',
      'While timing, record onboard video with the phone camera or a GoPro. The video goes into the run\'s folder and is synced automatically.'
    ],
    blocks: [{
      dev: 'phone',
      steps: [
        {
          text: ['タイマーの右上の ≡ を押し、[内蔵カメラ] の [測っている間、録画する] に印を付けます。[測定開始] で録画が始まり、[測定終了] で止まります。', 'On the timer, tap ≡ (top right) and tick [Record while measuring] under [Built-in camera]. Recording starts with [Start] and stops with [Stop].'],
          img: { phone: 'b2/phone-1' }
        },
        {
          text: ['GoPro は、設定 → [機器] の [カメラ] で登録します。測っている間、車が動き出すと録画を始め、周ごとに印を付け、測定を終えると止めます。', 'Register a GoPro under Settings → [Devices] → [Cameras]. While timing it starts recording when the car moves, marks each lap, and stops when you finish.']
        }
      ]
    }, PHONE_ONLY]
  },
  {
    id: 'B3', file: 'b3-download.html',
    title: ['デジスパイスから吸い出す (USB)', 'Downloading from a DigSpice (USB)'],
    lead: [
      'デジスパイスIV を USB で PC につなぎ、本体に記録した走行ログを吸い出します。',
      'Connect a DigSpice IV to the PC by USB and download the logs stored in it.'
    ],
    blocks: [{
      dev: 'pc',
      steps: [
        { text: ['デジスパイスIV を USB ケーブルで PC につなぎます。', 'Connect the DigSpice IV to the PC with a USB cable.'] },
        {
          text: ['左の [ロガー] を開き、[デジスパイスIV に接続] を押して、出てきた窓で機器を選びます。', 'Open [Logger] on the left, press [Connect to DigSpice IV] and pick the device in the window that appears.'],
          img: { desktop: 'b3/desktop-1' }
        },
        { text: ['[ダウンロード実行] を押すと吸い出します。吸い出したログは、そのまま解析の画面で開けます。', 'Press [DOWNLOAD] to read the logs. They can be opened in Analysis right away.'] }
      ]
    }, {
      dev: 'browser',
      note: ['ブラウザ版で USB を使えるのは、パソコンの Chrome・Edge だけです (Safari・Firefox では使えません)。', 'In the browser, USB works only in desktop Chrome and Edge (not Safari or Firefox).']
    }, {
      dev: 'phone',
      note: ['iPhone・Android のアプリは USB でつながず、Bluetooth で測りながら記録します (→ B1)。', 'The iPhone and Android apps do not use USB; they record over Bluetooth while timing (→ B1).']
    }]
  },
  {
    id: 'C1', file: 'c1-runs.html',
    title: ['走行を見返す', 'Look back at your runs'],
    lead: [
      '測った走行は「走行」の画面にまとまります。日付ごとに、ベストの周・周の数・動画があるかが並び、押すと周の一覧が出ます。',
      'Your runs are collected on the Runs screen. Each run shows its best lap, number of laps and videos; tap it to see every lap.'
    ],
    blocks: [NO_STORAGE, {
      dev: 'phone desktop',
      steps: [
        {
          text: {
            phone: ['下のタブの [走行] を押します。', 'Tap [Runs] in the bottom tabs.'],
            desktop: ['左の [走行] を押します。', 'Click [Runs] on the left.']
          },
          img: { phone: 'c1/phone-1', desktop: 'c1/desktop-1' },
          note: ['走行が新しい順に並びます。紫の数字がその走行のベスト、カメラのマークは動画の数です (「同期済み」なら、動画とログの時刻が合っています)。[コース: すべて] でコースを絞れます。', 'Runs are listed newest first. The purple time is the run\'s best lap; the camera icon shows its videos ("synced" means the video is matched to the log). Use [Course: all] to filter by course.']
        },
        {
          text: ['走行を押すと、周の一覧が出ます。紫がベストの周です。[タイム順] で速い順に並べ替えます。目のマークを押すと、その周を隠します (ピットに入った周など。ベストや順位に数えなくなります。ファイルは消えません)。', 'Tap a run to see its laps. The purple lap is the best. [By time] sorts them fastest first. The eye icon hides a lap (an in-lap, for example) so it no longer counts towards bests and rankings; the file is not deleted.'],
          img: { phone: 'c1/phone-2' }
        },
        { text: ['[解析で開く] で速度のグラフ・コースマップ (→ D1)、[動画を見る] でその走行の動画をメーターと一緒に (→ E1) 見返します。どちらも、いちばん速い周から始まります。', '[Open in Analysis] shows the speed graph and course map (→ D1); [Watch video] plays the run\'s video with the gauges (→ E1). Both start from the fastest lap.'] },
        {
          text: ['コースごとのベストは、一覧の下の [ラップタイム] で見ます。そのコースのすべての走行の周が並び、速い順の 1〜3 位に色が付きます。', 'For the best laps of a course, press [Lap records] under the list. Every lap there is listed, with the top three coloured.'],
          img: { phone: 'c1/phone-3', desktop: 'c1/desktop-2!narrow' }
        }
      ]
    }, {
      dev: 'phone desktop',
      note: ['**「☁️ 未集計」と出る走行**は、iCloud にだけあって、まだこの端末に取り込まれていない走行です。開くと取り込んでから周を数えます。', '**Runs marked "☁️ Not counted"** are only in iCloud and not yet on this device. Opening one downloads it and counts the laps.']
    }]
  },
  {
    id: 'C2', file: 'c2-organize.html', video: 'V7_organize',
    title: ['走行を整理する (名前・車種・タイヤ・天候)', 'Organise your runs (names, car, tyres, weather)'],
    lead: [
      '走行に名前・メモ・車種・タイヤ・天候・気温を書いておくと、一覧に出て、それで絞り込めます。どれも書かなくてかまいません (書いた人だけ使えます)。',
      'Give runs a name, notes, car, tyres, weather and temperatures; they show in the list and you can filter by them. All of it is optional.'
    ],
    blocks: [NO_STORAGE, {
      dev: 'phone desktop',
      steps: [
        {
          text: ['走行を押して詳細を開き、名前・車種・タイヤを書き、天候 (ドライ・ダンプ・ウェット・ヘビーウェット) を選び、気温・路面温度を書きます。欄を離れると保存します。', 'Open a run and fill in the name, car and tyres, choose the weather (dry, damp, wet, heavy wet) and enter air and track temperatures. Each field saves when you leave it.'],
          img: { phone: 'c2/phone-1', desktop: 'c2/desktop-1' }
        },
        {
          text: ['書いた値は一覧に出ます。一覧の上のドロップダウンで、コース・車種・タイヤ・天候を絞れます (書いた走行がある項目だけ出ます)。', 'Entered values show in the list. Use the drop-downs above it to filter by course, car, tyres and weather (each appears only once some run has a value).'],
          img: { phone: 'c2/phone-3', desktop: 'c2/desktop-2' }
        },
        { text: ['[ラップタイム] にも同じ絞り込みがあり、ベスト・順位は絞った中で数えます (例: ウェットのベスト)。', '[Lap records] has the same filters, and bests and rankings count only the filtered runs (e.g. your best in the wet).'] },
        { text: ['速い人のログなど自分のではない走行は、[参考ラップ] に印を付けると「参考ラップ」の側に分かれ、自分のベスト・順位に数えなくなります。', 'Tick [Reference lap] for runs that are not yours (a faster driver\'s log, say); they move to the reference side and are left out of your bests and rankings.'] },
        { text: ['いらない走行は、詳細のいちばん下の [この走行を消す…] で消します。消すファイルの一覧を確かめてから消します (同じ日のほかの走行や、付けていない動画は残します)。', 'Delete a run with [Delete this run…] at the bottom of its details. You confirm the list of files first; other runs from the same day and unattached videos are kept.'] }
      ]
    }]
  },
  {
    id: 'D1', file: 'd1-analysis.html',
    title: ['解析の画面の見方', 'Reading the analysis screen'],
    lead: [
      '速度のグラフとコースマップで、周のどこで速く・遅く走ったかを見ます。グラフ・地図・動画は同じ位置で動きます。',
      'The speed graph and course map show where on the lap you were fast or slow. The graph, map and video all move together.'
    ],
    blocks: [{
      steps: [
        {
          text: ['上は速度のグラフです (横は距離か時間)。黄色の点線はセクター、縦の赤い線は今の位置です。グラフを押すと、その位置へ動きます。', 'The top graph is speed (by distance or time). Yellow dashed lines are sectors; the vertical red line is the current position. Click the graph to jump there.'],
          img: { phone: 'd1/phone-1', pc: 'd1/desktop-1' }
        },
        { text: { phone: ['下の欄の [コース] がコースマップです。車の位置・走った線 (色分け: 車両色・車速・加減速・ライン)・コーナーの番号が出ます。', 'The [Map] tab below is the course map: car position, your line (coloured by car, speed, acceleration or line delta) and corner numbers.'], pc: ['右上がコースマップです。車の位置・走った線 (色分け: 車両色・車速・加減速・ライン)・コーナーの番号が出ます。', 'The course map is at the top right: car position, your line (coloured by car, speed, acceleration or line delta) and corner numbers.'] } },
        { text: ['いちばん下の段で、再生・5 秒戻す/進める・再生の速さを変えます。', 'Use the bottom bar to play, skip 5 s back or forward, and change the speed.'] },
        {
          text: { phone: ['下の欄は、[GG] (縦と横の G の散らばり)・[コーナー]・[ブレーキ]・[X/Y] に切り替えられます (→ D3)。', 'The bottom panel switches to [GG] (spread of longitudinal and lateral G), [Corners], [Braking] and [X/Y] (→ D3).'], pc: ['右下は、フリクションサークル (GG)・コーナー解析・ブレーキング・X/Y グラフに切り替えられます (→ D3)。', 'The bottom-right panel switches between friction circle (GG), corners, braking and X/Y graph (→ D3).'] },
          img: { phone: 'd1/phone-2' }
        },
        { text: ['見る周を替えるときは、上の [走行とコース] で Car 1 の周を選びます。', 'To change the lap, pick Car 1\'s lap in [Runs & course] at the top.'] }
      ]
    }, {
      dev: 'browser',
      note: ['ブラウザ版では、ログのファイルを [ファイルを開く] で開くと、この画面になります。', 'In the browser version, open a log with [Open file] to get this screen.']
    }]
  },
  {
    id: 'D2', file: 'd2-compare.html', video: 'V3_compare',
    title: ['2 つの周を比べる', 'Comparing two laps'],
    lead: [
      '別の日の走行や、同じ走行の別の周を重ねて、どこで差がついたかを見ます。Car 1〜4 の 4 台まで重ねられます。',
      'Overlay a lap from another day, or another lap of the same run, to see where the time went. Up to four cars (Car 1–4).'
    ],
    blocks: [{
      steps: [
        {
          dev: 'phone desktop',
          text: ['走行を開いたまま、[走行] で同じコースの別の走行を押し、[Car 2 として足す] を押します (その走行のベストと比べます)。', 'With a run open, open another run on the same course in [Runs] and press [Add as Car 2] (it compares with that run\'s best).'],
          img: { phone: 'd2/phone-1' }
        },
        {
          dev: 'browser',
          text: ['2 つのログを [ファイルを開く] で開き、[走行とコース] で Car 1・Car 2 に周を割り当てます。', 'Open both logs with [Open file] and assign laps to Car 1 and Car 2 in [Runs & course].']
        },
        {
          text: ['速度のグラフに 2 本の線が重なり、下にタイム差のグラフが出ます。線が上にあるところほど、Car 1 (赤) が先を走っています。コースマップには Car 2 の位置も出ます。', 'The speed graph shows both lines and a time-delta graph appears below; where it is above zero, Car 1 (red) is ahead. Car 2 also appears on the course map.'],
          img: { phone: 'd2/phone-2', pc: 'd2/desktop-1' }
        },
        { text: ['同じ走行のほかの周と比べるときは、[走行とコース] の Car 2〜4 に周を割り当てます。', 'To compare with other laps of the same run, assign them to Car 2–4 in [Runs & course].'] },
        { dev: 'phone desktop', text: ['天候やタイヤをそろえて比べたいときは、先に走行の一覧を絞ってから選びます (→ C2)。', 'To compare like with like, filter the run list by weather or tyres first (→ C2).'] }
      ]
    }]
  },
  {
    id: 'D3', file: 'd3-details.html',
    title: ['コーナー・ブレーキング・GG・値の帯', 'Corners, braking, GG and value strips'],
    lead: [
      'コーナーごとの速さ、ブレーキの踏み方、G の使い方を細かく見ます。アクセル・回転数などの記録があれば、速度のグラフの下に帯で出せます。',
      'Look closer at each corner, your braking and how you use the grip. If throttle, RPM and so on were recorded, show them as strips under the speed graph.'
    ],
    blocks: [{
      steps: [
        {
          text: ['**コーナー**: コーナーごとの進入・ボトム・脱出の速度と、いちばん小さい曲がりの半径 (R) です。行を押すとその場所へ動きます。', '**Corners**: entry, minimum and exit speed and the tightest radius (R) for each corner. Click a row to jump there.'],
          img: { phone: 'd3/phone-1' }
        },
        {
          text: ['**ブレーキング**: ブレーキの区間ごとに、始めた位置・速度の落ち方・止まるまでの距離・いちばん強い減速 G を出します。', '**Braking**: for each braking zone, where it started, the speed drop, the distance and the peak deceleration.'],
          img: { phone: 'd3/phone-2' }
        },
        { text: ['**GG**: 縦と横の G の散らばりです。外側の円 (限界円) に近いほど、タイヤを使い切っています。', '**GG**: the spread of longitudinal and lateral G. The closer to the outer circle, the more grip you are using.'] },
        {
          text: ['**値の帯**: 速度のグラフの上の [値の帯] から、アクセル・ブレーキ・回転数・ステアリング角などを選ぶと、グラフの下に細い帯で出ます (4 つまで。帯ごとに自分の目盛りです)。記録のあるログだけ出ます (→ G1)。', '**Value strips**: choose throttle, brake, RPM, steering and more from [Strips] above the speed graph to show them as thin strips underneath (up to four, each with its own scale). Only for logs that record them (→ G1).'],
          img: { pc: 'd3/desktop-1' }
        }
      ]
    }]
  },
  {
    id: 'E1', file: 'e1-video.html',
    title: ['動画を見る', 'Watching videos'],
    lead: [
      '車載動画を、速度・G・ラップタイムなどのメーターと一緒に見ます。動画は走行のログと同じ時刻で動きます。',
      'Watch onboard video with gauges for speed, G, lap time and more. The video runs in step with the log.'
    ],
    blocks: [{
      steps: [
        {
          dev: 'phone desktop',
          text: ['[走行] で走行を押し、[動画を見る] を押します。いちばん速い周から始まります。', 'Open a run in [Runs] and press [Watch video]. It starts from the fastest lap.'],
          img: { phone: 'e1/phone-2', desktop: 'e1/desktop-1' }
        },
        { dev: 'browser', text: ['ログと動画のファイルを [ファイルを開く] で一緒に開きます。GoPro の動画は、撮影の時刻と動画の GPS で自動で合います。', 'Open the log and the video together with [Open file]. GoPro videos sync automatically from their timestamp and GPS.'] },
        {
          text: { phone: ['解析の画面でも、下の欄の [動画] で見られます。', 'In Analysis, the [Video] tab in the bottom panel shows it too.'], pc: ['解析の画面でも、左下の [車載動画] で見られます。', 'In Analysis, the onboard video panel at the bottom left shows it too.'] },
          img: { phone: 'e1/phone-1' }
        },
        { text: { phone: ['メーターの並びは、動画の上の選び (自動・標準・データ多め・グラフ・最小、自分の並び) で替えます。目のマークでメーターを隠します。', 'Change the meter layout with the selector above the video (auto, standard, more data, graph, minimal, or your own). The eye icon hides the meters.'], pc: ['メーターの並びは [メーターの配置] (→ F1) か、書き出しの画面で選びます。目のマークでメーターを隠します。', 'Choose the meter layout in [Meter layout] (→ F1) or in the export window. The eye icon hides the meters.'] } },
        { text: ['下の [L1] / [全体] で、周の中だけを動かすか、動画全体を動かすかを切り替えます。', 'Use [L1] / [All] at the bottom to move within the lap or across the whole video.'] }
      ]
    }]
  },
  {
    id: 'E2', file: 'e2-sync.html', video: 'V2_sync',
    title: ['動画とログを合わせる', 'Syncing video and log'],
    lead: [
      'ふつうは、動画の撮影の時刻や GoPro の GPS で自動で合います。ずれているときだけ、[合わせる] で直します。直した結果は走行に覚え、ほかの端末でも同じに開きます。',
      'Normally the video syncs automatically from its timestamp or GoPro GPS. Only if it is off, fix it with [Sync]. The result is saved with the run and used on your other devices too.'
    ],
    blocks: [{
      steps: [
        {
          text: ['動画の画面で [合わせる] を押します。動画とログのタイムゾーン、[再同期]、動画とログが重なっている範囲のタイムラインが出ます。', 'Press [Sync] on the video screen. You get the video and GPS time zones, [Resync] and a timeline of where video and log overlap.'],
          img: { phone: 'e2/phone-1', pc: 'e2/desktop-1' }
        },
        { text: ['動画の時刻が何時間もずれているときは、タイムゾーンを直して [再同期] を押します。', 'If the video is off by hours, fix the time zone and press [Resync].'] },
        { text: ['少しずれているときは、[オフセット] の [-1s] [-0.05s] [+0.05s] [+1s] で合わせます。動画を計測線などはっきりした場面に止め、ログの位置もそこに合わせてから [現フレームで同期] を押しても合わせられます。', 'For small offsets, nudge with [-1s] [-0.05s] [+0.05s] [+1s] under [Offset]. Or pause the video at a clear moment (crossing the line), move the log to the same place and press [Sync to this frame].'] }
      ]
    }]
  },
  {
    id: 'E3', file: 'e3-compare.html', video: 'V4_video_compare',
    title: ['動画で比べる', 'Comparing with video'],
    lead: [
      'Car 1 と Car 2 の周の動画を、同じ地点を走っているときの場面で並べます。ブレーキの位置やラインの違いが一目で分かります。',
      'Show the videos of the Car 1 and Car 2 laps side by side at the same point on track, so braking points and lines are easy to compare.'
    ],
    blocks: [{
      steps: [
        {
          text: ['Car 2 を足してから (→ D2)、動画の画面の [比べる] を押します。Car 2 の枠の数字は、Car 1 とのタイム差です。', 'After adding Car 2 (→ D2), press [Compare] on the video screen. The number on Car 2\'s tile is its time gap to Car 1.'],
          img: { phone: 'e3/phone-1', pc: 'e3/desktop-1' }
        },
        { text: ['[地点] は同じ地点の場面を並べます (Car 2 の動画は速さを変えて回します)。[時間] は周の始めから同じ経過時間の場面を並べます。', '[Place] lines up the same point on track (Car 2\'s video speeds up or slows down); [Time] lines up the same time since the lap started.'] },
        { text: ['Car 1・Car 2 の選びで、枠に出す動画を替えられます。3 台・4 台のときは 2×2 に並びます。', 'Use the Car 1 / Car 2 selectors to change each tile\'s video. With three or four cars they are shown 2×2.'] },
        { dev: 'phone', text: ['縦のスマートフォンでは上下に並びます。横にしたときや、折りたたみの iPhone を開いたときは左右に並びます (→ H1)。', 'On a phone in portrait they stack vertically; turn it sideways or unfold an iPhone Duo for side by side (→ H1).'] }
      ]
    }]
  },
  {
    id: 'E4', file: 'e4-export.html', video: 'V5_layout_export',
    title: ['動画を書き出す', 'Exporting video'],
    lead: [
      'メーターを焼き込んだ動画や、メーターだけの透明な動画を書き出して、YouTube や動画の編集ソフトで使えます。',
      'Export video with the gauges burned in, or gauges only on a transparent background for YouTube or your video editor.'
    ],
    blocks: [{
      dev: 'pc',
      steps: [
        {
          text: ['動画の画面の [書き出す] を押します。範囲は [周]・[動画全体]・[時間で範囲を決める] から選びます。時間で決めるときは、開始・終了を分:秒で書くか、[今の位置] で入れます。', 'Press [Export] on the video screen. Choose the range: the lap, [Whole video] or [Choose a time range]; for a time range, type start and end (min:sec) or use [Current position].'],
          img: { desktop: 'e4/desktop-1' }
        },
        { text: ['書き出しの方式を選びます。[メーターだけ・背景は透明] は Premiere・DaVinci Resolve などで動画に重ねる用、[動画にメーターを焼き込む] はそのまま見られる MP4 です。', 'Pick the method: [Gauges only, transparent] to overlay in Premiere, DaVinci Resolve and the like, or [Burn meters into the video] for a ready-to-watch MP4.'] },
        { text: ['メーターの並び・出す部品・比べる周・解像度・フレームレートを選び、[書き出し開始] を押します。', 'Choose the meter layout, parts, comparison lap, resolution and frame rate, then press [Start export].'] }
      ]
    }, {
      dev: 'phone',
      note: ['書き出しは、デスクトップ版・ブラウザ版 (パソコン) で行います。', 'Exporting is done in the desktop app or the browser on a computer.']
    }]
  },
  {
    id: 'F1', file: 'f1-layout.html',
    title: ['メーターの配置を作る', 'Designing the meter layout'],
    lead: [
      '動画に重ねるメーターの部品を、つかんで動かし、大きさを変え、足して、自分の並びとして保存します。チームや企業のロゴの画像も置けます。',
      'Drag, resize and add the gauges shown on the video and save them as your own layout. You can place a team or sponsor logo too.'
    ],
    blocks: [{
      dev: 'pc',
      steps: [
        {
          text: ['動画の画面の [メーターの配置] を押します。部品をつかんで動かし、右下の角で大きさを変えます。右の欄で部品を選ぶと、値・色・目盛りなどを変えられます。', 'Press [Meter layout] on the video screen. Drag parts to move them and drag the bottom-right corner to resize. Select a part in the right panel to change its value, colour, scale and so on.'],
          img: { desktop: 'f1/desktop-1' }
        },
        { text: ['部品を足すときは、下の選びで種類 (値の棒・数字の欄・ハンドル・グラフの帯・コース図・拡大した地図・タイム差の棒・画像 (ロゴなど) ほか) を選んで [足す] を押します。画像は PNG・JPEG などを選びます。', 'To add a part, choose its type (bar, number, steering wheel, graph strip, course map, close-up map, delta bar, image (logo) and more) and press [Add]. For an image, pick a PNG, JPEG or similar.'] },
        {
          text: ['スマートフォンの枠や走行比較の枠のような狭い枠には、[小さな枠] に切り替えて、大きく読める部品だけの並びを作れます。', 'For narrow tiles (phones, comparison tiles), switch to [Small view] and make a layout with only parts that stay readable.'],
          img: { desktop: 'f1/desktop-2' }
        },
        { text: ['名前を付けて [保存] します。保管場所の overlays フォルダに入るので、iPhone でも選べます。[書き出す] / [読み込む] で人に渡すこともできます。', 'Give it a name and press [Save]. It is stored in the overlays folder of your storage, so the iPhone can use it too. [Export] / [Import] let you share it.'] }
      ]
    }, {
      dev: 'phone',
      steps: [{
        text: ['スマートフォンでは、動画の上の選びで並びを選びます (作る・直すのはパソコンで)。選んだ並びは、その走行に覚えます。', 'On the phone, choose a layout with the selector above the video (create and edit them on a computer). The choice is remembered for that run.'],
        img: { phone: 'f1/phone-1' }
      }]
    }]
  },
  {
    id: 'G1', file: 'g1-csv.html', video: 'V6_csv',
    title: ['ほかの機器の CSV を読む', 'Reading CSV files from other devices'],
    lead: [
      'ほかのロガー・OBD・アプリの CSV の列が何の値かを 1 度決めておくと、ファイルや走行を開くときに自動で読みます。アクセル・回転数・水温などが、メーターや値の帯に出せるようになります。',
      'Tell LapLoupe once what each column of another logger, OBD or app\'s CSV means, and it reads those files automatically. Throttle, RPM, coolant temperature and more then appear in the meters and value strips.'
    ],
    blocks: [{
      dev: 'pc',
      steps: [
        {
          text: ['[設定] の [CSV の形式を作る] を押し、見本の CSV を選びます。区切り・見出しの行・時刻の列・各列の意味を当てて表で出すので、違うところを直します (何の値か・単位・倍率・時刻の形・タイムゾーン)。決まった値にないものは [自分で名前を付ける] で名前と単位を付けます。', 'In [Settings], press [New CSV format] and pick a sample CSV. The delimiter, header row, time column and each column\'s meaning are guessed; correct anything wrong (meaning, unit, scale, time format, time zone). For values not in the list, choose [Custom value] and give a name and unit.'],
          img: { desktop: 'g1/desktop-1' }
        },
        { text: ['種類は、[走行の CSV] (緯度・経度がある) か、[値だけの CSV] (走行の横に置く `<走行>.<名前>.csv`) です。値だけの CSV の名前には、機器を登録したときの「ファイル名用の名前」を書きます。', 'The kind is either [Run CSV] (has latitude and longitude) or [Value CSV] (the `<run>.<name>.csv` next to a run). For a value CSV, enter the device\'s file name from registration.'] },
        { text: ['[保存] すると保管場所の formats フォルダに入ります。それからは、走行を開くと横の CSV を自動で読み、値の帯 (→ D3) やメーター (→ F1) で選べます。', 'After [Save] it is stored in the formats folder. From then on, opening a run reads the CSV next to it, and the values can be picked in strips (→ D3) and meters (→ F1).'] },
        {
          text: ['[計算式] では、値から新しい値を作れます (例: speed * 0.621 で mph、rpm / gear)。', '[Formulas] makes new values from others (e.g. speed * 0.621 for mph, rpm / gear).'],
          img: { desktop: 'g1/desktop-2!narrow' }
        }
      ]
    }, {
      dev: 'phone',
      note: ['形式の定義はパソコンで作ります。保管場所に入った定義は、iPhone・Android のアプリでもそのまま使われ、走行を開くと自動で読みます。', 'Create formats on a computer. Once in your storage folder they are used by the iPhone and Android apps too, automatically when you open a run.']
    }]
  },
  {
    id: 'H1', file: 'h1-duo.html', video: 'V8_duo',
    title: ['折りたたみの iPhone (Duo)', 'The folding iPhone (Duo)'],
    lead: [
      '画面を閉じているときはふつうの iPhone と同じです。開くと、グラフ・動画・コースマップを同時に出す広い配置になります。',
      'Folded, it works like any iPhone. Unfolded, you get a wider layout with the graph, video and course map on screen together.'
    ],
    blocks: [{
      dev: 'iphone',
      steps: [
        {
          text: ['開いた画面の解析は、左にグラフと下の欄 (はじめは [動画])、右にコースマップです。', 'Unfolded, Analysis shows the graph and the bottom panel (video by default) on the left and the course map on the right.'],
          img: { phone: 'h1/phone-1!wide' }
        },
        {
          text: ['縦に持つと、グラフ・コースマップ・下の欄が上から並びます。', 'Held upright, the graph, course map and bottom panel stack from the top.'],
          img: { phone: 'h1/phone-2' }
        },
        { text: ['開く・閉じるで、開いている走行・周・再生の位置・地図の拡大は変わりません。再生中なら、そのまま続きます。閉じると、最後に触った欄が出ます。', 'Folding and unfolding keeps the open run, lap, position and map zoom; playback keeps going. When you fold it, the panel you last touched is shown.'] },
        { text: ['動画の [比べる] は、開くと左右に並びます (→ E3)。', 'Video [Compare] goes side by side when unfolded (→ E3).'] }
      ]
    }, {
      dev: 'android desktop browser',
      note: ['このページは折りたたみの iPhone 向けです。iPad mini の縦置きや、iPad の Split View のブラウザ版でも、同じ広い配置になります。', 'This page is for the folding iPhone. The browser version on an iPad mini in portrait or in iPad Split View uses the same wider layout.']
    }]
  },
  {
    id: 'Z1', file: 'z1-trouble.html',
    title: ['困ったとき', 'Troubleshooting'],
    lead: ['よくある困りごとと、直し方です。', 'Common problems and how to fix them.'],
    blocks: [{
      qa: [
        [['動画が黒いまま・「この時刻の映像はありません」と出る', 'The video stays black or says "No footage at this time"'],
          ['動画が iCloud にだけあり、まだ端末に取り込まれていないことがあります。少し待つか、ファイルのアプリで取り込んでください。それでも出ないときは、動画とログの時刻がずれています (→ E2)。', 'The video may be only in iCloud and not downloaded yet; wait a moment or download it in the Files app. If it still does not show, the video and log times are out of step (→ E2).']],
        [['走行・動画を開くのが遅い (iPhone・iPad)', 'Opening runs or videos is slow (iPhone / iPad)'],
          ['保管場所の digspice フォルダが iCloud にだけあると、開くたびに取り込むので遅くなります。「ファイル」アプリで digspice フォルダを長押しし、[ダウンロードを保持] を選んでください (→ A1)。大きな動画を iCloud から取り込んでいる間も、ほかのファイルの取り込みが後回しになり遅くなります。', 'If the digspice folder in your storage is only in iCloud, it is downloaded each time and things slow down. Long-press the digspice folder in the Files app and choose [Keep Downloaded] (→ A1). While a large video downloads from iCloud, other files wait their turn too.']],
        [['周が出ない・「コース未設定」と出る', 'No laps, or "No course"'],
          ['知らない場所の走行です。開くと計測線を自動で置いて周を数えます。コースを選び直すときは [走行とコース] で選びます。', 'The run is at an unknown place. Opening it places a timing line automatically and counts laps. To pick the course, use [Runs & course].']],
        [['iPhone と PC で走行が違う', 'Runs differ between iPhone and PC'],
          ['両方で同じ iCloud Drive の LapLoupe フォルダを保管場所に選んでいるか確かめてください (→ A1)。iCloud が写し終わるまで少しかかることがあります。', 'Check that both use the same iCloud Drive LapLoupe folder as storage (→ A1). iCloud may take a little while to copy.']],
        [['Mac で「壊れているため開けません」と出る', 'macOS says the app is damaged'],
          ['v1.0.2 から Mac 版は署名付きなので、新しい版を入れ直してください。古い版のときは、インストールの説明 (GitHub の docs/install.md) の手順で開けます。', 'From v1.0.2 the Mac build is signed; install the latest version. For an older version, follow the steps in the install guide (docs/install.md on GitHub).']],
        [['不具合を見つけた・要望がある', 'Found a bug or have a request'],
          ['GitHub の Issue でお知らせください: https://github.com/oud0n/ds_universal/issues', 'Please open a GitHub issue: https://github.com/oud0n/ds_universal/issues']]
      ]
    }]
  }
];
