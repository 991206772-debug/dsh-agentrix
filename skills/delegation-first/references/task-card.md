# 结构化任务卡

主控通过 `delegation_plan({goal,decisionReason,tasks})` 提交任务。`decisionReason` 是本次委派的具体理由（8—500 字），与建计划一并保存；若已经调用 `delegation_decide` 记录 delegate，可省略。建立计划不启动代理。一个计划最多 16 个任务，每任务最多 4 个主控验证步骤。

| 字段 | 要求 |
| --- | --- |
| `id` | 唯一编号，字母、数字、短横线、下划线 |
| `title` | 简短任务标题 |
| `instructions` | 自足的输入、步骤、参考路径和停止条件 |
| `scope` | 允许范围、排除项、缺少关键信息时如何报告 |
| `outputs` | 可定位的交付物路径或输出说明 |
| `writes` | 可修改文件或目录；只读任务填空数组 |
| `dependsOn` | 本计划内的前置任务编号，禁止循环依赖 |
| `complexity` | `routine` 普通任务或 `complex` 复杂任务；复杂度不改变执行模型，complex 自动安排独立审查 |
| `complexityReason` | 可选，说明本任务为什么属于该档位；新计划应填写，历史缺失时明确显示未记录 |
| `criteria` | 能逐条核对的非空标准数组 |
| `checks` | 主控实际执行的验证步骤，每项有 `tool`、`arguments` |

验证工具支持 `read`、`grep`、`glob`、`pwsh`、`bash`。参数必须符合当前工具定义；shell 用前台命令。代码任务通常同时安排读取交付物和运行相关测试。

执行者用配置的 worker；独立审查沿用该次派发时记录的主控模型和思考强度，无需额外配置。主控应先确定方案，把足够明确的指令交给执行者，不通过修改 complexity 偷换执行模型。

```json
{
  "goal": "补充登录失败场景验证",
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
      {"tool": "read", "arguments": {"path": "tests/login.failures.test.js"}},
      {"tool": "pwsh", "arguments": {"description": "Run login failure tests", "command": "node --test tests/login.failures.test.js"}}
    ]
  }]
}
```

示例路径不是当前项目的事实，提交前必须根据实际源码替换。遇到输入不足导致无法填写任务卡时，先用读工具获取必要信息，不把猜测当作要求。

验收通过后才会派出依赖该任务的子任务。不要用“代码质量好”“逻辑清晰”这种无法核对的标准。
