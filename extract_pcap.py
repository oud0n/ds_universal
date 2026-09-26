#!/usr/bin/env python3
"""
デジスパイスIV (DigSpice IV) USB/COM パケット抽出・解析ツール

Wireshark / USBPcap でキャプチャした .pcapng ファイルから、
USB CDC-ACM (シリアル通信) のバルク転送ペイロード (NMEAコマンド列) を抽出します。
"""

import argparse
import glob
import os
import struct
import sys


def parse_usbpcap_payloads(pcap_path, target_ep=None):
    """USBPcap の pcapng ファイルを解析し、バルクシリアル送受信データを抽出する。"""
    try:
        from scapy.all import rdpcap
    except ImportError:
        print("エラー: scapy がインストールされていません。'pip install scapy' でインストールしてください。", file=sys.stderr)
        return []

    packets = rdpcap(pcap_path)
    records = []

    for idx, p in enumerate(packets):
        raw = bytes(p)
        if len(raw) < 28:
            continue

        # USBPcap パケットヘッダの構造:
        # headerLen (2), irpId (8), status (4), function (2), info (1), bus (2), device (2), endpoint (1), transfer (1), dataLength (4)
        hlen = struct.unpack('<H', raw[:2])[0]
        if len(raw) < hlen:
            continue

        dev = struct.unpack('<H', raw[19:21])[0]
        ep = raw[21]
        xfer = raw[22]
        dlen = struct.unpack('<I', raw[23:27])[0]

        # transfer == 3 は USB BULK (バルク転送)
        if xfer == 3 and dlen > 0:
            if target_ep is not None and ep != target_ep:
                continue
            payload = raw[hlen:hlen + dlen]
            if not payload:
                continue

            # 最上位ビットが 0 なら送信 (Host -> Dev)、1 なら受信 (Dev -> Host)
            direction = "Host -> Device" if (ep & 0x80) == 0 else "Device -> Host"
            ts = float(p.time)
            records.append({
                "frame": idx + 1,
                "timestamp": ts,
                "device": dev,
                "endpoint": ep,
                "direction": direction,
                "length": len(payload),
                "payload": payload,
            })

    return records


def format_record(r, show_hex=True, show_ascii=True):
    """抽出したレコードをフォーマットして表示用文字列を生成する。"""
    ts_str = f"{r['timestamp']:.6f}"
    dir_str = f"{r['direction']} (EP 0x{r['endpoint']:02X})"
    out = [f"フレーム {r['frame']:5d} [{ts_str}] {dir_str} 長さ={r['length']:4d} バイト"]

    payload = r['payload']
    if show_ascii:
        ascii_repr = ''.join(chr(b) if 32 <= b <= 126 else '.' for b in payload)
        if len(ascii_repr) > 80:
            ascii_repr = ascii_repr[:77] + "..."
        out.append(f"  ASCII: {ascii_repr}")

    if show_hex:
        hex_repr = payload.hex(' ')
        if len(hex_repr) > 80:
            hex_repr = hex_repr[:77] + "..."
        out.append(f"  HEX:   {hex_repr}")

    return "\n".join(out)


def main():
    parser = argparse.ArgumentParser(description="USBPcap .pcapng からデジスパイスIVのUSB CDCシリアルペイロードを抽出するツール")
    parser.add_argument("path", help=".pcapng ファイルのパス、または複数ファイルを格納したフォルダパス")
    parser.add_argument("--ep", type=lambda x: int(x, 0), default=None, help="エンドポイント番号でフィルタ (例: 0x02 または 0x81)")
    parser.add_argument("--no-hex", action="store_true", help="HEXダンプ表示を非表示にする")
    parser.add_argument("--raw", action="store_true", help="ペイロードの生ASCII文字列のみを標準出力に出力する")

    args = parser.parse_args()

    if os.path.isdir(args.path):
        files = sorted(glob.glob(os.path.join(args.path, "*.pcapng")))
    else:
        files = [args.path]

    if not files:
        print(f"指定されたパスに対象の .pcapng ファイルが見つかりません: {args.path}", file=sys.stderr)
        sys.exit(1)

    for f in files:
        print("=" * 80)
        print(f"ファイル: {f}")
        records = parse_usbpcap_payloads(f, target_ep=args.ep)
        print(f"抽出されたシリアル通信パケット数: {len(records)}")
        print("-" * 80)
        for r in records:
            if args.raw:
                try:
                    sys.stdout.write(r['payload'].decode('ascii', errors='replace'))
                except Exception:
                    pass
            else:
                print(format_record(r, show_hex=not args.no_hex))


if __name__ == "__main__":
    main()
