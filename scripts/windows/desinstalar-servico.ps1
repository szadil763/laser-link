<#
.SYNOPSIS
  Remove o serviço LaserLink e a regra de firewall.
  Rode no PowerShell como Administrador:
    powershell -ExecutionPolicy Bypass -File scripts\windows\desinstalar-servico.ps1
#>
#Requires -RunAsAdministrator
param(
  [string]$Nssm = "nssm.exe",
  [string]$ServiceName = "LaserLink"
)

$ErrorActionPreference = "Stop"
$NssmCmd = Get-Command $Nssm -ErrorAction SilentlyContinue
if (-not $NssmCmd) {
  Write-Host "ERRO: nssm.exe não encontrado. Passe -Nssm C:\caminho\nssm.exe." -ForegroundColor Red
  exit 1
}

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  & $NssmCmd.Source stop $ServiceName | Out-Null
  & $NssmCmd.Source remove $ServiceName confirm | Out-Null
  Write-Host "Serviço $ServiceName removido." -ForegroundColor Green
} else {
  Write-Host "Serviço $ServiceName não existe."
}
Get-NetFirewallRule -DisplayName "LaserLink" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host "Regra de firewall LaserLink removida (se existia)."
