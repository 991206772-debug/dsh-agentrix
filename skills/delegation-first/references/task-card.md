# 结构化任务卡

确定委派值得后，主控通过 `delegation_plan({goal,directory,relation,messageId,decisionReason,start:true,tasks})` 一次记录委派、建立计划并派发。执行方式由直接完成改为委派时，先向用户用一句话说明变化和具体理由，再派发，并使用 `relation:update`。`decisionReason` 说明相对直接完成的具体收益与准备、汇报、验收开销，不能只复述角色分工（非空，最多 500 字），与消息关联一起保存；relation 为 new/continue/update/question，多条待处理消息必须填写真实 messageId；没有待关联消息且已经调用 `delegation_decide` 记录 delegate 时，才可省略 decisionReason。省略 start 或填 false 仍仅保存，不启动代理。一个计划最多 16 个任务，每任务最多 4 个主控验证步骤。同类小改合为一个任务，保留逐项标准和检查；有独立判断、验证或并行价值才拆分，不按文件数拆卡。

顶层可选 `directory` 指定已存在、可读取的工程目录；相对值基于父会话目录解析，省略则沿用父会话目录。子工程应显式指定，例如 `directory:"./project"`，不能只在 instructions 中写工程位置。writes 会按计划目录保存为绝对路径；outputs 保留所填路径，交付时按同一计划目录解析；子代理也在该目录运行。继续已有计划不能改换目录。

显式提供 directory 时，read/grep/glob 检查中的相对 path/file_path 按计划目录解析；grep/glob 缺少路径时使用该目录。pwsh/bash 检查缺少 workdir 时补为计划目录，已有相对 workdir 也按计划目录解析。未提供 directory、产物使用相对路径，但 shell 检查的 workdir 指向其他目录时，派发前会拒绝，须先明确工程目录。

| 字段 | 要求 |
| --- | --- |
| `id` | 唯一编号，字母、数字、短横线、下划线 |
| `title` | 简短任务标题 |
| `instructions` | 自足的目标、已定方案与事实；区分必读和按需参考、用户硬要求和主控建议，明确停止条件 |
| `scope` | 允许范围、排除项、缺少关键信息时如何报告 |
| `outputs` | 可定位的交付物路径或输出说明；文件相对路径基于计划目录 |
| `writes` | 可修改文件或目录，相对路径基于计划目录；只读任务填空数组 |
| `dependsOn` | 本计划内的前置任务编号，禁止循环依赖 |
| `complexity` | `routine`：方案明确、按已有材料执行；`complex`：仍有跨资料推理或设计取舍的未决难点。只说明执行难度，不决定是否委派或改变执行模型 |
| `complexityReason` | 可选，新计划应说明实际难点或普通执行依据；篇幅长、要发布或重要不足以单独判复杂，主控已解决的判断不重复计入；历史缺失显示未记录 |
| `reviewPolicy` | 接口可选，新任务应显式填写：`coordinator` 主控验证验收，`independent` 额外独立审查；按错误后果选择。两项审查字段均省略时兼容 complex 自动审查的旧约定 |
| `reviewReason` | 指定 `reviewPolicy` 时必填，非空且最多 1000 字，说明风险与审查必要性；高风险工作使用 independent |
| `criteria` | 能逐条核对的用户要求与必要正确性验证；主控建议不自动成为硬性标准 |
| `checks` | 主控实际执行的验证步骤，每项有 `tool`、`arguments`；合并固定检查，未变更且已成功时不重复自测 |

验证工具支持 `read`、`grep`、`glob`、`pwsh`、`bash`。`checks.arguments` 必须使用当前工具定义的字段名、类型及全部必填项；建计划前的运行提示会列出当前工具的必填项，不把 `file_path` 改成 `path`，也不遗漏 Shell 工具要求的说明字段。参数错误会按任务和检查编号一次列出已发现的缺项、类型错误或不接受的字段；校验通过前不会保存新计划或派发。shell 用前台命令。代码任务通常同时安排读取交付物和运行相关测试。

执行者用配置的 worker；独立审查沿用该次派发时记录的主控模型和思考强度，无需额外配置。主控应先确定方案，把足够明确的指令交给执行者，不通过修改 complexity 偷换执行模型。

```json
{
  "goal": "补充登录失败场景验证",
  "directory": "./project",
  "relation": "new",
  "start": true,
  "decisionReason": "已有测试结构与预期结果明确，两条失败场景可由执行模型独立补齐；交接只需引用示例与接口，主控保留测试运行和验收。",
  "tasks": [{
    "id": "login-tests",
    "title": "补充登录失败测试",
    "instructions": "参考 tests/login.success.test.js，新建失败测试，覆盖密码错误和账号锁定。若需要改业务实现先报告阻塞。",
    "scope": "只修改新测试文件，不改业务实现或依赖。",
    "outputs": ["tests/login.failures.test.js"],
    "writes": ["tests/login.failures.test.js"],
    "dependsOn": [],
    "complexity": "routine",
    "complexityReason": "沿用现有测试结构补充明确的失败场景",
    "reviewPolicy": "independent",
    "reviewReason": "覆盖登录与账号锁定等权限边界，由独立审查核对覆盖范围，主控运行测试并验收",
    "criteria": ["覆盖密码错误和账号锁定两条路径", "相关测试退出码为 0"],
    "checks": [
      {"tool": "read", "arguments": {"file_path": "tests/login.failures.test.js"}},
      {"tool": "pwsh", "arguments": {"description": "Run login failure tests", "command": "node --test tests/login.failures.test.js"}}
    ]
  }]
}
```

示例路径不是当前项目的事实，提交前必须根据实际源码替换。遇到输入不足导致无法填写任务卡时，先用读工具获取必要信息，不把猜测当作要求。

验收通过后才会派出依赖该任务的子任务。不要用“代码质量好”“逻辑清晰”这种无法核对的标准。
