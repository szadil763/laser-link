<#
.SYNOPSIS
  Instala o agente LaserLink como serviço do Windows (com NSSM).

.DESCRIPTION
  - Compila o projeto (npm ci + npm run build).
  - Cria o serviço "LaserLink", que inicia com o Windows e reinicia sozinho se cair.
  - Grava a saída do agente em apps\agent\logs\agente.log (com rotação).
  - Ao parar o serviço, envia Ctrl+C: o agente pausa/cancela o trabalho e desliga o laser antes de sair.
  - Libera a porta do agente no Firewall do Windows só para Tailscale (100.64.0.0/10) e rede local.

  Rode no PowerShell como Administrador, na pasta do LaserLink:
    powershell -ExecutionPolicy Bypass -File scripts\windows\instalar-servico.ps1

.PARAMETER Nssm
  Caminho do nssm.exe (padrão: procura no PATH).

.PARAMETER SemFirewall
  Não cria a regra de firewall.
#>
#Requires -RunAsAdministrator
param(
  [string]$Nssm = "nssm.exe",
  [string]$ServiceName = "LaserLink",
  [switch]$SemFirewall
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Config = Join-Path $Root "laserlink.config.json"
$Entry = Join-Path $Root "apps\agent\dist\index.js"
$LogDir = Join-Path $Root "apps\agent\logs"

function Fail($msg) {
  Write-Host ""
  Write-Host "ERRO: $msg" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $Config)) {
  Fail "Não achei $Config. Copie apps\agent\laserlink.config.example.json para a pasta do LaserLink com o nome laserlink.config.json e edite (porta COM, token, área útil)."
}

$NodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $NodeCmd) { Fail "Node.js não encontrado. Instale a versão LTS (20 ou mais nova) em https://nodejs.org e abra um PowerShell novo." }
$NodeVersion = (& $NodeCmd.Source --version).TrimStart("v")
if ([int]($NodeVersion.Split(".")[0]) -lt 20) { Fail "Node.js $NodeVersion é antigo. Instale a versão 20 ou mais nova." }

$NssmCmd = Get-Command $Nssm -ErrorAction SilentlyContinue
if (-not $NssmCmd) { Fail "nssm.exe não encontrado. Baixe em https://nssm.cc/download, copie o nssm.exe (pasta win64) para C:\Windows\System32 ou passe -Nssm C:\caminho\nssm.exe." }
$NssmExe = $NssmCmd.Source

# O serviço em execução prende arquivos de node_modules (o driver da porta serial).
# Para antes de reinstalar as dependências (mesmo se estiver travado); volta a rodar no fim.
. (Join-Path $PSScriptRoot "comum.ps1")
Stop-LaserLink $ServiceName

Write-Host "Compilando o LaserLink em $Root ..." -ForegroundColor Cyan
Push-Location $Root
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { Fail "npm ci falhou. Veja as mensagens acima. Se aparecer EPERM, feche programas que usam a pasta C:\LaserLink (editor, antivírus) e rode este script de novo. Se falar de rede, confira a internet. O serviço ficou parado: rode o script de novo para religar." }
  npm run build
  if ($LASTEXITCODE -ne 0) { Fail "npm run build falhou. Veja as mensagens acima." }
} finally {
  Pop-Location
}
if (-not (Test-Path $Entry)) { Fail "Compilação não gerou $Entry." }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Reinstalação: remove o serviço antigo, se existir.
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "Serviço $ServiceName já existe; reinstalando..." -ForegroundColor Yellow
  & $NssmExe stop $ServiceName | Out-Null
  & $NssmExe remove $ServiceName confirm | Out-Null
}

Write-Host "Criando o serviço $ServiceName ..." -ForegroundColor Cyan
& $NssmExe install $ServiceName $NodeCmd.Source "`"$Entry`"" | Out-Null
& $NssmExe set $ServiceName DisplayName "LaserLink (agente da laser)" | Out-Null
& $NssmExe set $ServiceName Description "Controle remoto da laser GRBL. Faz o streaming do G-code pela USB." | Out-Null
& $NssmExe set $ServiceName AppDirectory $Root | Out-Null
& $NssmExe set $ServiceName AppEnvironmentExtra "LASERLINK_CONFIG=$Config" | Out-Null
& $NssmExe set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $NssmExe set $ServiceName AppStdout (Join-Path $LogDir "agente.log") | Out-Null
& $NssmExe set $ServiceName AppStderr (Join-Path $LogDir "agente.log") | Out-Null
& $NssmExe set $ServiceName AppRotateFiles 1 | Out-Null
& $NssmExe set $ServiceName AppRotateOnline 1 | Out-Null
& $NssmExe set $ServiceName AppRotateBytes 1048576 | Out-Null
& $NssmExe set $ServiceName AppExit Default Restart | Out-Null
& $NssmExe set $ServiceName AppRestartDelay 5000 | Out-Null
# Parar o serviço = Ctrl+C: o agente para o trabalho com segurança antes de sair.
& $NssmExe set $ServiceName AppStopMethodConsole 3000 | Out-Null

if (-not $SemFirewall) {
  $Port = 8787
  $Json = Get-Content $Config -Raw | ConvertFrom-Json
  if ($Json.wsPort) { $Port = [int]$Json.wsPort }
  Get-NetFirewallRule -DisplayName "LaserLink" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName "LaserLink" -Direction Inbound -Protocol TCP -LocalPort $Port `
    -RemoteAddress @("100.64.0.0/10", "LocalSubnet") -Action Allow | Out-Null
  Write-Host "Firewall: porta $Port liberada só para Tailscale (100.64.0.0/10) e rede local." -ForegroundColor Cyan
}

& $NssmExe start $ServiceName | Out-Null
Start-Sleep -Seconds 2
$Status = (Get-Service -Name $ServiceName).Status
Write-Host ""
Write-Host "Serviço $ServiceName instalado. Estado: $Status" -ForegroundColor Green
Write-Host "Log do agente: $(Join-Path $LogDir 'agente.log')"
Write-Host "Log de trabalhos: $(Join-Path $LogDir 'jobs.jsonl')"
Write-Host "Teste neste PC: http://localhost:$Port"
