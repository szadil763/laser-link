<#
.SYNOPSIS
  Atualização pedida pelo app (botão "Atualizar agora", janela Máquina).

.DESCRIPTION
  O agente baixa a versão nova (refs/laserlink/atualizacao) e cria uma tarefa agendada
  do Windows que roda este script como SYSTEM, fora do serviço. Assim dá para parar o
  agente (que prende o driver da porta serial), instalar, compilar e religar.
  Se algo falhar, volta para a versão anterior e religa o serviço do mesmo jeito.
  Não pede nada na tela: o resultado vai para apps\agent\data\atualizacao.json (o app
  mostra) e o passo a passo para apps\agent\logs\atualizacao.log.
  Para atualizar à mão, use o "Atualizar LaserLink" (atualizar.ps1).
#>
param([string]$ServiceName = "LaserLink")
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\comum.ps1"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$DataDir = Join-Path $Root "apps\agent\data"
$LogDir = Join-Path $Root "apps\agent\logs"
New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null
$State = Join-Path $DataDir "atualizacao.json"
$TaskName = "LaserLink Atualizar"
Start-Transcript -Path (Join-Path $LogDir "atualizacao.log") -Force | Out-Null

function Invoke-Git {
  & git.exe -c safe.directory=* @args
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') falhou." }
}

function Invoke-Npm([string[]]$NpmArgs, [string]$What) {
  & npm.cmd @NpmArgs
  if ($LASTEXITCODE -ne 0) { throw "$What falhou." }
}

function Save-Result([bool]$Ok, [string]$Message) {
  $version = "$(& git.exe -c safe.directory=* log -1 --format=%h)".Trim()
  $obj = [ordered]@{ ok = $Ok; message = $Message; version = $version; at = (Get-Date).ToUniversalTime().ToString("o") }
  [IO.File]::WriteAllText($State, ($obj | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
}

$old = $null
$merged = $false
$lockChanged = $false
Push-Location $Root
try {
  Update-SessionPath
  $old = "$(& git.exe -c safe.directory=* rev-parse HEAD)".Trim()
  $new = "$(& git.exe -c safe.directory=* rev-parse --verify -q refs/laserlink/atualizacao)".Trim()
  if (-not $new) { throw "Não achei a versão baixada. No app, clique em Procurar atualização e tente de novo." }
  $lockChanged = ("$(& git.exe -c safe.directory=* diff --name-only $old $new -- package-lock.json)".Trim() -ne "")
  Write-Host "Atualizando de $old para $new (pacotes novos: $lockChanged)"
  Stop-LaserLink $ServiceName
  Invoke-Git merge --ff-only $new
  $merged = $true
  if ($lockChanged) { Invoke-Npm @("ci") "A instalação dos pacotes (npm ci)" }
  Invoke-Npm @("run", "build") "A compilação (npm run build)"
  Save-Result $true "LaserLink atualizado."
  Write-Host "Pronto."
} catch {
  $msg = $_.Exception.Message
  Write-Host "ERRO: $msg"
  if ($merged -and $old) {
    try {
      Write-Host "Voltando para a versão anterior ($old)..."
      Invoke-Git reset --hard $old
      if ($lockChanged) { Invoke-Npm @("ci") "A reinstalação dos pacotes" }
      Invoke-Npm @("run", "build") "A compilação da versão anterior"
      $msg = "$msg Voltei para a versão anterior."
    } catch {
      $msg = "$msg Não consegui voltar para a versão anterior: rode o Atualizar LaserLink no PC da laser."
    }
  }
  Save-Result $false $msg
} finally {
  Pop-Location
  # o serviço volta sempre, com a versão nova ou a anterior
  $nssm = Find-Nssm
  if ($nssm) { & $nssm start $ServiceName | Out-Null } else { Start-Service -Name $ServiceName -ErrorAction SilentlyContinue }
  & schtasks.exe /Delete /TN $TaskName /F | Out-Null
  Stop-Transcript | Out-Null
}
