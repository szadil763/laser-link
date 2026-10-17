<#
.SYNOPSIS
  Reinicia o serviço LaserLink (mesmo se ele estiver travado).
  Use o arquivo "Reiniciar LaserLink.bat" na pasta do LaserLink (clique duplo).
#>
#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\comum.ps1"

try {
  Update-SessionPath
  $nssm = Find-Nssm
  if (-not $nssm) { throw "nssm não encontrado. Rode o 'Instalar LaserLink' primeiro." }
  if (-not (Get-Service -Name LaserLink -ErrorAction SilentlyContinue)) { throw "O serviço LaserLink não está instalado. Rode o 'Instalar LaserLink'." }
  Stop-LaserLink
  & $nssm start LaserLink | Out-Null
  Start-Sleep -Seconds 3
  $status = (Get-Service -Name LaserLink).Status
  if ($status -eq "Running") {
    Write-Host "Serviço LaserLink reiniciado. Estado: $status" -ForegroundColor Green
  } else {
    Write-Host "Serviço LaserLink: $status. Veja o log em apps\agent\logs\agente.log" -ForegroundColor Yellow
  }
} catch {
  Write-Host ""
  Write-Host "ERRO: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Wait-Enter
}
