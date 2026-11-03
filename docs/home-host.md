# 家庭主机拓扑与隔离 superagent 试验

产品名是 **DSH-haibo**。小红书 Muse Agentic 架构只作设计参考，见 [README 致谢](../README.md#致谢与设计来源)。本文不改安装器，也不把上游原型并进 haibo。

## 拓扑

- **家庭主机**是唯一长期运行的 DSH runtime。手机和笔记本只做客户端（浏览器或桌面壳连到这台主机），不各自再养一套长期 runtime。
- 主机上的代码就是这份 [smile-xuc/DSH-haibo](https://github.com/smile-xuc/DSH-haibo)。默认 profile 仍用 `node bin/install.mjs install` 写入 `# >>> dsh-muse >>>` 标记块。不 fork DSH 内核。
- haibo 插件留在**默认家庭主机 profile**上，继续做治理（WorkUnit、副作用台账、护栏、证据、评测）。

## 隔离 superagent 试验

可选。单独建一个 DSH profile，名字用 `superagent`。人在家庭主机上的可复制步骤见 [主机安装步骤](#host-install)，样例在 [docs/trial/](trial/)。上游 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的 [SETUP.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/SETUP.md) 是给代理的问卷；本试验不走那份问卷，答案已经写死在安装步骤里。安装细节仍以同一提交的 [docs/006-deployment.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/006-deployment.md) 为准。

不要做的事：

- 不要把原型装进 haibo 的标记 cordis 块。
- 不要把 `dsh-superagent-prototype` 的源码或构建产物拷进本仓库的 `plugins/`，也不要改 `bin/install.mjs` 去挂它。

v0 试验默认（允许破损）：

| 项 | 值 |
|---|---|
| DSH tip | **`0.2.1-rc.5`**（tag `dsh-v0.2.1-rc.5`） |
| Source | 只开 **GitHub**。飞书插件保持关闭 |
| 接单 | **`acceptMode: observe`**（评估并记下研判，不接单） |

原型 `SETUP.md` 的示例命令仍写 `@deepseek-ai/dsh@0.2.1-rc.3`。本试验改用 `0.2.1-rc.5`。原型 `engines.dsh` 是 `^0.2.1-alpha.2`，默认 semver 已包含 `0.2.1-rc.5`。

原型 [README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md) 的免责声明：这是研究代码，不是正式产品，也**不等于**文章 *Exploring Super-agent Design: Towards a More Autonomous Agent System* 里的实现。文章里的一些设计尚未做进原型。

`acceptMode` 在原型面板的 Eval 设置里，取值 `off` / `observe` / `auto`。`observe` 的含义见原型 `src/core/model.ts`：主动候选仍会评估并留下 Decision 会接受什么，但实际不接单。

<a id="feishu-source-v0"></a>

## 飞书 Source（v0 范围内）

飞书在 v0 范围内，路径是上面那个**隔离 profile**，不是 haibo 里的新插件。本仓库不实现飞书插件。

原型已经带飞书 Source：构建入口 `feishu-watch`（`package.json` 导出 `./feishu-watch`），说明见 [docs/008-cookbook.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/008-cookbook.md)（现成 Source 的写法对照）和 [docs/006-deployment.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md)（可选飞书机器人、`dsh-superagent-feishu` 条目）。

启用顺序：

1. 隔离 profile 上 GitHub-only + `acceptMode: observe` 先跑通（能看到评估记录，且没有自动接单）。
2. 只在该 profile 打开飞书 Source（`dsh-superagent-feishu` / `feishu-watch`）。不要改 haibo 默认 profile 的标记块。
3. haibo 插件继续只治理默认家庭主机 profile。

## CI tip 与 cordis

haibo 的 plugin-behavior CI 把 `@deepseek-ai/dsh-*` 钉在 **`0.2.1-rc.5`**。对照 tag `dsh-v0.2.1-rc.5` 的已发布 peer：这些包要 `@deepseek-ai/cordis@~4.0.5`，`@deepseek-ai/schemastery@~3.18.5`，`dsh-llm` / `dsh-storage-domain` 依赖 `zod@4.4.3`。schemastery `3.18.5` 依赖 `@deepseek-ai/cosmokit@~1.8.6`。因此 CI 里的 cordis `4.0.5`、cosmokit `1.8.6`、schemastery `3.18.5`、zod `4.4.3` **保持不动**。npm 上的 `cordis@4.0.6-alpha.1` 不在 `~4.0.5` 里，也不追。

插件 `peerDependencies` 里的 `^0.2.1-alpha.1` 已经匹配 `0.2.1-rc.5`（同一 `0.2.1` 预发布元组，不需要 `includePrerelease`），所以没有再追加 `|| ^0.2.1-rc.5`，也没有写入 `0.2.2-alpha`。

隔离试验另有一条 peer，**不**回写到 haibo：原型 `package.json` 把 `@deepseek-ai/cordis` 和 `@deepseek-ai/schemastery` 钉成精确的 `4.0.5-alpha.1` 与 `3.18.5-alpha.1`。稳定版 `4.0.5` / `3.18.5` 满足不了这两条。试验接受破损；不要为此把 alpha cordis 塞进 haibo 的标记块或 CI。

<a id="host-install"></a>

## 主机安装步骤

操作者在家庭主机上自己执行。本仓库只提供步骤和 [docs/trial/](trial/) 样例，不提供远程安装器，也不把令牌写进 git。

上游 `SETUP.md` 要求代理逐题询问。本节把 v0 答案写死：

| 题 | 写死的答案 |
|---|---|
| profile | `superagent`（自带 web 模板的副本，端口 `3082`，状态目录 `<DSH_HOME>/state/superagent` 的绝对路径） |
| Source | 只开 GitHub。飞书插件保持关闭 |
| 仓库 | `smile-xuc/DSH-haibo`（owner/name 就是这两段） |
| 谁可以发起 | 操作者自己的 GitHub 登录名，一个 |
| 接单 | `eval.mode` = `observe`（面板里的 accept mode） |
| 执行器准备命令 | 空字符串。v0 不写入上游那条 worktree 命令 |
| 自动合并 | 不配置合并用的 CLI，不把模式改成 `auto` |
| 仓库级旁路开关 | `observeIssues` / `observePulls` / `observeComments` / `observeCi` 全部 `false`（只收点名通知） |
| DSH | `0.2.1-rc.5`，tag `dsh-v0.2.1-rc.5` |

下文命令对照原型提交 `6337fc823ce20251c8de8085948165c81aaa701e`。若 `main` 上的 `SETUP.md` 或 `006-deployment.md` 改了安装块，以那两份为准，同时保持上表。示例里的 `@deepseek-ai/dsh@0.2.1-rc.3` 改成 `0.2.1-rc.5`。不要改成 `0.2.2-alpha`。

### GitHub 权限：政策收在一个仓库，上游 setup 仍检查 push

v0 的政策是：只处理 `smile-xuc/DSH-haibo`，观察、不接单、不自动合并、不打开飞书。

上游工具没有「只读令牌」或「跳过 push 检查」的接口。`src/deployment.ts` 的 `resolveDeployment` 对配置好的代理 CLI（本试验是 `gh-agent`）执行：

```sh
gh-agent api user
gh-agent api repos/smile-xuc/DSH-haibo --jq '{name: .full_name, push: .permissions.push}'
```

`permissions.push` 不是 `true` 时，setup 失败，代码 `repositoryReadOnly`，原文是 `@{account} cannot push to {repository}.`。只读（Read）或 Triage 协作者会停在这里。保存 GitHub Source 时走的是同一检查。

因此代理账号要对 **这一个仓库** 有 GitHub 的 Write 角色，setup 才能通过。这是启动门，不是允许它在试验里推送。`observe` 把本会接受的候选记成 Decision（`kind: ignore`，`audit.would_accept: true`，reason code `observed`），不接单。

`gh` 侧也没有更窄的一档可以交给原型：

- 原型调用的是登录后的 `gh`，不接收自定义 scope 参数。
- GitHub CLI 文档写明 `gh auth login --with-token` 的最低 scope 是 `repo`、`read:org`、`gist`。交互式 `gh auth login` 申请的也是这一组最低 scope。不要再加 `workflow`、`delete_repo` 或其他 scope。
- `repo` 是读写 scope，覆盖该账号能够访问的仓库，不是「只读且仅此仓库」的令牌。收口靠账号的仓库成员资格：只把这个账号加进 `smile-xuc/DSH-haibo`。
- 轮询读的是 `notifications?all=true&per_page=50&since=...`，再丢掉 `full_name` 不是这个仓库的通知。令牌看得到该账号的通知列表；Source 只留下这一个仓库。
- GitHub App 不能当这个账号。上游要读用户通知。
- setup 会去掉名字里带 `KEY`、`PASSWORD`、`SECRET`、`TOKEN` 的环境变量，worker 环境里也会去掉 `GH_TOKEN` 和 `GITHUB_TOKEN`。凭据放在 `GH_CONFIG_DIR` 的 `gh auth login` 里，不要靠导出的令牌，也不要写进仓库。

先在本机确认 push 门，再保存 Source：

```sh
gh-agent api repos/smile-xuc/DSH-haibo --jq '{name: .full_name, push: .permissions.push}'
```

期望输出的 `name` 是 `smile-xuc/DSH-haibo`，`push` 是 `true`。`push` 为 `false` 或命令失败时，停。给这个账号只在该仓库加 Write，不要加到其他仓库，也不要改成 Admin，除非 Write 仍过不了上面这条 `gh api`（上游只判断 `permissions.push === true`）。

### 1. 前提

家庭主机需要：

- Node.js 22.19+ 或 24+（原型 `engines.node`；比 haibo 文档里的 Node 20 更严）
- pnpm。原型 `packageManager` 是 `pnpm@11.7.0`。可用 `corepack enable && corepack prepare pnpm@11.7.0 --activate`
- git 2.32+、Python 3.8+、tmux、curl、jq
- GitHub CLI `gh` 2.48+
- 操作者自己的 `gh auth login`（用来克隆，以及作为允许发起的登录名）。这与下一步的代理包装是两套 `GH_CONFIG_DIR`
- DSH 模型供应商配在 **superagent** profile 本地。新建 profile 来自自带 web 模板，不会带上默认 profile 里的模型配置。密钥留在本机

cordis / schemastery 的 alpha 精确 peer 见上一节。`pnpm install` 用的是原型锁文件里的 alpha；跑在 `0.2.1-rc.5` 里时，稳定版 `4.0.5` / `3.18.5` 对不上。面板报插件不兼容或加载失败，是这项已知破损。不要把 alpha cordis 写进 haibo 的 CI 或默认 profile。

### 2. 克隆或更新 haibo

已有检出就只更新：

```sh
git pull --ff-only
export HAIBO="$PWD"
```

还没有检出：

```sh
git clone https://github.com/smile-xuc/DSH-haibo.git
cd DSH-haibo
export HAIBO="$PWD"
```

后面的样例路径用 `$HAIBO`。不要把原型拷进 `$HAIBO/plugins/`。不要对任何 profile 运行 `node bin/install.mjs` 来装原型。默认 profile 上已有的 haibo 标记块保持不动。

### 3. 建立隔离 profile

`DSH_HOME` 默认是 `~/.dsh`。profile 已存在时不要再跑 `--from-default-profile`：它会换掉整个 profile，并删掉已有的 `cordis.patch.yml`。

```sh
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
test ! -e "$DSH_HOME/profiles/superagent"
npm install -g @deepseek-ai/dsh@0.2.1-rc.5
dsh --version
dsh superagent --from-default-profile web --dump-config > /dev/null
```

`dsh --version` 应包含 `0.2.1-rc.5`。这条全局安装把主机上的 `dsh` 指到 haibo 文档已钉住的同一个 tip。`--from-default-profile web` 复制的是发行版里的 web 模板，然后 `--dump-config` 打印配置并退出，不常驻进程。

确认 superagent 的用户层补丁里没有 haibo 标记块。默认 profile 的文件不要打开来改：

```sh
grep -n 'dsh-muse' "$DSH_HOME/profiles/superagent/cordis.patch.yml" && echo 'stop: haibo marker is on superagent' && exit 1
echo 'superagent user patch has no dsh-muse marker'
```

### 4. 按上游安装原型，DSH 使用 rc.5

原型单独克隆。目录不要放在 `$HAIBO` 里面。

```sh
export PROTO="${PROTO:-$HOME/src/dsh-superagent-prototype}"
if [ ! -d "$PROTO/.git" ]; then
  git clone https://github.com/deepseek-ai/dsh-superagent-prototype.git "$PROTO"
else
  git -C "$PROTO" pull --ff-only
fi
cd "$PROTO"
pnpm install && pnpm build
dsh plugin --profile superagent add "link:$PWD"
```

`dsh plugin add` 把参数交给该 profile 目录里的 pnpm，装的是这个检出的 link。它不修改 `$HAIBO/bin/install.mjs`。

然后用样例盖住 **superagent** 的用户层补丁，并写入绝对 `stateDir`。飞书行保持注释：

```sh
mkdir -p "$DSH_HOME/state/superagent"
STATE="$(cd "$DSH_HOME/state/superagent" && pwd)"
patch="$DSH_HOME/profiles/superagent/cordis.patch.yml"
content="$(cat "$HAIBO/docs/trial/profile.cordis.patch.example.yml")"
printf '%s\n' "${content//__STATE_DIR__/$STATE}" > "$patch"
if grep -n '__STATE_DIR__' "$patch" || grep -n '>>> dsh-muse' "$patch"; then
  echo 'stop: patch placeholder or haibo marker' >&2
  exit 1
fi
if grep -nE '^[[:space:]]*- id: dsh-superagent-feishu' "$patch"; then
  echo 'stop: feishu entry is uncommented' >&2
  exit 1
fi
echo "stateDir=$STATE"
```

原型包自己的 `cordis.patch.yml` 里有 `dsh-superagent-feishu`，并且 `disabled: true`。不要改上游那份文件，也不要在 profile 里把该条目设成 `disabled: false`。

启动（在 `$PROTO`）：

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status || true
```

第一次启动在 GitHub Source 配好之前，`status` 退出码 `3` 是预期（进程在等 setup）。退出码 `0` 也可以。退出码 `1` 表示没起来、起来了两份、没有应答或运行时报错；看 `$PROTO/.artifacts/` 里最新的 `dsh-superagent-superagent-*.log`。面板地址在日志里，侧栏进 **Superagent**。本试验的端口是 `127.0.0.1:3082`。

### 5. 操作者：代理账号和 gh 包装

这一步只在操作者自己的终端做。专用 GitHub 用户，不要用操作者正在用的登录名。

1. 新建一个 GitHub 用户给代理。
2. 只邀请它协作 `smile-xuc/DSH-haibo`，角色 Write。用该账号接受邀请。
3. 在家庭主机上写入只属于它的 `gh` 包装并登录。登录过程要浏览器或设备码；令牌留在 `~/.config/gh-agent`：

```sh
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/gh-agent" <<'EOF'
#!/bin/sh
GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
EOF
chmod +x "$HOME/.local/bin/gh-agent"
gh-agent auth login
```

登录时不要追加 scope。完成后：

```sh
export OPERATOR_LOGIN="$(gh api user --jq .login)"
export AGENT_LOGIN="$(gh-agent api user --jq .login)"
echo "operator=$OPERATOR_LOGIN agent=$AGENT_LOGIN"
test "$OPERATOR_LOGIN" != "$AGENT_LOGIN"
gh-agent api repos/smile-xuc/DSH-haibo --jq '{name: .full_name, push: .permissions.push}'
gh-agent auth status
```

两个登录名必须不同。`push` 必须是 `true`，`name` 必须是 `smile-xuc/DSH-haibo`。`gh auth status` 用于看登录名和 scope；不要把令牌贴到仓库或聊天里。`repo` 这一档比政策宽，成员资格收在这一个仓库上。

### 6. 配置 GitHub Source

管理 API 只接受 `127.0.0.1` 或 `localhost`，并要头 `x-orchestrator-request: 1`。成功响应里有 `saved`、`revision`、`policy_changed`、`restarting`（见上游 `006` 的 Management API），没有回显整份 `value`。`restarting: true` 时服务会重启；退出码 `1` 期间不要发下一笔。退出码 `3` 表示还在等 setup。第 6、7、8 步留在同一个 bash 里。

```bash
set -euo pipefail
cd "$PROTO"
api=http://127.0.0.1:3082/orchestrator/api
hdr=( -H 'x-orchestrator-request: 1' )
: "${OPERATOR_LOGIN:=$(gh api user --jq .login)}"

wait_superagent() {
  local i code
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if scripts/dsh-superagent --profile superagent status; then
      return 0
    fi
    code=$?
    if [ "$code" -eq 1 ]; then
      sleep 5
      continue
    fi
    return "$code"
  done
  return 1
}

put_settings() {
  local name="$1" body="$2" code
  code="$(curl -sS -o "/tmp/dsh-superagent-${name}-put.json" -w '%{http_code}' \
    -X PUT "${hdr[@]}" -H 'content-type: application/json' \
    "$api/settings/${name}" --data-binary @"$body")"
  if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
    jq . "/tmp/dsh-superagent-${name}-put.json" >&2 || true
    echo "stop: PUT settings/${name} HTTP ${code}" >&2
    return 1
  fi
  if jq -e '.restarting == true' "/tmp/dsh-superagent-${name}-put.json" >/dev/null; then
    wait_superagent
  fi
}

curl -sf "${hdr[@]}" "$api/settings" > /tmp/dsh-superagent-settings.json
rev="$(jq -er '.sources[] | select(.id == "github") | .revision' /tmp/dsh-superagent-settings.json)"
jq -n --arg cli "$HOME/.local/bin/gh-agent" --argjson rev "$rev" \
  --slurpfile sample "$HAIBO/docs/trial/settings.observe.example.json" \
  '{revision: $rev, value: ($sample[0].github | .config.cli = $cli)}' \
  > /tmp/dsh-superagent-github.json
put_settings 'source:github' /tmp/dsh-superagent-github.json
curl -sf "${hdr[@]}" "$api/settings" \
  | jq -e '.sources[] | select(.id == "github") | .value.config.repository == "smile-xuc/DSH-haibo"' >/dev/null
```

`PUT` 若返回 400 且 `setup.code` 是 `repositoryReadOnly`，回到第 5 步的 Write 角色，不要换一套未写进上游的 API。仓库字符串不要改成别的 owner 或名字。

允许发起的人只放操作者自己。重新读取 revision，只改 `sources.github.allowed`，留下已有的 `rules`：

```bash
set -euo pipefail
curl -sf "${hdr[@]}" "$api/settings" > /tmp/dsh-superagent-settings.json
rev="$(jq -er '.blocks.policy.revision' /tmp/dsh-superagent-settings.json)"
jq -n --arg login "$OPERATOR_LOGIN" --argjson rev "$rev" \
  --slurpfile cur /tmp/dsh-superagent-settings.json \
  '{revision: $rev, value: ($cur[0].blocks.policy.value | .sources.github.allowed = [{id: $login}])}' \
  > /tmp/dsh-superagent-policy.json
put_settings policy /tmp/dsh-superagent-policy.json
```

登录名要匹配原型的 `^[A-Za-z0-9-]+$`。不要把代理账号放进 `allowed`。不要写 `sources.feishu`。

执行器的 `prepare` 保持空。若当前不是空，整块保存时只把 `prepare` 改成样例里的空字符串：

```bash
set -euo pipefail
curl -sf "${hdr[@]}" "$api/settings" > /tmp/dsh-superagent-settings.json
prepare="$(jq -r '.blocks.executor.value.prepare // ""' /tmp/dsh-superagent-settings.json)"
if [ -n "$prepare" ]; then
  rev="$(jq -er '.blocks.executor.revision' /tmp/dsh-superagent-settings.json)"
  jq -n --argjson rev "$rev" --slurpfile cur /tmp/dsh-superagent-settings.json \
    --slurpfile sample "$HAIBO/docs/trial/settings.observe.example.json" \
    '{revision: $rev, value: ($cur[0].blocks.executor.value | .prepare = $sample[0].executor.prepare)}' \
    > /tmp/dsh-superagent-executor.json
  put_settings executor /tmp/dsh-superagent-executor.json
fi
```

上游 `006` 里那条 `git worktree add -b "agent/..."` 是接单之后才会用的准备命令。v0 不写入。

### 7. 设置 acceptMode 为 observe

面板的 accept mode 就是设置块 `eval` 的 `mode`，取值 `off` / `observe` / `auto`。原型默认已是 `observe`；这里仍按样例写一次，避免沿用旧 profile 上的 `auto`。

```bash
set -euo pipefail
curl -sf "${hdr[@]}" "$api/settings" > /tmp/dsh-superagent-settings.json
rev="$(jq -er '.blocks.eval.revision' /tmp/dsh-superagent-settings.json)"
jq -n --argjson rev "$rev" --slurpfile cur /tmp/dsh-superagent-settings.json \
  --slurpfile sample "$HAIBO/docs/trial/settings.observe.example.json" \
  '{revision: $rev, value: (($cur[0].blocks.eval.value // {}) | .mode = $sample[0].eval.mode)}' \
  > /tmp/dsh-superagent-eval.json
put_settings eval /tmp/dsh-superagent-eval.json
```

不要改提示词去点名一个合并用 CLI。上游交付段的默认是：没点名合并 CLI 时，由人合并；并且禁止用代理账号打开 auto-merge。v0 保持这个默认。

### 8. 核对：服务健康，并且只观察

```bash
set +e
scripts/dsh-superagent --profile superagent status
echo "status_exit=$?"
set -e
curl -sf "${hdr[@]}" "$api/settings" | jq '{
  mode: .blocks.eval.value.mode,
  prepare: .blocks.executor.value.prepare,
  allowed: .blocks.policy.value.sources.github.allowed,
  github: (.sources[] | select(.id == "github") | {enabled: .value.enabled, config: .value.config})
}'
curl -sf "${hdr[@]}" "$api/state" | jq '{setup, load, paused}'
curl -sf "${hdr[@]}" "$api/sources" > /tmp/dsh-superagent-sources.json
jq . /tmp/dsh-superagent-sources.json
```

通过时同时满足：

- `status` 退出码 `0`。
- `mode` 是 `observe`，`prepare` 是 `""`。
- `github.config.repository` 是 `smile-xuc/DSH-haibo`，`cli` 指向 `gh-agent`，四个 `observe*` 都是 `false`，`enabled` 是 `true`。
- `allowed` 只有操作者的登录名。
- `setup.problem` 是 `null`。`setup.feishuProblem` 不是一个待修复的飞书机器人问题（飞书未启用时，它应为 `null` 或随未安装的 Source 缺席）。
- `load.running` 是 `0`。
- `GET sources` 里 GitHub 的 `state` 是 `ready` 或 `starting`。飞书若出现，`state` 只能是 `missing` 或 `off`，不能是 `ready`。

观察一次（仍不接单）：

1. 用 `allowed` 里的那个账号，在 `smile-xuc/DSH-haibo` 的一条 Issue 上**新发评论**：`@<AGENT_LOGIN> 观察试验，不要改仓库`。改 Issue 正文加上的 @ 不会进通知，上游不收。
2. 大约一分钟内，面板 Superagent 里应出现评估记录。`observe` 下这条 Decision 是不接单：`would_accept`，面板 outcome `wouldAccept`，`kind` 为 `ignore`，reason code `observed`。
3. `load.running` 仍是 `0`。代理账号没有新分支、没有新 PR。

若出现已接受的 Ticket，或 `load.running` 大于 0：在 `$PROTO` 执行 `scripts/dsh-superagent stop`，把 `eval.mode` 设回 `observe`，确认没有 `prepare` 命令，然后再启动。上游 `006` 写明执行器预设以操作者的 OS 用户、`danger-full-access` 运行；`observe` 用来避免启动它。

可选。在操作者平时用的那个 DSH profile（不是 `superagent`）里做每小时检查。把 `<PROTO>` 换成原型检出的绝对路径：

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <PROTO>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

这段检查只看状态和按上游规则重启。不要让它改 `eval.mode`，不要让它打开飞书。

### 9. 飞书继续关闭

默认路径到第 8 步结束。飞书留到隔离 profile 上的 GitHub + `observe` 已经健康之后，见 [飞书 Source（v0 范围内）](#feishu-source-v0) 的启用顺序。在那之前：

- 不要取消 [profile 样例](trial/profile.cordis.patch.example.yml) 里 `dsh-superagent-feishu` 的注释。
- 不要 `PUT settings/source:feishu`。
- 不要安装或配置 `lark-cli`。
- 不要改 haibo 默认 profile 的标记块。

haibo 插件继续只治理默认家庭主机 profile。
