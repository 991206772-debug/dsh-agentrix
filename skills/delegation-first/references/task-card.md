# 结构化任务卡

主控通过 `delegation_plan({goal,relation,messageId,decisionReason,start:true,tasks})` 一次记录委派、建立计划并派发。`decisionReason` 是本次委派的具体理由（非空，最多 500 字），与消息关联一起保存；relation 为 new/continue/update/question，多条待处理消息必须填写真实 messageId；若已经调用 `delegation_decide` 记录 delegate，可省略。省略 start 或填 false 仍仅保存，不启动代理。一个计划最多 16 个任务，每任务最多 4 个主控验证步骤。同类小改合为一个任务，保留逐项标准和检查；有独立判断、验证或并行价值才拆分，不按文件数拆卡。

| 字段 | 要求 |
| --- | --- |
| `id` | 唯一编号，字母、数字、短横线、下划线 |
| `title` | 简短任务标题 |
| `instructions` | 自足的输入、步骤、参考路径和停止条件 |
| `scope` | 允许范围、排除项、缺少关键信息时如何报告 |
| `outputs` | 可定位的交付物路径或输出说明 |
| `writes` | 可修改文件或目录；只读任务填空数组 |
| `dependsOn` | 本计划内的前置任务编号，禁止循环依赖 |
| `complexity` | `routine` 普通任务或 `complex` 复杂任务，只说明执行难度，不改变执行模型 |
| `complexityReason` | 可选，说明本任务为什么属于该档位；新计划应填写，历史缺失时明确显示未记录 |
| `reviewPolicy` | 可选，`coordinator` 主控验证验收，`independent` 额外独立审查；主控按风险选择，两项审查字段均省略时兼容 complex 自动审查的旧约定 |
| `reviewReason` | 指定 `reviewPolicy` 时必填，非空且最多 1000 字，说明风险与审查必要性；高风险工作使用 independent |
| `criteria` | 能逐条核对的非空标准数组 |
| `checks` | 主控实际执行的验证步骤，每项有 `tool`、`arguments` |

验证工具支持 `read`、`grep`、`glob`、`pwsh`、`bash`。参数必须符合当前工具定义；shell 用前台命令。代码任务通常同时安排读取交付物和运行相关测试。

执行者用配置的 worker；独立审查沿用该次派发时记录的主控模型和思考强度，无需额外配置。主控应先确定方案，把足够明确的指令交给执行者，不通过修改 complexity 偷换执行模型。

```json
{
  "goal": "补充登录失败场景验证",
  "relation": "new",
  "start": true,
  "decisionReason": "执行模型按既有结构补充测试，主控独立验证结果并逐项验收。",
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
