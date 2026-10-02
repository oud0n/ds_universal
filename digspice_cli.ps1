<#
.SYNOPSIS
    デジスパイスIV (DigSpice IV) USB CDC/COM シリアル通信制御 CLI ツール
.DESCRIPTION
    公式Windowsアプリを使用せずに、PowerShellから直接デジスパイスIVと通信を行うツールです。
    USB VID:PID (2DCF:6002) によるCOMポート自動検出、現在設定・ログ容量の取得、
    測位レート変更 (20Hz/10Hz/5Hz)、記録開始速度閾値の設定、本体メモリ全消去、
    および走行ログデータ (rawバイナリ) の吸い出し・ダウンロードに対応しています。
.PARAMETER Port
    シリアルCOMポート名（例: 'COM3'、'COM5'）。省略時は自動検出されます。
.PARAMETER Command
    実行する操作: GetConfig, SetRate, SetSpeed, Download, Erase
.PARAMETER Rate
    SetRate コマンド時の記録レート（5, 10, または 20 Hz）
.PARAMETER Speed
    SetSpeed コマンド時の記録開始/停止 速度閾値（km/h）
.PARAMETER Output
    Download コマンド時のバイナリ保存先ファイルパス（デフォルト: 'raw_download.bin'）
.PARAMETER BaudRate
    シリアル通信ボーレート（デフォルト: 115200 bps）
.PARAMETER TimeoutMs
    送受信タイムアウト時間（ミリ秒、デフォルト: 3000）
.PARAMETER Force
    Erase コマンド実行時に必須となる安全確認スイッチ
.EXAMPLE
    # COMポートを自動検出して現在設定を取得
    .\digspice_cli.ps1 -Command GetConfig
.EXAMPLE
    # COMポートを手動指定して実行
    .\digspice_cli.ps1 -Port COM5 -Command GetConfig
.EXAMPLE
    # 測位レートを 20 Hz (50ms周期) に変更
    .\digspice_cli.ps1 -Command SetRate -Rate 20
.EXAMPLE
    # 記録開始/停止速度を 30 km/h に設定
    .\digspice_cli.ps1 -Command SetSpeed -Speed 30
.EXAMPLE
    # 走行ログを吸い出してファイルに保存
    .\digspice_cli.ps1 -Command Download -Output digspice_raw.bin
.EXAMPLE
    # 本体のログを全消去（-Force 必須）
    .\digspice_cli.ps1 -Command Erase -Force
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false, Position = 0, HelpMessage = "COMポート名 (例: COM3, COM5)。省略時は自動検出されます。")]
    [string]$Port,

    [Parameter(Mandatory = $true, Position = 1, HelpMessage = "実行コマンド: GetConfig, SetRate, SetSpeed, Download, Erase")]
    [ValidateSet("GetConfig", "SetRate", "SetSpeed", "Download", "Erase")]
    [string]$Command,

    [Parameter(Mandatory = $false, HelpMessage = "記録レート (5, 10, 20 Hz)")]
    [ValidateSet(5, 10, 20)]
    [int]$Rate,

    [Parameter(Mandatory = $false, HelpMessage = "開始/停止 速度閾値 (km/h)")]
    [double]$Speed,

    [Parameter(Mandatory = $false, HelpMessage = "ダウンロードデータの保存先パス (デフォルト: raw_download.bin)")]
    [string]$Output = "raw_download.bin",

    [Parameter(Mandatory = $false, HelpMessage = "ボーレート (デフォルト: 115200)")]
    [int]$BaudRate = 115200,

    [Parameter(Mandatory = $false, HelpMessage = "タイムアウト時間 (ミリ秒, デフォルト: 3000)")]
    [int]$TimeoutMs = 3000,

    [Parameter(Mandatory = $false, HelpMessage = "Erase実行時の安全確認用フラグ (-Force)")]
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# デジスパイスIV ハードウェア識別定数
$script:DIGSPICE_VID = "2DCF"
$script:DIGSPICE_PID = "6002"

# ==============================================================================
# COMポート自動検出ロジック
# ==============================================================================

function Find-DigSpicePort {
    [CmdletBinding()]
    param(
        [string]$TargetVid = $script:DIGSPICE_VID,
        [string]$TargetPid = $script:DIGSPICE_PID
    )

    Write-Verbose "デジスパイスIVのハードウェアをスキャン中 (VID: 0x$TargetVid, PID: 0x$TargetPid)..."
    $pattern = "VID_$TargetVid&PID_$TargetPid"
    $candidates = [System.Collections.Generic.List[string]]::new()

    # アプローチ 1: Win32_PnPEntity の検索（仮想COMポート検出で最も確実）
    try {
        $pnpDevices = Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object {
            ($_.PNPDeviceID -and $_.PNPDeviceID -match $pattern) -or
            ($_.DeviceID -and $_.DeviceID -match $pattern)
        }

        foreach ($dev in $pnpDevices) {
            $nameStr = "$($dev.Name) $($dev.Caption)"
            if ($nameStr -match '\((COM\d+)\)') {
                $matchedPort = $Matches[1].ToUpper()
                if (-not $candidates.Contains($matchedPort)) {
                    $candidates.Add($matchedPort)
                    Write-Verbose "Win32_PnPEntity から候補検出: $matchedPort ($($dev.Name))"
                }
            }
        }
    }
    catch {
        Write-Verbose "Win32_PnPEntity 取得失敗: $($_.Exception.Message)"
    }

    # アプローチ 2: Win32_SerialPort の検索（セカンダリ）
    if ($candidates.Count -eq 0) {
        try {
            $serialPorts = Get-CimInstance -ClassName Win32_SerialPort -ErrorAction SilentlyContinue | Where-Object {
                $_.PNPDeviceID -and $_.PNPDeviceID -match $pattern
            }

            foreach ($sp in $serialPorts) {
                if ($sp.DeviceID -match '^COM\d+$') {
                    $matchedPort = $sp.DeviceID.ToUpper()
                    if (-not $candidates.Contains($matchedPort)) {
                        $candidates.Add($matchedPort)
                        Write-Verbose "Win32_SerialPort から候補検出: $matchedPort"
                    }
                }
            }
        }
        catch {
            Write-Verbose "Win32_SerialPort 取得失敗: $($_.Exception.Message)"
        }
    }

    # アプローチ 3: レジストリ検索（フォールバック）
    if ($candidates.Count -eq 0) {
        try {
            $regBase = "HKLM:\SYSTEM\CurrentControlSet\Enum\USB\$pattern"
            if (Test-Path $regBase) {
                $instances = Get-ChildItem -Path $regBase -ErrorAction SilentlyContinue
                foreach ($inst in $instances) {
                    $paramPath = Join-Path $inst.PSPath "Device Parameters"
                    if (Test-Path $paramPath) {
                        $prop = Get-ItemProperty -Path $paramPath -Name "PortName" -ErrorAction SilentlyContinue
                        if ($prop -and $prop.PortName -match '^COM\d+$') {
                            $matchedPort = $prop.PortName.ToUpper()
                            if (-not $candidates.Contains($matchedPort)) {
                                $candidates.Add($matchedPort)
                                Write-Verbose "レジストリから候補検出: $matchedPort"
                            }
                        }
                    }
                }
            }
        }
        catch {
            Write-Verbose "レジストリフォールバック確認失敗: $($_.Exception.Message)"
        }
    }

    # 安全要件に基づく判定
    if ($candidates.Count -eq 0) {
        throw "デジスパイスIV（USB VID: 0x$TargetVid, PID: 0x$TargetPid）が見つかりませんでした。`nUSBケーブルの接続を確認するか、-Port オプションで手動指定してください（例: -Port COM5）。"
    }
    elseif ($candidates.Count -gt 1) {
        $portsList = ($candidates -join ", ")
        throw "複数のデジスパイスIVが検出されました ($portsList)。`n誤操作を防ぐため、対象のポートを -Port オプションで明示指定してください（例: -Port $($candidates[0])）。"
    }

    return $candidates[0]
}

# ==============================================================================
# ヘルパー関数
# ==============================================================================

function ConvertTo-HexString {
    [CmdletBinding()]
    param([byte[]]$Bytes)
    if (-not $Bytes -or $Bytes.Length -eq 0) { return "" }
    return ($Bytes | ForEach-Object { $_.ToString("X2") }) -join " "
}

function Calculate-NmeaChecksum {
    [CmdletBinding()]
    param([string]$SentenceBody)

    # 先頭の $ や末尾の *、改行コードを除去
    $clean = $SentenceBody.Trim()
    if ($clean.StartsWith('$')) { $clean = $clean.Substring(1) }
    $starIdx = $clean.IndexOf('*')
    if ($starIdx -ge 0) { $clean = $clean.Substring(0, $starIdx) }

    # 全文字の XOR を計算
    $checksum = 0
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($clean)
    foreach ($b in $bytes) {
        $checksum = $checksum -bxor $b
    }
    return $checksum.ToString("X2")
}

function Format-NmeaCommand {
    [CmdletBinding()]
    param([string]$Body)

    $clean = $Body.Trim()
    if ($clean.StartsWith('$')) { $clean = $clean.Substring(1) }
    $starIdx = $clean.IndexOf('*')
    if ($starIdx -ge 0) { $clean = $clean.Substring(0, $starIdx) }

    $cs = Calculate-NmeaChecksum -SentenceBody $clean
    return "`$$clean*$cs`r`n"
}

function Open-DigSpicePort {
    [CmdletBinding()]
    param(
        [string]$PortName,
        [int]$Baud,
        [int]$Timeout
    )

    Write-Verbose "シリアルポート $PortName をオープン中 ($Baud 8N1)..."
    $serial = New-Object System.IO.Ports.SerialPort($PortName, $Baud, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
    $serial.ReadTimeout = $Timeout
    $serial.WriteTimeout = $Timeout
    $serial.NewLine = "`r`n"
    $serial.DtrEnable = $true
    $serial.RtsEnable = $true

    try {
        $serial.Open()
    }
    catch {
        throw "シリアルポート $PortName のオープンに失敗しました: $($_.Exception.Message)"
    }

    # バッファのクリア
    Start-Sleep -Milliseconds 100
    $serial.DiscardInBuffer()
    $serial.DiscardOutBuffer()

    return $serial
}

function Close-DigSpicePort {
    [CmdletBinding()]
    param([System.IO.Ports.SerialPort]$Serial)

    if ($Serial -and $Serial.IsOpen) {
        Write-Verbose "シリアルポート $($Serial.PortName) をクローズ中..."
        try {
            $Serial.DtrEnable = $false
            $Serial.RtsEnable = $false
            $Serial.Close()
            $Serial.Dispose()
        }
        catch {
            Write-Warning "ポートクローズ中にエラーが発生しました: $($_.Exception.Message)"
        }
    }
}

function Send-DigSpiceCommand {
    [CmdletBinding()]
    param(
        [System.IO.Ports.SerialPort]$Serial,
        [string]$NmeaCommand
    )

    $rawBytes = [System.Text.Encoding]::ASCII.GetBytes($NmeaCommand)
    $timestamp = (Get-Date).ToString("HH:mm:ss.fff")
    $hex = ConvertTo-HexString -Bytes $rawBytes
    $ascii = $NmeaCommand.TrimEnd("`r", "`n")

    Write-Host "[$timestamp] TX ($($rawBytes.Length) bytes): $hex | $ascii" -ForegroundColor Cyan
    $Serial.Write($rawBytes, 0, $rawBytes.Length)
}

function Read-DigSpiceResponse {
    [CmdletBinding()]
    param(
        [System.IO.Ports.SerialPort]$Serial,
        [int]$Timeout = 3000
    )

    $oldTimeout = $Serial.ReadTimeout
    $Serial.ReadTimeout = $Timeout
    try {
        $line = $Serial.ReadLine()
        $rawBytes = [System.Text.Encoding]::ASCII.GetBytes($line + "`r`n")
        $timestamp = (Get-Date).ToString("HH:mm:ss.fff")
        $hex = ConvertTo-HexString -Bytes $rawBytes
        $cleanLine = $line.Trim()

        if ($cleanLine.Length -gt 60) {
            $shortAscii = $cleanLine.Substring(0, 50) + "..."
            Write-Host "[$timestamp] RX ($($rawBytes.Length) bytes): $($hex.Substring(0, [Math]::Min(50, $hex.Length)))... | $shortAscii" -ForegroundColor Green
        } else {
            Write-Host "[$timestamp] RX ($($rawBytes.Length) bytes): $hex | $cleanLine" -ForegroundColor Green
        }

        return $cleanLine
    }
    catch [System.TimeoutException] {
        return $null
    }
    finally {
        $Serial.ReadTimeout = $oldTimeout
    }
}

function Wait-DigSpiceResponse {
    [CmdletBinding()]
    param(
        [System.IO.Ports.SerialPort]$Serial,
        [string]$Prefix,
        [int]$MaxLines = 15,
        [int]$Timeout = 3000
    )

    $collected = @()
    for ($i = 0; $i -lt $MaxLines; $i++) {
        $resp = Read-DigSpiceResponse -Serial $Serial -Timeout $Timeout
        if (-not $resp) { break }
        $collected += $resp
        if ($resp.StartsWith($Prefix)) {
            return @{
                Matched = $resp
                All = $collected
            }
        }
    }
    return @{
        Matched = $null
        All = $collected
    }
}

function Save-RawResponse {
    [CmdletBinding()]
    param(
        [string]$FilePath,
        [byte[]]$Data
    )

    $resolved = [System.IO.Path]::GetFullPath($FilePath)
    Write-Host "$($Data.Length) バイトの生バイナリデータを保存中: $resolved" -ForegroundColor Yellow
    [System.IO.File]::WriteAllBytes($resolved, $Data)
}

# ==============================================================================
# コマンド実装関数
# ==============================================================================

function Invoke-GetConfig {
    param([System.IO.Ports.SerialPort]$Serial)

    Write-Host "`n=== [デジスパイスIV 設定・状態取得中] ===" -ForegroundColor Magenta

    # 1. ファームウェアバージョンの確認
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK605")
    $fw = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK705").Matched

    # 2. 次回書き込みポインタの取得（ログ保存容量）
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,2,8")
    $wp = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK182,3,8").Matched

    # 3. フラッシュメモリ状態の取得
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,2,10")
    $fs = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK182,3,10").Matched

    # 4. ログフォーマットマスクの取得
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,2,2")
    $mask = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK182,3,2").Matched

    # 5. ログ記録モードの取得
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,2,3")
    $mode = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK182,3,3").Matched

    # 6. 測位レート (Fix Interval) の取得
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK400")
    $rateResp = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK500").Matched

    # 7. バッテリー・内部ステータスの取得
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PTSI990,2,0")
    $battResp = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PTSI990,2,0").Matched

    # 8. 記録開始/停止 速度閾値の取得
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PTSI777,1")
    $speedResp = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PTSI777,0").Matched

    # サマリー情報の整形表示
    Write-Host "`n================ [デバイス設定・状態サマリー] ================" -ForegroundColor White
    if ($fw) {
        $parts = $fw.Split('*')[0].Split(',')
        Write-Host ("  モデル / FWバージョン    : {0} v{1}" -f $parts[1], $parts[2])
    }
    if ($wp) {
        $wpHex = $wp.Split('*')[0].Split(',')[3]
        $wpDec = [Convert]::ToInt32($wpHex, 16)
        $dataSize = [Math]::Max(0, $wpDec - 0x200)
        Write-Host ("  次回書き込みアドレス     : 0x{0} (保存ログ: {1} バイト)" -f $wpHex, $dataSize)
    }
    if ($rateResp) {
        $intervalMs = [int]($rateResp.Split('*')[0].Split(',')[1])
        $hz = if ($intervalMs -gt 0) { [math]::Round(1000 / $intervalMs) } else { 0 }
        Write-Host ("  ログ記録レート / 周期    : {0} Hz ({1} ms)" -f $hz, $intervalMs)
    }
    if ($speedResp) {
        $spdVal = $speedResp.Split('*')[0].Split(',')[2]
        Write-Host ("  記録開始/停止 速度閾値   : {0} km/h" -f $spdVal)
    }
    if ($battResp) {
        $battVal = $battResp.Split('*')[0].Split(',')[3]
        Write-Host ("  内部ステータス / 電圧    : Code {0}" -f $battVal)
    }
    if ($mask) {
        $maskVal = $mask.Split('*')[0].Split(',')[3]
        Write-Host ("  記録フォーマットマスク   : 0x{0}" -f $maskVal)
    }
    Write-Host "================================================================`n" -ForegroundColor White
}

function Invoke-SetRate {
    param(
        [System.IO.Ports.SerialPort]$Serial,
        [int]$RateHz
    )

    if ($RateHz -ne 5 -and $RateHz -ne 10 -and $RateHz -ne 20) {
        throw "サポートされていないレートです: $RateHz Hz (指定可能な値: 5, 10, 20)"
    }

    $intervalMs = switch ($RateHz) {
        20 { 50 }
        10 { 100 }
        5  { 200 }
    }

    Write-Host "`n=== [ログ記録レートを $RateHz Hz (${intervalMs}ms周期) に設定中] ===" -ForegroundColor Magenta

    # 公式アプリ同様のプロローグ手順
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK605")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK705")

    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,2,8")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK182,3,8")

    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,2,10")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK182,3,10")

    # 標準ログパラメータの再適用
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,1,2,0004103F")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK001,182,1,3")

    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,1,3,1")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK001,182,1,3")

    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,1,4,0")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK001,182,1,3")

    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,1,5,0")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK001,182,1,3")

    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,1,6,2")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK001,182,1,3")

    # PMTK300 による測位周期設定
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK300,$intervalMs,0,0,0,0")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK001,300")

    # ステータス更新トリガー
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PTSI990,2,1,27")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PTSI990,2,0")

    # PMTK400 による設定反映の検証
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK400")
    $verify = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK500").Matched

    if ($verify) {
        $actualMs = [int]($verify.Split('*')[0].Split(',')[1])
        if ($actualMs -eq $intervalMs) {
            Write-Host "[成功] 記録レートが $RateHz Hz (${actualMs}ms) に正常反映されたことを確認しました。" -ForegroundColor Green
        } else {
            Write-Warning "デバイスが返した周期 (${actualMs}ms) が設定値 (${intervalMs}ms) と異なります。"
        }
    } else {
        Write-Warning "PMTK400によるレート設定の検証応答が得られませんでした。"
    }
}

function Invoke-SetSpeed {
    param(
        [System.IO.Ports.SerialPort]$Serial,
        [double]$SpeedKmh
    )

    if ($SpeedKmh -le 0 -or $SpeedKmh -gt 300) {
        throw "無効な速度指定です: $SpeedKmh km/h (正の数値を指定してください)"
    }

    $formattedSpeed = "{0:0.00}" -f $SpeedKmh
    Write-Host "`n=== [記録開始/停止 速度閾値を $formattedSpeed km/h に設定中] ===" -ForegroundColor Magenta

    # プロローグ
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK605")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK705")

    # 速度設定コマンド: $PTSI777,2,<Speed>.00*<CS>
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PTSI777,2,$formattedSpeed")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PTSI777,0")

    # 設定検証: $PTSI777,1
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PTSI777,1")
    $verify = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PTSI777,0").Matched

    if ($verify) {
        $confirmedSpeed = $verify.Split('*')[0].Split(',')[2]
        Write-Host "[成功] 速度閾値が $confirmedSpeed km/h に正常反映されたことを確認しました。" -ForegroundColor Green
    } else {
        Write-Warning "PTSI777,1による速度設定の検証応答が得られませんでした。"
    }
}

function Invoke-Erase {
    param(
        [System.IO.Ports.SerialPort]$Serial,
        [bool]$ForceFlag
    )

    if (-not $ForceFlag) {
        throw "安全ロック発動: Eraseコマンドは本体のログを完全に消去します。実行するには必ず -Force を指定してください。"
    }

    Write-Host "`n=== [デジスパイスIV 本体のログメモリ消去実行中] ===" -ForegroundColor Red

    # 消去前ポインタの取得
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK605")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK705")

    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,2,8")
    $preWp = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK182,3,8").Matched
    if ($preWp) {
        $hex = $preWp.Split('*')[0].Split(',')[3]
        Write-Host "消去前書き込みポインタ: 0x$hex" -ForegroundColor Yellow
    }

    # 消去コマンド送信: $PMTK182,6,1*3E
    Write-Host "フラッシュメモリ消去コマンド送信中..." -ForegroundColor Yellow
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,6,1")
    $ack = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK001,182,6,3" -Timeout 10000).Matched

    if ($ack) {
        Write-Host "[成功] デバイスから消去完了応答 (SUCCESS) を受信しました。" -ForegroundColor Green
    } else {
        Write-Warning "消去コマンドの正常応答が得られませんでした。"
    }

    # 消去後の検証
    Start-Sleep -Milliseconds 500
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,2,8")
    $postWp = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK182,3,8").Matched
    if ($postWp) {
        $postHex = $postWp.Split('*')[0].Split(',')[3]
        Write-Host "消去後書き込みポインタ: 0x$postHex" -ForegroundColor Green
        if ($postHex -eq "00000200") {
            Write-Host "メモリ初期化完了（書き込みポインタがベースアドレス 0x00000200 にリセットされました）。" -ForegroundColor Green
        }
    }
}

function Invoke-Download {
    param(
        [System.IO.Ports.SerialPort]$Serial,
        [string]$OutputFile
    )

    Write-Host "`n=== [デジスパイスIV からログデータをダウンロード中] ===" -ForegroundColor Magenta

    # 1. 接続およびポインタ確認
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK605")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK705")

    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,2,8")
    $wpResp = (Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK182,3,8").Matched

    if (-not $wpResp) {
        throw "デバイスから次回書き込みポインタを取得できませんでした。"
    }

    $wpHex = $wpResp.Split('*')[0].Split(',')[3]
    $wpAddr = [Convert]::ToInt32($wpHex, 16)
    $validLogBytes = [Math]::Max(0, $wpAddr - 0x200)

    Write-Host "フラッシュ次回書き込みアドレス : 0x$wpHex" -ForegroundColor Cyan
    Write-Host "保存済みログデータ容量         : $validLogBytes バイト" -ForegroundColor Cyan

    if ($validLogBytes -eq 0) {
        Write-Host "通知: 有効な未読走行ログはありません (ポインタ = 0x$wpHex)。" -ForegroundColor Yellow
        Write-Host "ヘッダセクタとステータス情報のみダウンロードします..." -ForegroundColor Yellow
    }

    $dataBuffer = [System.Collections.Generic.List[byte]]::new()

    # 2. フラッシュステータス確認
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,2,10")
    [void](Wait-DigSpiceResponse -Serial $Serial -Prefix "`$PMTK182,3,10")

    # 要求サイズの計算: 0x1000 (セクタ境界) に切り上げ、最低 0x1000
    $reqSize = ($wpAddr + 0x0FFF) -band (-bnot 0x0FFF)
    if ($reqSize -lt 0x1000) { $reqSize = 0x1000 }
    $reqSizeHex = $reqSize.ToString("X")
    $totalBlocks = [int][Math]::Ceiling($reqSize / 0x800)

    Write-Host "フラッシュ読み出し要求サイズ : 0x$reqSizeHex ($totalBlocks ブロック, 0x800バイト単位)" -ForegroundColor Cyan
    Write-Host "一括ストリーミング受信開始..." -ForegroundColor Yellow

    $dataBuffer = [System.Collections.Generic.List[byte]]::new($reqSize)

    # 3. 一括読み出しコマンド送信
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,7,0,$reqSizeHex")

    # 4. 10ms後にフラッシュ末尾情報要求をパイプライン送信
    Start-Sleep -Milliseconds 10
    Send-DigSpiceCommand -Serial $Serial -NmeaCommand (Format-NmeaCommand "PMTK182,7,FFFFF0,10")

    # 5. 高速ストリーミング受信ループ
    $oldTimeout = $Serial.ReadTimeout
    $Serial.ReadTimeout = 8000 # 8秒アクティビティタイムアウト
    $receivedBlocks = 0
    $lastReportTime = [System.Diagnostics.Stopwatch]::StartNew()

    try {
        while ($true) {
            $line = $Serial.ReadLine()
            if (-not $line) { continue }

            $cleanLine = $line.Trim()
            if ($cleanLine.StartsWith('$PMTK182,8,')) {
                $parts = $cleanLine.Split('*')[0].Split(',')
                if ($parts.Length -ge 4) {
                    $addrHex = $parts[2]
                    $hexData = $parts[3]

                    if ($addrHex -eq '00FFFFF0') {
                        Write-Host "`nフラッシュ終端情報を受信しました (0x00FFFFF0)。" -ForegroundColor Cyan
                        break
                    }

                    # HEX文字列をバイト変換してバッファへ追加
                    for ($j = 0; $j -lt $hexData.Length; $j += 2) {
                        $b = [Convert]::ToByte($hexData.Substring($j, 2), 16)
                        $dataBuffer.Add($b)
                    }
                    $receivedBlocks++

                    # 進捗表示 (200msごと、または完了時)
                    if ($lastReportTime.ElapsedMilliseconds -gt 200 -or $receivedBlocks -ge $totalBlocks) {
                        $pct = [Math]::Min(100, [Math]::Round(($receivedBlocks / $totalBlocks) * 100))
                        $receivedKb = [Math]::Round($dataBuffer.Count / 1024)
                        Write-Progress -Activity "デジスパイスIV ログデータダウンロード中" `
                            -Status "$pct% 完了 ($receivedBlocks / $totalBlocks ブロック, $receivedKb KB)" `
                            -PercentComplete $pct
                        $lastReportTime.Restart()
                    }
                }
            }
        }
    }
    catch [System.TimeoutException] {
        throw "受信タイムアウト: 8秒間シリアルデータが途絶えました ($receivedBlocks / $totalBlocks ブロック受信済)。"
    }
    finally {
        $Serial.ReadTimeout = $oldTimeout
        Write-Progress -Activity "デジスパイスIV ログデータダウンロード中" -Completed
    }

    # ファイルにバイナリ保存
    $binaryArray = $dataBuffer.ToArray()
    Save-RawResponse -FilePath $OutputFile -Data $binaryArray
    Write-Host "[成功] ダウンロード完了。保存サイズ: $($binaryArray.Length) バイト" -ForegroundColor Green
}

# ==============================================================================
# メインエントリーポイント
# ==============================================================================

$targetPort = $null

# COMポートの決定: 明示指定があれば優先、無ければ自動検出
if (-not [string]::IsNullOrWhiteSpace($Port)) {
    $targetPort = $Port.Trim().ToUpper()
    Write-Host "指定されたCOMポートを使用します: $targetPort" -ForegroundColor Cyan
}
else {
    Write-Host "ポート未指定。デジスパイスIVを自動検出中 (VID: 0x$($script:DIGSPICE_VID), PID: 0x$($script:DIGSPICE_PID))..." -ForegroundColor Cyan
    $targetPort = Find-DigSpicePort
    Write-Host "デジスパイスIVを検出しました: $targetPort" -ForegroundColor Green
}

$serialPort = $null

try {
    $serialPort = Open-DigSpicePort -PortName $targetPort -Baud $BaudRate -Timeout $TimeoutMs

    switch ($Command) {
        "GetConfig" {
            Invoke-GetConfig -Serial $serialPort
        }
        "SetRate" {
            if (-not $PSBoundParameters.ContainsKey('Rate')) {
                throw "SetRate コマンドには -Rate パラメータ (5, 10, または 20) が必須です。"
            }
            Invoke-SetRate -Serial $serialPort -RateHz $Rate
        }
        "SetSpeed" {
            if (-not $PSBoundParameters.ContainsKey('Speed')) {
                throw "SetSpeed コマンドには -Speed パラメータ (km/h) が必須です。"
            }
            Invoke-SetSpeed -Serial $serialPort -SpeedKmh $Speed
        }
        "Erase" {
            Invoke-Erase -Serial $serialPort -ForceFlag $Force.IsPresent
        }
        "Download" {
            Invoke-Download -Serial $serialPort -OutputFile $Output
        }
    }
}
catch {
    Write-Error "コマンド実行中にエラーが発生しました: $($_.Exception.Message)"
    exit 1
}
finally {
    if ($serialPort) {
        Close-DigSpicePort -Serial $serialPort
    }
}
