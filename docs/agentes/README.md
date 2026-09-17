# Agentes de AYR Steel ERP

La configuración canónica vive en `AGENTS.md`. Codex CLI y Antigravity comparten las skills
versionadas en `.agents/skills/`; Claude Code importa las reglas desde `CLAUDE.md` y queda en
solo lectura mediante `.claude/settings.json`.

## Instalación local

Desde la raíz del worktree:

```bash
pnpm setup:agentes
```

El script es idempotente: configura `core.hooksPath=.githooks` y, si Antigravity ya está
instalado, agrega el worktree actual a su arreglo `trustedWorkspaces` sin reemplazar las demás
claves. También permite `read_file` solo para el worktree y los comandos de diagnóstico
`git diff`, `git log`, `git show` y `git status`; no concede escritura. Si ya existe un
`core.hooksPath` distinto o el JSON de Antigravity no es válido, se detiene y lo informa en
lugar de sobrescribirlo. No instala prompts ni escribe en `$CODEX_HOME`.

Antigravity IDE recibe el puntero de `.agents/rules/00-ayr.md`. En Antigravity CLI 1.2.5 se
comprobó que un worktree enlazado sin proyecto asociado no inyecta las reglas al contexto. La
primera sesión de cada worktree debe arrancar desde la raíz con `agy --new-project`; desde ese
momento carga `AGENTS.md` y `.agents/rules/`. `GEMINI.md` importa además el archivo canónico como
adaptador de compatibilidad, sin duplicarlo ni sobreescribirlo. El descubrimiento automático de
skills tampoco atravesó correctamente el worktree antes de asociarlo. El manifiesto
`.agents/skills.json` documenta la ruta compartida y `setup:agentes` fusiona su ruta absoluta en
`~/.gemini/config/skills.json`, sin eliminar entradas ajenas.

## Invocar las skills

Codex y Antigravity pueden seleccionarlas por la descripción del frontmatter. Para invocación
explícita usa:

```text
$ayr-arranque
$ayr-revisor
$ayr-qa
$ayr-cierre
$ayr-handoff
$ayr-ventana
```

Los custom prompts de Codex están deprecados y no se crean wrappers bajo
`$CODEX_HOME/prompts/`. Tras agregar o cambiar una skill, abre una sesión nueva de Codex o
Antigravity. Aunque el changelog instalado de Antigravity 1.2.5 anuncia `/skills reload`, el
binario probado rechaza argumentos para `/skills`; reiniciar la sesión es la vía verificada.

## Perfiles sugeridos de Codex 0.154

Codex 0.154 usa un archivo por perfil bajo `$CODEX_HOME`, seleccionado con `--profile`. Mantén
valores generales en `~/.codex/config.toml` y crea, por ejemplo:

`~/.codex/grind.config.toml`:

```toml
model_reasoning_effort = "medium"
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = false
```

`~/.codex/diseno.config.toml`:

```toml
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = false
```

`~/.codex/revision.config.toml`:

```toml
model_reasoning_effort = "high"
sandbox_mode = "read-only"
approval_policy = "never"
```

Ejemplos: `codex --profile grind`, `codex --profile diseno` y
`codex --profile revision`. En `workspace-write` la red del sandbox permanece apagada por
default; habilitarla es una decisión explícita por perfil o sesión. Nunca usar Full Access para
este repo.

Referencias: documentación oficial de [skills](https://learn.chatgpt.com/docs/build-skills),
[configuración](https://learn.chatgpt.com/docs/config-file/config-sample) y
[sandbox](https://learn.chatgpt.com/docs/sandboxing).
