<#
.SYNOPSIS
  Instalação completa do LaserLink no PC da laser, com perguntas simples.
  Use o arquivo "Instalar LaserLink.bat" (clique duplo).

.DESCRIPTION
  - Instala o que faltar pelo winget: Node.js LTS, Git, NSSM e (se quiser) Tailscale.
  - Baixa o LaserLink em C:\LaserLink, se ainda não estiver numa pasta do GitHub.
  - Cria o laserlink.config.json: porta COM, área útil e um token novo.
  - Instala o serviço (instalar-servico.ps1) e abre a interface no navegador.
  Rodar de novo é seguro: o que já existe (inclusive a configuração) é mantido.
#>
#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\comum.ps1"

# Ramo do GitHub para instalações novas. Troque para "main" quando as fases forem juntadas.
$Branch = "fase-3"
$RepoUrl = "https://github.com/szadil763/laser-link.git"
$DefaultRoot = "C:\LaserLink"

function Install-IfMissing([string]$Cmd, [string]$Id, [string]$Name) {
  if (Get-Command $Cmd -ErrorAction SilentlyContinue) { Write-Host "${Name}: já instalado."; return }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw "Não achei o winget para instalar $Name. Instale o 'Instalador de Aplicativo' pela Microsoft Store e rode de novo."
  }
  Write-Host "Instalando $Name..." -ForegroundColor Cyan
  winget install --id $Id -e --source winget --accept-package-agreements --accept-source-agreements
  Update-SessionPath
  if (-not (Get-Command $Cmd -ErrorAction SilentlyContinue)) {
    throw "$Name foi instalado, mas o Windows ainda não o encontra. Feche esta janela e abra o 'Instalar LaserLink' de novo."
  }
}

function Read-Number([string]$Prompt, [int]$Default) {
  while ($true) {
    $ans = Read-Host "$Prompt [Enter = $Default]"
    if ([string]::IsNullOrWhiteSpace($ans)) { return $Default }
    $n = 0
    if ([int]::TryParse($ans.Trim(), [ref]$n) -and $n -gt 0 -and $n -le 5000) { return $n }
    Write-Host "Digite só o número, em mm." -ForegroundColor Yellow
  }
}

function New-Config([string]$Path) {
  Write-Host ""
  Write-Host "== Configuração ==" -ForegroundColor Cyan
  Write-Host "Ligue a laser e conecte o cabo USB. Feche LaserGRBL, LightBurn ou outro programa que use a laser."
  Read-Host "Aperte Enter quando estiver pronto" | Out-Null
  $ports = @(Get-CimInstance Win32_PnPEntity | ForEach-Object {
    if ($_.Name -match "\((COM\d+)\)") { [pscustomobject]@{ Port = $Matches[1]; Name = $_.Name } }
  })
  if ($ports.Count -eq 0) {
    Write-Host "Nenhuma porta COM encontrada. Confira o cabo e o driver CH340." -ForegroundColor Yellow
  } else {
    Write-Host "Portas encontradas:"
    for ($i = 0; $i -lt $ports.Count; $i++) { Write-Host "  [$($i + 1)] $($ports[$i].Name)" }
  }
  $port = $null
  while (-not $port) {
    $ans = (Read-Host "Digite o número da lista (ou o nome da porta, ex.: COM5)").Trim()
    if ($ans -match "^\d+$" -and [int]$ans -ge 1 -and [int]$ans -le $ports.Count) { $port = $ports[[int]$ans - 1].Port }
    elseif ($ans -match "^COM\d+$") { $port = $ans.ToUpper() }
    else { Write-Host "Não entendi. Exemplo: 1 ou COM5." -ForegroundColor Yellow }
  }
  $x = Read-Number "Largura da área de corte em mm (X)" 400
  $y = Read-Number "Profundidade da área de corte em mm (Y)" 400
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = [Convert]::ToBase64String($bytes)
  $cfg = [ordered]@{
    serialPort = $port
    baudRate = 115200
    wsPort = 8787
    token = $token
    maxFeed = 6000
    maxSpindle = 1000
    workArea = [ordered]@{ x = $x; y = $y }
    reconnectGraceSec = 60
    framePower = 10
    frameFeed = 3000
  }
  # Sem BOM: o agente lê o arquivo como JSON puro.
  [IO.File]::WriteAllText($Path, ($cfg | ConvertTo-Json -Depth 3), (New-Object Text.UTF8Encoding $false))
  try { Set-Clipboard -Value $token } catch { }
  Write-Host ""
  Write-Host "Token de acesso (já copiado; cole com Ctrl+V):" -ForegroundColor Green
  Write-Host "    $token" -ForegroundColor White
  Write-Host "Guarde em lugar seguro. Ele também fica em $Path"
  Write-Host "maxSpindle ficou em 1000. Se o `$30 do seu GRBL for outro valor, ajuste no arquivo."
}

try {
  Write-Host "== Instalação do LaserLink ==" -ForegroundColor Cyan
  Update-SessionPath
  Install-IfMissing "node.exe" "OpenJS.NodeJS.LTS" "Node.js"
  Install-IfMissing "git.exe" "Git.Git" "Git"
  Install-IfMissing "nssm.exe" "NSSM.NSSM" "NSSM"

  # Pasta do LaserLink: a deste script, se veio do GitHub; senão C:\LaserLink.
  $here = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
  if (Test-Path (Join-Path $here ".git")) {
    $Root = $here
  } else {
    $Root = $DefaultRoot
    if (-not (Test-Path (Join-Path $Root ".git"))) {
      if (Test-Path $Root) { throw "A pasta $Root já existe, mas não veio do GitHub. Renomeie essa pasta e rode de novo." }
      Write-Host "Baixando o LaserLink em $Root..." -ForegroundColor Cyan
      git clone -b $Branch $RepoUrl $Root
      if ($LASTEXITCODE -ne 0) { throw "Não consegui baixar o LaserLink do GitHub. Confira a internet e o login do GitHub." }
    }
  }
  Write-Host "Pasta do LaserLink: $Root"

  $Config = Join-Path $Root "laserlink.config.json"
  if (Test-Path $Config) { Write-Host "Configuração existente mantida: $Config" } else { New-Config $Config }

  Stop-LaserLink
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\windows\instalar-servico.ps1")
  if ($LASTEXITCODE -ne 0) { throw "A instalação do serviço falhou. Veja as mensagens acima." }

  $hasTailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue) -or (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")
  if (-not $hasTailscale) {
    $ans = Read-Host "Instalar o Tailscale (acesso de outro lugar, sem abrir portas)? S/N"
    if ($ans -match "^[sSyY]") {
      winget install --id Tailscale.Tailscale -e --source winget --accept-package-agreements --accept-source-agreements
      Write-Host "Depois: clique no ícone do Tailscale perto do relógio, faça login e marque Preferences > Run unattended." -ForegroundColor Cyan
    }
  }

  Start-Process "http://localhost:8787"
  Write-Host ""
  Write-Host "Pronto. A interface abriu no navegador: cole o token e clique em Conectar." -ForegroundColor Green
  Write-Host "Para atualizar no futuro: clique duplo em 'Atualizar LaserLink' na pasta $Root."
} catch {
  Write-Host ""
  Write-Host "ERRO: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Wait-Enter
}
