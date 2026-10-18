#!/bin/bash
# fin.sh <id> <公式の長さ m> <CW|CCW> [ループ番号=0] [区切り=0.3333333,0.6666667]
id=$1; T=$2; dir=$3; k=${4:-0}; d=${5:-0.3333333,0.6666667}
EXCL="${EXCL:-(?!)}" TARGET=$T node loops.mjs $id $k $dir | tail -1
ADJUST=1 node gates.mjs $id $d | grep -o '"d":[0-9]*,"hw":[0-9.]*' | tr '\n' ' '; echo
rm -f view_$id.svg.png; qlmanage -t -s 700 -o . view_$id.svg >/dev/null 2>&1
