<#
  Launches the two llama-server instances, one per GPU.
    npm run servers            # both
    npm run servers -- -Stop   # kill whatever holds 8081/8082
  House style borrowed from /llama/Run.ps1: --load-mode none, q8_0 KV,
  flash-attn on. Difference: one model per card, so --split-mode none
  instead of --tensor-split (which would make the cards fight each other).
#>
param([switch]$Stop, [switch]$NoWait)

$ErrorActionPreference = 'Stop'
$Root     = Split-Path -Parent $PSScriptRoot
$LlamaDir = Join-Path $Root 'llama'
$Models   = Join-Path $Root 'Models'
$Logs     = Join-Path $Root 'data\logs'
$Server   = Join-Path $LlamaDir 'llama-server.exe'

foreach ($d in $Logs) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

function Stop-OnPort([int]$Port) {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    try {
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
      Write-Host "  stopped pid $($c.OwningProcess) on :$Port" -ForegroundColor DarkYellow
    } catch { }
  }
}

if ($Stop) {
  Stop-OnPort 8081; Stop-OnPort 8082
  Write-Host '  ports 8081/8082 released' -ForegroundColor Cyan
  return
}

if (-not (Test-Path $Server)) { throw "llama-server.exe not found at $Server" }

$Coordinator = @{
  Port  = 8081
  Gpu   = 0
  Model = Join-Path $Models 'Qwen3.5-4B-IQ4_XS.gguf'
  Ctx   = 16384
  Temp  = '0.2'
}
$Vision = @{
  Port   = 8082
  Gpu    = 1
  Model  = Join-Path $Models 'Qwen2.5-Omni-7B-Q4_K_M.gguf'
  Mmproj = Join-Path $Models 'Qwen2.5-Omni-7B-mmproj-Q8_0.gguf'
  Ctx    = 12288
  Temp   = '0.1'
}

function Start-Llama {
  param($Spec, [string]$Alias, [string]$LogPrefix, [string[]]$Extra)

  if (-not (Test-Path $Spec.Model)) { throw "missing model: $($Spec.Model)" }
  if ($Spec.Mmproj -and -not (Test-Path $Spec.Mmproj)) { throw "missing mmproj: $($Spec.Mmproj)" }

  $serverArgs = @(
    '--model', $Spec.Model
    '--alias', $Alias
    '--device', "CUDA$($Spec.Gpu)"
    # --device already pins this process to a single physical card, so the
    # filtered device list has exactly one entry and main-gpu must be 0.
    # (Passing 1 here fails: "invalid value for main_gpu: 1 (available devices: 1)".)
    '--main-gpu', '0'
    '--split-mode', 'none'
    '--n-gpu-layers', '99'
    '--load-mode', 'none'
    '--flash-attn', 'on'
    '--ctx-size', "$($Spec.Ctx)"
    '--cache-type-k', 'q8_0'
    '--cache-type-v', 'q8_0'
    '--batch-size', '256'
    '--ubatch-size', '256'
    '--threads', '4'
    '--jinja'
    '--temp', $Spec.Temp
    '--port', "$($Spec.Port)"
    '--verbosity', '2'
    '--no-webui'
  )
  if ($Spec.Mmproj) {
    $serverArgs += @('--mmproj', $Spec.Mmproj, '--mmproj-offload')
  }
  $serverArgs += $Extra

  Write-Host "  -> $Alias on CUDA$($Spec.Gpu) :$($Spec.Port)" -ForegroundColor Cyan
  Start-Process -FilePath $Server -ArgumentList $serverArgs -WorkingDirectory $LlamaDir `
    -RedirectStandardOutput (Join-Path $Logs "$LogPrefix.out.log") `
    -RedirectStandardError (Join-Path $Logs "$LogPrefix.err.log") `
    -WindowStyle Hidden -PassThru | Out-Null
}

Write-Host "`n  HireMyAss - llama-server`n" -ForegroundColor White
Stop-OnPort 8081; Stop-OnPort 8082

Start-Llama -Spec $Coordinator -Alias 'coordinator' -LogPrefix 'coordinator' -Extra @('--top-k', '20', '--min-p', '0')
Start-Llama -Spec $Vision -Alias 'vlm' -LogPrefix 'vision' -Extra @('--image-min-tokens', '1024')

if ($NoWait) { exit 0 }

foreach ($p in 8081, 8082) {
  $deadline = (Get-Date).AddMinutes(6)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-RestMethod "http://127.0.0.1:$p/health" -TimeoutSec 3
      if ($r.status -eq 'ok') { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 1000
  }
  if ($ready) { Write-Host "  ok  :$p healthy" -ForegroundColor Green }
  else { Write-Host "  !!  :$p not healthy - check data\logs" -ForegroundColor Red }
}
Write-Host ""
