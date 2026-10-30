# The Bucket — daily Victory price updater (Windows PowerShell 5.1+).
# Runs on a computer in Israel, because Victory's official price-file server only accepts Israeli connections.
# It downloads only the files the server asks for and relays them; all parsing happens on the server.
#
# Run by hand:   powershell -NoProfile -ExecutionPolicy Bypass -File update-prices.ps1
# Log file:      %LOCALAPPDATA%\TheBucket\prices.log

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Token  = '__INGEST_TOKEN__'
$Fn     = 'https://cpjzpldkjdjaohhjslkw.supabase.co/functions/v1/price-ingest'
$Host_  = 'https://laibcatalog.co.il'
$Chains = @('7290696200003', '7290058103393')   # Victory

$Dir = Join-Path $env:LOCALAPPDATA 'TheBucket'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$LogFile = Join-Path $Dir 'prices.log'
function Log($m) { $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $m; Write-Host $line; Add-Content -Path $LogFile -Value $line -Encoding UTF8 }
$Headers = @{ 'x-ingest-token' = $Token }

try {
  Log 'start'

  # 1. list the files currently published by the chain
  $listing = @()
  foreach ($c in $Chains) {
    try {
      $files = Invoke-RestMethod -Uri "$Host_/webapi/api/getfiles?edi=$c" -TimeoutSec 120 -UseBasicParsing
      $n = 0
      foreach ($f in @($files)) { if ($f.fileName) { $listing += [pscustomobject]@{ fileName = $f.fileName; fileDate = $f.fileDate; listedUnder = $c }; $n++ } }
      Log "chain $c : $n files listed"
    } catch { Log "chain $c : listing failed - $($_.Exception.Message)" }
  }
  if ($listing.Count -eq 0) { throw 'no files listed (the chain republishes in the morning; try again later)' }

  # 2. ask the server which files it needs
  $body = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($listing) -Depth 3 -Compress))
  $plan = Invoke-RestMethod -Method Post -Uri "$Fn/plan" -Headers $Headers -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 60
  Log ("server wants {0} file(s) for {1} branch(es)" -f @($plan.fetch).Count, @($plan.wanted).Count)

  # 3. download each file and hand it to the server
  foreach ($f in @($plan.fetch)) {
    $tmp = Join-Path $env:TEMP ("thebucket-" + [IO.Path]::GetFileName($f.fileName))
    $src = $listing | Where-Object { $_.fileName -eq $f.fileName } | Select-Object -First 1
    $urls = @("$Host_/webapi/$($Chains[0])/$($f.fileName)", "$Host_/webapi/$($src.listedUnder)/$($f.fileName)", "$Host_/webapi/$($f.chainId)/$($f.fileName)") | Select-Object -Unique
    $got = $false
    foreach ($u in $urls) {
      try { Invoke-WebRequest -Uri $u -OutFile $tmp -TimeoutSec 300 -UseBasicParsing; $got = $true; break } catch { Log "  download failed from $u - $($_.Exception.Message)" }
    }
    if (-not $got) { continue }
    try {
      $name = [Uri]::EscapeDataString([IO.Path]::GetFileName($f.fileName))
      $r = Invoke-RestMethod -Method Post -Uri "$Fn/file?name=$name" -Headers $Headers -ContentType 'application/octet-stream' -InFile $tmp -TimeoutSec 300
      Log ("  {0}: {1}" -f $f.fileName, (ConvertTo-Json $r -Compress))
    } catch { Log "  upload failed for $($f.fileName) - $($_.Exception.Message)" }
    finally { Remove-Item -Force -ErrorAction SilentlyContinue $tmp }
  }
  Log 'done'
} catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}
