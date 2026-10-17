<#
.SYNOPSIS
  Baixa a versão nova do LaserLink (git pull) e reinstala o serviço.
  Use o arquivo "Atualizar LaserLink.bat" na pasta do LaserLink (clique duplo).
#>
#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\comum.ps1"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

try {
  Update-SessionPath
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw "Git não encontrado. Rode o 'Instalar LaserLink' primeiro." }
  Write-Host "Baixando a versão nova do LaserLink..." -ForegroundColor Cyan
  Push-Location $Root
  git pull --ff-only
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "Não consegui baixar a atualização (git pull). Confira a internet e tente de novo. Se a mensagem falar de arquivos alterados, mande um print." }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "instalar-servico.ps1")
  if ($LASTEXITCODE -ne 0) { throw "A reinstalação do serviço falhou. Veja as mensagens acima." }
  Write-Host ""
  Write-Host "LaserLink atualizado. No outro computador, recarregue a página com Ctrl+F5." -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host "ERRO: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Wait-Enter
}
