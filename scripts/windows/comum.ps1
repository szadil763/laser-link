# Funções usadas pelos scripts do Windows. Carregue com:  . "$PSScriptRoot\comum.ps1"

# Recarrega o PATH (programas instalados agora pelo winget passam a ser achados).
function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Find-Nssm {
  $cmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# Para o serviço, mesmo travado ligando/desligando, e qualquer agente aberto à mão.
# Os dois prendem arquivos de node_modules (o driver da porta serial).
function Stop-LaserLink([string]$ServiceName = "LaserLink") {
  $ErrorActionPreference = "Continue"
  $nssm = Find-Nssm
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -ne "Stopped") {
    Write-Host "Parando o serviço $ServiceName..." -ForegroundColor Yellow
    if ($nssm) { try { & $nssm stop $ServiceName | Out-Null } catch { } }
    for ($i = 0; $i -lt 15; $i++) {
      $svc.Refresh()
      if ($svc.Status -eq "Stopped") { break }
      Start-Sleep -Seconds 1
    }
    $svc.Refresh()
    if ($svc.Status -ne "Stopped") {
      $svcPid = (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'").ProcessId
      if ($svcPid) {
        Write-Host "O serviço não respondeu; encerrando à força." -ForegroundColor Yellow
        try { taskkill /F /T /PID $svcPid | Out-Null } catch { }
        Start-Sleep -Seconds 2
      }
    }
  }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*apps\agent\dist\index.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Wait-Enter {
  Write-Host ""
  Read-Host "Aperte Enter para fechar" | Out-Null
}
