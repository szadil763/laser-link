# Agente no Windows (PC da laser)

Passo a passo para deixar o agente rodando como serviço no PC ligado à laser, acessível só pela sua rede local ou pelo Tailscale.

> **Versão do Windows:** o Node.js 20 e o Tailscale atuais precisam do **Windows 10 ou 11** (64 ou 32 bits). No Windows 7 ou 8.1 eles não instalam. Se o PC antigo tiver Windows 7, me avise antes: o caminho muda (por exemplo, rodar o agente num Linux leve no mesmo PC).

## Jeito fácil: arquivos de clique duplo

Na pasta do LaserLink (`C:\LaserLink`) há quatro arquivos. Clique duas vezes e responda **Sim** quando o Windows pedir permissão. Eles pedem administrador sozinhos; não precisa abrir o PowerShell.

| Arquivo | Para quê |
|---|---|
| **Instalar LaserLink** | Primeira instalação: instala Node.js, Git e NSSM pelo winget, pergunta a porta COM e a área de corte, gera o token, instala o serviço e (se quiser) o Tailscale. Rodar de novo é seguro: mantém a configuração. |
| **Atualizar LaserLink** | Baixa a versão nova e reinstala o serviço. Para o serviço antes, mesmo se estiver travado. Não use com trabalho em andamento. |
| **Reiniciar LaserLink** | Reinicia o agente (depois de editar o `laserlink.config.json`, ou se algo travar). |
| **Abrir LaserLink** | Abre a interface no navegador deste PC. |

Num PC novo, sem o LaserLink ainda: baixe o projeto como ZIP no GitHub (botão **Code > Download ZIP**, ramo `fase-3`), extraia em qualquer pasta e clique duas vezes em **Instalar LaserLink**. Ele baixa o projeto de verdade em `C:\LaserLink` (com Git, para as atualizações funcionarem) e continua de lá.

Os passos abaixo fazem a mesma coisa à mão e servem de referência.

## 1. Preparar o PC

1. **Energia:** em *Configurações > Sistema > Energia*, coloque "Suspender" em **Nunca** (na tomada). Se o PC dormir, a serial fecha e o trabalho para.
2. **USB:** em *Painel de Controle > Opções de Energia > Alterar configurações do plano > Alterar configurações de energia avançadas > Configurações de USB*, desative a **suspensão seletiva de USB**. Ela derruba a porta COM no meio do trabalho.
3. **Atualizações:** em *Windows Update > Opções avançadas*, defina o **horário ativo** cobrindo os horários de uso da laser, para o Windows não reiniciar no meio de um corte.

## 2. Instalar os programas

1. **Node.js LTS (20 ou mais novo):** baixe em https://nodejs.org e instale com as opções padrão. Abra um PowerShell novo e confira:
   ```powershell
   node --version
   ```
2. **Git:** https://git-scm.com (ou baixe o projeto como ZIP no GitHub).
3. **NSSM** (transforma o agente em serviço): baixe em https://nssm.cc/download, abra o ZIP e copie `win64\nssm.exe` (ou `win32\nssm.exe` no Windows 32 bits) para `C:\Windows\System32`.
4. **Driver USB da laser:** a maioria usa o chip CH340. Se a laser não aparecer no Gerenciador de Dispositivos em *Portas (COM e LPT)*, instale o driver CH340 do fabricante da placa.

## 3. Baixar e configurar o LaserLink

```powershell
cd C:\
git clone https://github.com/szadil763/laser-link.git LaserLink
cd C:\LaserLink
copy apps\agent\laserlink.config.example.json laserlink.config.json
notepad laserlink.config.json
```

Edite:

| Campo | O que colocar |
|---|---|
| `serialPort` | a porta da laser, ex.: `COM3` (veja no Gerenciador de Dispositivos). Use `"sim"` para testar sem a laser. |
| `baudRate` | quase sempre `115200` |
| `token` | uma senha longa e aleatória (mínimo 16 caracteres). Gere com o comando abaixo. |
| `maxSpindle` | o mesmo valor do `$30` do seu GRBL (veja com `$$`); normalmente `1000` |
| `workArea` | a área útil em mm, ex.: `{ "x": 400, "y": 400 }` |
| `reconnectGraceSec` | segundos esperando reconexão antes de cancelar um trabalho pausado (padrão 60) |
| `host` | deixe `0.0.0.0`, ou o IP do Tailscale deste PC (100.x.y.z) para aceitar conexões só pelo Tailscale |

Para gerar um token:
```powershell
$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

## 4. Testar antes de virar serviço

```powershell
cd C:\LaserLink
npm ci
npm run build
npm run start:agent
```

Deve aparecer `LaserLink agente em http://0.0.0.0:8787` e `Serial aberta: COM3`. Abra http://localhost:8787 no navegador deste PC, informe o token e clique em **Conectar**. O estado da máquina deve aparecer.
Feche com **Ctrl+C**.

## 5. Instalar como serviço

Abra o **PowerShell como Administrador** e rode:

```powershell
cd C:\LaserLink
powershell -ExecutionPolicy Bypass -File scripts\windows\instalar-servico.ps1
```

O script:
- compila o projeto;
- cria o serviço **LaserLink**, que inicia com o Windows (mesmo sem ninguém logado) e reinicia sozinho se cair;
- grava a saída em `apps\agent\logs\agente.log` e os trabalhos em `apps\agent\logs\jobs.jsonl`;
- libera a porta 8787 no Firewall do Windows **só** para o Tailscale (`100.64.0.0/10`) e a rede local.

Parar o serviço envia Ctrl+C ao agente: se houver trabalho, ele para com segurança (hold, reset, `M5`) antes de sair.

Comandos úteis (PowerShell como Administrador):

```powershell
nssm restart LaserLink     # reinicia (após editar o laserlink.config.json)
nssm stop LaserLink        # para
Get-Service LaserLink      # estado
Get-Content C:\LaserLink\apps\agent\logs\agente.log -Tail 30 -Wait   # acompanha o log
```

Para atualizar o LaserLink: `git pull` e rode o `instalar-servico.ps1` de novo. O script para o serviço antes de reinstalar as dependências (o agente em execução prende o driver da porta serial) e religa no fim. Não atualize com um trabalho em andamento: parar o serviço cancela o trabalho com segurança.
Para remover: `scripts\windows\desinstalar-servico.ps1`.

## 6. Acesso de fora de casa: Tailscale

O Tailscale cria uma rede privada entre os seus aparelhos. Nenhuma porta fica aberta na internet e não é preciso mexer no roteador.

1. Crie uma conta em https://tailscale.com (plano gratuito pessoal).
2. Instale o Tailscale **no PC da laser** e entre com a conta. Em *Preferences*, marque **Run unattended** para ele conectar mesmo sem ninguém logado no Windows.
3. Instale o Tailscale no **PC de projeto** e no **celular**, com a mesma conta.
4. No PC da laser, veja o IP do Tailscale (começa com `100.`) clicando no ícone do Tailscale, ou com:
   ```powershell
   tailscale ip -4
   ```
5. No PC de projeto ou no celular, abra `http://100.x.y.z:8787`, informe o token e conecte.

Dicas:
- No painel do Tailscale (*Machines*), desative **Key expiry** do PC da laser para ele não sair da rede sozinho.
- Para aceitar conexões **só** pelo Tailscale, coloque o IP `100.x.y.z` em `host` no `laserlink.config.json` e reinicie o serviço.
- **Não** faça port-forward da porta 8787 no roteador e não use serviços de túnel público.

## Projetos recebidos com repositório privado

O agente busca os projetos com o Git do próprio PC da laser. Com o repositório **público**, não precisa configurar nada. Com o repositório **privado**, o serviço (que roda como outro usuário do Windows) precisa de um token só de leitura:

1. No GitHub: foto do perfil > **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens** > **Generate new token**.
2. **Repository access**: *Only select repositories* > `laser-link`. **Permissions** > **Contents**: *Read-only*. Nada mais.
3. Copie o token e coloque no `C:\LaserLink\laserlink.config.json`:
   ```json
   "projects": { "token": "github_pat_..." }
   ```
4. Clique duas vezes em **Reiniciar LaserLink**.

O token fica só nesse arquivo (que não vai para o GitHub). Ele não dá para mudar nada no repositório.

## 7. Problemas comuns

| Sintoma | O que fazer |
|---|---|
| `Não foi possível abrir COM3` no log | Confira a porta no Gerenciador de Dispositivos e se outro programa (LaserGRBL, LightBurn, monitor serial) não está com a porta aberta. O agente tenta de novo a cada 2 s. |
| Interface mostra "Laser desconectada" | Cabo USB solto, driver CH340 ou suspensão seletiva de USB ligada (passo 1). |
| "Token inválido" | O token digitado é diferente do `laserlink.config.json`. Depois de editar o arquivo, `nssm restart LaserLink`. |
| Não abre de outro PC | Confira se o Tailscale está ligado nos dois aparelhos e se a regra de firewall "LaserLink" existe (`Get-NetFirewallRule -DisplayName LaserLink`). |
| "Interface não compilada" | Rode `npm run build` na pasta do LaserLink e reinicie o serviço. |
| Trabalho pausa sozinho | A aba que iniciou o trabalho perdeu a conexão ou ficou em segundo plano no celular. Veja `docs/SEGURANCA.md`. |
