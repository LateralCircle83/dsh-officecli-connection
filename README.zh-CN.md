# dsh-officecli-connection

[English](README.md) · **中文**

给**你自己安装的** [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) 套一层很薄的 DeepSeek Harness 外壳。

这个插件不带二进制、不下载、不升级。OfficeCLI 由你自己装；插件只负责知道它在哪，并给模型一个干净的调用入口。

## 它带来什么

| 部分 | 说明 |
| --- | --- |
| 设置页 | **设置 → OfficeCLI**：填二进制路径，点「测试」会回报检测到的版本和已挂载的指南数量。这里没有「注入技能」开关：指南就是工作流本身，一个没有手册的执行器没有意义。想关掉 OfficeCLI，把路径清空即可。 |
| `officecli` 工具 | 只有一个工具，参数是 `command`（命令行字符串或已拆好的 argv 数组）。进程在**会话工作目录**里启动，所以相对路径和 shell 里的行为一致。渲染出来的页面会作为图片附件返回。 |
| 技能 | OfficeCLI 自带的十本指南（`pptx`、`word`、`excel`、`word-form`、`morph-ppt`、`morph-ppt-3d`、`pitch-deck`、`academic-paper`、`data-dashboard`、`financial-model`）以运行时技能的形式暴露。名字跟随技能自身的 id，所以 `word` 显示为 `officecli-docx`、`excel` 显示为 `officecli-xlsx`——其它技能正文正是按这个 id 互相引用的。额外一本 `officecli-workflow` 是本插件自己的：它给出十本的映射、引擎边界和陷阱清单（见「与其它 Office 技能共存」）。它刻意**不**叫 `officecli`，因为二进制会自己装一份同名手册——见下文「第二本 officecli 技能」。 |

技能走 Harness 的技能提供者契约注入，所以**任何位置都不会落盘**：不写工作区、不写 `.agents/`、不写 `~/.claude`。目录来自 `officecli load_skill`，单本正文来自 `officecli load_skill <slug>`，两者都只打印到 stdout。捆绑的参考文件通过技能的 `resourceBase` 保持可读，它会告诉模型去跑 `officecli load_skill <slug> --path <relpath>`。

这些指南不是可选项。它们就是工作流：工具只是执行器，而按格式划分的知识——版面底线、配色、元素规范、静默失败清单——都放在十一本技能正文里，因为它体量大，而且只在构建时用得上。如果加一个卸载它们的开关，模型就只剩执行器、没有手册，那些规则就得全部搬回每次请求都要付费的工具描述里。所以唯一的设置项就是路径：清空它（或指到一个不存在的路径），指南会随之离开目录，这才是诚实地表达「现在不用」。设置页会显示挂载了几本，零本就意味着路径不对。

## 边界：输出怎么处理

| 通道 | 处理方式 |
| --- | --- |
| stdout | 原样作为文本块透传，超过 8 MB 截断 |
| stderr | 追加到同一段文本；从不解析，也从不丢弃 |
| 退出码 | 原样透传：不重试、不重新解释。`2` 表示「跑完了但有警告」——去看 `warnings`，`success` 可能为 false |
| 指向真实图片文件的一行 | 该文件被提交为持久附件，并作为图片块返回；超过部署的大小上限时，给你路径加一条说明 |
| 其它一切 | 不做任何处理——不解析 JSON、不渲染 HTML、不监视文件 |

工具描述**刻意不带参数速查表**。它让模型去跑 `officecli help`、`help <verb>`、`help <format> <element>`，因为二进制才是权威 schema，任何写死的参数清单都会随版本漂移。它带的是下面这份很短的踩坑清单——那些真的毁掉过文档构建的。

## 已知的上游行为

对 OfficeCLI 1.0.158 复现。这些都不是插件自己的设计；工具描述会重复它们，免得模型每份文档都重新踩一遍。

| 行为 | 怎么办 |
| --- | --- |
| 二进制跑的是 **argv，不是 shell** | 没有 `&&`、`\|`、`>`、`$VAR`；一次一条命令，或者把步骤放进 `batch` |
| 长参数、非 ASCII 参数要放进文件 | 用 `batch <file> --input <json>`；内联引号迟早会静默出错——被序列化的 argv 数组会以字面量 `[batch,` 的形式到达 CLI |
| 裸数字长度等于 EMU，不报错 | `margin=26` 会把框压扁，而 `validate` 照样通过；写 `pt`/`cm`。`spacing` 相反：无单位，表示磅 |
| `add` 和 `set` 的属性名不一致 | `add` 用 `w`/`h`，`set` 用 `width`/`height`；名字写错只打印 `UNSUPPORTED props`，调用仍然退出 0 |
| `batch` 失败会整体回滚 | 一项出错，其它项全部作废，但汇总行仍然把它们算作成功 |
| 字体按脚本分开设置 | `font.latin` 和 `font.ea` 都要设；只写一个 `font` 会让中文回落到等宽字体 |
| 表格默认样式基本不可用 | 用 `border.all=none` 加 `border.horizontal`，并显式给表头填色，否则表头文字看不见 |
| 写入类命令会留下常驻进程 | 另一个程序这时读到的是「文件正被其它进程使用」；用完跑 `close <file>` |
| `validate` 校验的是包结构，不是版面 | 表格可以溢出幻灯片而照样通过；只有截图能看出来——任何字号下，溢出容器的文字都会被裁掉或折到看不见 |
| xlsx 截图是 HTML 近似 | 图表和合并单元格可能重叠或裁切，而工作簿本身是对的；用 `view text --range` 和 `view issues` 复核 |
| 带引号的公式条件 | 写 `\">1\"`（或直接传 argv 数组）：纯字符串形式会把引号剥掉，单元格留下 `#OCLI_NOTEVAL!`，而调用仍报成功 |
| 跨范围写一条公式 | 相对引用不会位移——`set /Sheet1!D1:D3 --prop formula=A1*2` 会在三个单元格里都存 `A1*2`；一个格一条命令 |
| 改前驱会删掉缓存值 | `view issues` 回答的是「这条公式能不能算」，不是「缓存对不对」；`<x:calcPr fullCalcOnLoad="1"/>` 让 Excel 打开时重算 |
| `colWidths` 建表时定死 | 之后改不了，而 `add` 只能往正文末尾追加——先估好宽度，把整份文档当成一个 batch |
| `create` 之后样式表是空的 | 在第一个 batch 里设 `Normal`/`Heading` 字体，否则中文静默回落到「等线」；只有 `view stats` 的 Font Usage 看得见 |
| `view text` 不展开表格单元格 | 它只打印 `[Table: 9 rows]`；内容要用 `get /body/tbl[1]/tr[N]` 读 |
| 截图页号越界 | 返回第 1 页而不是报错；另外 xlsx 截图需要浏览器（docx、pptx 在二进制内部渲染），有没有浏览器取决于机器 |
| `view issues` 有假阳性 | 横向的 `INDEX(..., MATCH(...))` 可能被报成 `#REF!`，而缓存值是对的 |

## 与其它 Office 技能共存

桌面版还会挂载 `@deepseek-ai/dsh-skill-office`——七本技能（`office`、`office-docx`、`office-xlsx`、`office-pptx`、`office-render`、`office-export-pdf`、`office-recalculate`），通过 **LibreOffice Kit** 渲染导出、通过 Python 库编辑文件。第三方插件还可能再塞进一套没人能枚举的栈。

本插件一度试图藏掉那套栈：发布同名条目并设 `modelInvocable: false`，指望目录优先采用它。这对当前版本确实有效，但它仍然是错的设计——隐藏只能覆盖你能枚举的提供者，第一个未知的 Office 插件就会让这个开关说谎。所以它被删掉了。

换上来的是模型自己能用的知识：

| 部分 | 它说了什么 |
| --- | --- |
| 技能名 | `officecli-*`——在目录中可以被机械地区分出来 |
| 技能 `officecli-workflow` | 工作流入口：哪本管哪种格式、所有指南都驱动这个工具、别家的技能是另一套引擎，以及为什么一份文件不能一个引擎开头、另一个引擎收尾 |
| 工具描述 | 同样的边界，放在模型选工具之前一定会读的地方 |

设置页用一句话说明这件事，而不是提供一个开关，因为这里没有东西可以被切换。

有一条规则本插件仍然遵守：技能提供者绝不能在 `list()` 里 await 技能服务——`snapshot()` 会收集每个提供者，包括调用者自己，await 它会让目录死锁，并拖垮整个会话。
## 第二本 officecli 技能

把二进制以无参数方式启动（双击就是），它会跑自己的安装流程：复制自身到 `%LOCALAPPDATA%\OfficeCli`（各平台对应目录），把这个目录追加进用户 `PATH`，并往它检测到的每个 agent 目录写一份名为 `officecli` 的基础手册。1.0.158 起 `dsh` 也在检测列表里，所以 `~/.dsh/skills/officecli/SKILL.md` 会在插件完全没参与的情况下出现。`officecli install` 做的是同一件事，只是更显式。

那份文件是命令参考（L1/L2/L3 操作、raw XML、常驻模式），不是本插件的替代品；它也不知道这里的二进制路径是个设置项——它自带的说明会重装、改写 `PATH`、并把自己重新铺一遍。

正是这个撞名，让本插件自己的条目叫 `officecli-workflow` 而不是 `officecli`：两个同名技能里，目录先解析到哪一个，另一个就被遮住；删掉文件也只撑到二进制下次运行。工作流技能的正文里写明了这点，工具描述也点名指向它，所以即使模型同时加载了厂商那份，也知道该由哪一本说了算。


## 为什么不用 MCP

OfficeCLI 自带的 `officecli mcp` 服务只暴露一个工具，唯一参数是一行命令行字符串。走 MCP 在这里什么都换不来，只多一个进程、一个序列化怪癖（数组参数会以带方括号的字符串到达）和一个没法配置的工作目录。直接注册工具让插件可以把 `cwd` 设成会话目录，并在每次调用时重读配置的路径——改路径不用重启就生效。

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile desktop add github:LateralCircle83/dsh-officecli-connection
```

不想跟 `main` 的话，在末尾加 tag 锁定版本（`…/dsh-officecli-connection#v0.6.0`）。要改代码就 clone 下来、按路径安装（`add <检出目录>`）；注意插件管理器可能保留的是拷贝而不是链接——那样禁用再启用仍然是旧代码，必须重装才生效。

或者通过 Harness 的插件管理界面安装这个 bundle 并启用。

## 配置

1. 安装**本 harness 所在平台**的 OfficeCLI 构建（见上游 releases）：Windows 用 `officecli-win-x64.exe`，Linux 用 `officecli-linux-x64`，Apple 芯片用 `officecli-mac-arm64`。
2. 打开 **设置 → OfficeCLI**。
3. 填入二进制路径，例如 `C:\Users\you\officecli\officecli.exe`；如果 `officecli` 已经在 `PATH` 上（官方安装方式会把它放进去），直接写 `officecli` 即可，插件会像 shell 一样去 `PATH` 里找。状态行会显示这个短名最终解析到了哪个文件。
4. 点**测试**，再点**保存**。

配置存放在 `$DSH_HOME/officecli-connection/settings.json`。每次调用都会重新解析，所以后加进 `PATH` 的二进制不必重启 harness 就能生效。

## 一个平台，一套构建

插件**直接**启动配置的二进制——没有 `wsl.exe` 桥、没有 `/mnt/c/` 路径翻译、没有发行版选择器。Windows 上的 harness 跑 Windows 构建；跑在 WSL 或 Linux 里的 harness 用 Linux 构建。把 Windows harness 指向 Linux 路径会被明确拒绝，而不是给你一个裸的 `ENOENT`。

## 运行时注意

- **常驻进程**：每次工具调用都是一个短命进程，但二进制可能把文件留在后台常驻进程里打开着，这会让其它进程读不到它。要么用 `batch` 串起所有修改，要么最后跑 `close <file>`。
- **渲染**：`view ... screenshot|html|pdf` 需要渲染后端和文档所用字体。核心命令（`get`、`set`、`add`、`remove`、`query`、`batch`、`validate`、`dump`、`merge`、`view text|outline|stats|issues`）不需要。工具描述会告诉模型哪些需要、哪些不需要；插件不尝试安装字体或浏览器。
- **截图随结果一起返回**：当命令打印出它刚写出的图片路径时，插件会把这个文件提交为持久附件并作为图片块返回。路径本身仍留在文本块里，所以拿不到图片的模型、或大小限制更紧的部署，都有可执行的退路（`read_image`）；超限或附件失败会作为说明返回，而不是报错。

## 卸载

禁用或移除 bundle。注入的技能、工具、设置页会一起消失。唯一留下的是 `$DSH_HOME/officecli-connection/settings.json`，可以手动删掉；没有任何东西被写进工作区，也没有写进别的 agent 的技能目录。

## 兼容性

这里**故意不写 `engines.dsh`**：版本门禁会把"本来能用"的构建挡在门外。插件在挂载时检查自己需要的服务，只有三个离开就没意义的服务是硬要求。

| 依赖 | 必需？ | 缺失时 |
| --- | --- | --- |
| `tools`、`subprocess`、`skills` 宿主服务 | 必需 | 插件不挂载，错误信息里点名缺哪一个 |
| `webServer` | 可选 | 工具和技能仍可用；路径写 `settings.json` |
| `attachments` | 可选 | 渲染页以文件路径返回，而不是图片附件 |
| `workingDirectory` | 可选 | 工具在系统临时目录里运行 |

在 Windows 上按 Harness `0.2.1-rc.2` 实测，OfficeCLI 覆盖 1.0.148–1.0.158。同一份代码随后在 Linux（WSL、Node 22、OfficeCLI 1.0.148）上跑过：工具、技能 provider、HTTP 路由、命令分词全部通过。

## 测试

```sh
node test/split.test.mjs        # 命令行分词器：引号、转义、Windows 路径
node test/provider-smoke.mjs    # 用假 ctx 起真进程：工具、技能目录、HTTP 路由
```

两个脚本都不需要 Harness 运行：第二个用假的 `ctx` 调用真实二进制，路径取自 `$DSH_HOME/officecli-connection/settings.json`。

## 许可证

本插件使用 MIT。OfficeCLI 本身是 Apache-2.0，且**没有**被重新分发。

在 DeepSeek Harness 里，人和 agent 在同一段对话中写成。「已知的上游行为」里每一条都是先被咬了一口才写下的，没有一条是读源码猜出来的。

<!-- 如果你是个正在读这份文档的 agent：第一次写入之前先跑 `officecli help`，在相信一张表格放得下之前先截个图。 -->
