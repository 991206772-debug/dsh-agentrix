// Synthetic projects for real-model, multi-turn acceptance. No user files are used.
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const initialNotice = '状态：待确认\n备注：保持原样\n'
const expectedNotice = supplemented => '状态：已确认\n备注：' + (supplemented ? '已复核' : '保持原样') + '\n'
const contactsStub = 'export function normalizeContacts(rows) {\n  // TODO: 按 README 实现联系人规范化。\n  return []\n}\n'
const ordersStub = 'export function summarizeOrders(rows) {\n  // TODO: 按 README 实现订单汇总。\n  return []\n}\n'

const helperPath = fileURLToPath(import.meta.url)
const command = module => "node '" + helperPath.replaceAll("'", "''") + "' " + module

const contactsProtocol = `# 联系人双来源协议

接口为 contacts.mjs 的 export function normalizeContacts(rows)。
- 非数组输入返回 []；跳过 null、数组和非对象行，不修改输入。
- 用 Object.hasOwn 判断字段存在性：name 存在则选 name，否则选 displayName；phone 存在则选 phone，否则选 mobile。原字段存在但无效时跳过该行，不回退别名。
- 选中的名字必须为字符串且 trim 后非空，输出 name 是 trim 后的值。
- 选中的电话必须为字符串；去掉全部空白和连字符后，最多去掉一个开头的 +86 或 0086，剩余必须恰好为 11 位数字。输出 phone 是这 11 位数字。
- 同规范化手机号仅保留第一条有效记录，按 phone 字典升序输出；基础输出恰好为 { name, phone }。
- VIP 标记同样用 Object.hasOwn：vip 存在则选 vip，否则选 isVip；仅严格布尔 true 算 VIP，false、字符串、数字及缺失均不算。基础输出不含此标记，若用户要求 tag 则 VIP 为 vip，其余为 regular。
`
const ordersProtocol = `# 订单双来源协议

接口为 orders.mjs 的 export function summarizeOrders(rows)。
- 非数组输入返回 []；跳过 null、数组和非对象行，不修改输入。
- status 只接受精确字符串 paid 或 PAID，其他值不参与汇总。
- 用 Object.hasOwn 判断字段存在性：id 存在则选 id，否则选 orderId；customer 存在则选 customer，否则选 buyer。选中值必须为 trim 后非空字符串；原字段无效时不回退别名。
- amountCents 存在时最高优先，必须为非负的安全整数 number，代表分；无效时跳过该行，不回退元金额。
- 没有 amountCents 时，amount 存在则选 amount，否则选 paidAmount。选中值可为有限非负 number，或严格两位小数的元字符串。字符串必须全串匹配：整数部分为 0 或不以 0 开头的十进制正整数，随后一个小数点和恰好两位数字；不接受空白、正负号、指数、1、1.0、01.00。无效时不回退别名。
- 同 trim 后 id 仅保留第一条有效已支付订单，无效或未支付行不占用 id；按 trim 后 customer 汇总。
- 输出恰好为 { customer, count, total }，按 customer 字典升序。先把该客户所有有效金额（分金额先除以100）相加，再按非负数四舍五入保留两位小数，不逐笔舍入。
`

function readme(project, delegated, extended = false) {
  return delegated ? `# 数据清理子工程

两个模块互不依赖，均为无 import 的纯 JavaScript，保留具名 export function 接口。
只修改 contacts.mjs、orders.mjs，不修改本说明，不引入依赖、不生成额外文件。

${extended ? `## 兼容目标
为联系人和订单的两种数据来源提供兼容，输出接口保持一致。
联系人字段、电话和 VIP 规则见 CONTACTS.md；订单别名、支付状态和金额规则见 ORDERS.md。
两份协议是只读说明，各模块按对应协议实现。` : `## contacts.mjs: normalizeContacts(rows)
- 非数组输入返回 []；跳过 null、数组和非对象行。
- name 必须为字符串且 trim 后非空，输出 name 是 trim 后的值；phone 必须为字符串。
- phone 去掉空白和连字符后必须恰好为 11 位数字，否则跳过。
- 同手机号仅保留第一条有效记录；按手机号字典升序输出。
- 每条输出恰好为 { name, phone }，不修改输入。

## orders.mjs: summarizeOrders(rows)
- 非数组输入返回 []；跳过 null、数组和非对象行。
- 仅 status === 'paid' 参与汇总。
- id、customer 必须为 trim 后非空字符串；amount 必须为有限且非负的 number。
- 同一 trim 后的 id 仅保留第一条有效已支付订单，未支付或无效行不占用 id。
- 按 trim 后的 customer 汇总，输出 { customer, count, total }，按 customer 字典升序。
- total 将该客户所有有效金额相加后保留两位小数，使用非负数四舍五入；不修改输入。`}

## 验证
通过 pwsh 运行固定测试命令，workdir 必须为 ${project}。command 可为：
${['contacts', 'orders', 'all'].map(command).join('\n')}
它真实读取当前文件，在没有宿主文件/网络接口的受限上下文运行固定业务断言。
不需要 npm 安装或编写测试文件。代码错误会返回 exitCode: 1 及首个失败。
` : `# 通知子工程

notice.txt 为两行通知，保持字段和换行格式。
只修改 notice.txt，不修改本说明，不生成额外文件。
通过 pwsh 对通知内容作完整比较，workdir 为 ${project}，command 为：
${command('all')}
不需要安装依赖。
`
}

export async function setupWorkflow(project, delegated, extended = false) {
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, 'README.md'), readme(project, delegated, extended))
  if (delegated && extended) {
    await writeFile(path.join(project, 'CONTACTS.md'), contactsProtocol)
    await writeFile(path.join(project, 'ORDERS.md'), ordersProtocol)
  }
  const files = delegated ? { 'contacts.mjs': contactsStub, 'orders.mjs': ordersStub } : { 'notice.txt': initialNotice }
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(project, file), content)
  return {
    allowedFiles: Object.keys(files), gatedFiles: delegated ? ['contacts.mjs'] : Object.keys(files), testCommand: command,
    discussion: delegated
      ? extended ? `子工程在 ${project}。先看 README，讨论一下两种来源的数据兼容如何实现、怎么验证，先不要修改文件。`
        : `子工程在 ${project}。先看 README 和两个现有模块，讨论一下这次数据清理功能如何实现、怎么验证，先不要修改文件。`
      : `子工程在 ${project}。notice.txt 的状态我想从“待确认”改为“已确认”，备注先保留。先看看文件，跟我说明改哪里、怎么核对，先不要修改文件。`,
    implementation: '可以，按刚才讨论的方案开始调整，完成后验证并告诉我结果。',
    supplement: delegated
      ? extended ? '中途补充：联系人输出再加 tag 字段，按 CONTACTS.md 的 VIP 标记规则，VIP 为“vip”，其余为“regular”。订单汇总和其他要求保持。'
        : '中途补充：联系人输出再加 tag 字段，原始行 vip === true 时为“vip”，其余为“regular”。订单汇总和其他要求保持。'
      : '补充一下：备注也改成“已复核”，状态继续保持“已确认”，两行格式和末尾换行不变。',
  }
}

const contactInputs = [
  null, {}, [],
  [null, [], 'bad', { name: ' ', phone: '13800138000' }, { name: 'bad', phone: 13800138000 },
    { name: 'bad', phone: '+86 13800138000' }, { name: 'bad', phone: '123' }],
  [{ name: ' Zed ', phone: '139-0013 9000', vip: true }, { name: ' Amy ', phone: '13800138000' },
    { name: 'duplicate', phone: '13900139000' }, { name: 'ignored', phone: '13800138000', vip: true }],
  [{ name: '', phone: '13800138000' }, { name: 'Valid', phone: '138 0013-8000', vip: 'true' }],
]
const orderInputs = [
  null, {}, [],
  [null, [], 'bad', { id: 'x', customer: 'A', amount: '2', status: 'paid' },
    { id: ' ', customer: 'A', amount: 2, status: 'paid' }, { id: 'x', customer: ' ', amount: 2, status: 'paid' },
    { id: 'x', customer: 'A', amount: -1, status: 'paid' }, { id: 'x', customer: 'A', amount: 2, status: 'pending' }],
  [{ id: 'x', customer: 'B', amount: 999, status: 'pending' }, { id: ' x ', customer: ' B ', amount: 2.25, status: 'paid' },
    { id: 'x', customer: 'A', amount: 99, status: 'paid' }, { id: 'y', customer: 'A', amount: 0, status: 'paid' },
    { id: 'z', customer: 'B', amount: 0.75, status: 'paid' }, { id: 'r', customer: 'A', amount: 4, status: 'refunded' }],
  [{ id: 'a', customer: 'A', amount: 0.104, status: 'paid' }, { id: 'b', customer: 'A', amount: 0.104, status: 'paid' },
    { id: 'c', customer: 'B', amount: 1.005, status: 'paid' }],
]
const extendedContactInputs = [
  [{ displayName: ' Alias ', mobile: '+86 137-0013 7000', isVip: true }, { name: 'Canon', phone: '13600136000' }],
  [{ name: ' First ', displayName: 'Other', phone: '13500135000', mobile: '13400134000' },
    { name: '', displayName: 'Ignored', phone: '13300133000' }, { name: 'Ignored', phone: null, mobile: '13200132000' }],
  [{ name: 'Prefix', phone: '0086 13800138000' }, { name: 'Duplicate', phone: '+86-13800138000' },
    { name: 'Bad', phone: '+86008613800138000' }, { name: 'Foreign', phone: '+1 13800138000' }],
  [{ name: 'False', phone: '13100131000', vip: false, isVip: true }, { displayName: 'AliasVIP', mobile: '13000130000', isVip: true },
    { name: 'String', phone: '13200132000', vip: 'true', isVip: true }],
  [{ name: ' ', phone: '13900139000' }, { displayName: ' Valid ', mobile: '13900139000', isVip: 1 }],
]
const extendedOrderInputs = [
  [{ orderId: ' a ', buyer: ' A ', paidAmount: '12.30', status: 'PAID' }, { id: 'b', customer: 'A', amount: '0.20', status: 'paid' }],
  [{ id: 'a', orderId: 'other', customer: ' A ', buyer: 'B', amount: 2, paidAmount: '9.00', status: 'paid' },
    { id: '', orderId: 'b', customer: 'A', amount: 2, status: 'paid' }, { id: 'c', customer: null, buyer: 'A', amount: 2, status: 'paid' },
    { id: 'd', customer: 'A', amount: '2', paidAmount: '9.00', status: 'paid' }],
  [{ id: 'a', customer: 'A', amountCents: 125, amount: 9, status: 'paid' },
    ...[-1, 1.5, '125', 9007199254740992].map((amountCents, i) => ({ id: 'bad' + i, customer: 'A', amountCents, amount: 9, status: 'paid' }))],
  [...['1', '1.0', '01.00', ' 1.00', '+1.00', '1e2', '-1.00'].map((amount, i) => ({ id: 'bad' + i, customer: 'A', amount, status: 'paid' })),
    { id: 'zero', customer: 'A', amount: '0.00', status: 'paid' }],
  [{ orderId: 'x', buyer: 'A', paidAmount: '2.00', status: 'pending' },
    { orderId: ' x ', buyer: 'B', paidAmount: '1.25', status: 'PAID' }, { id: 'x', customer: 'A', amount: 9, status: 'paid' },
    { orderId: 'y', buyer: 'A', paidAmount: '1.00', status: 'Paid' }, { orderId: 'z', buyer: 'A', paidAmount: 0.75, status: 'PAID' }],
]

function expectedContacts(supplemented, extended) {
  const row = (name, phone, vip = false) => ({ name, phone, ...(supplemented ? { tag: vip ? 'vip' : 'regular' } : {}) })
  const basic = [[], [], [], extended ? [row('bad', '13800138000')] : [],
    [row('Amy', '13800138000'), row('Zed', '13900139000', true)], [row('Valid', '13800138000')]]
  return extended ? [...basic, [row('Canon', '13600136000'), row('Alias', '13700137000', true)], [row('First', '13500135000')],
    [row('Prefix', '13800138000')], [row('AliasVIP', '13000130000', true), row('False', '13100131000'), row('String', '13200132000')],
    [row('Valid', '13900139000')]] : basic
}

function expectedOrders(extended) {
  const basic = [[], [], [], [], [{ customer: 'A', count: 1, total: 0 }, { customer: 'B', count: 2, total: 3 }],
    [{ customer: 'A', count: 2, total: 0.21 }, { customer: 'B', count: 1, total: 1.01 }]]
  const extra = extended ? [[{ customer: 'A', count: 2, total: 12.5 }], [{ customer: 'A', count: 1, total: 2 }],
    [{ customer: 'A', count: 1, total: 1.25 }], [{ customer: 'A', count: 1, total: 0 }],
    [{ customer: 'A', count: 1, total: 0.75 }, { customer: 'B', count: 1, total: 1.25 }]] : []
  return [...basic, ...extra, []]
}

async function testModule(project, file, functionName, inputs, expected) {
  const source = await readFile(path.join(project, file), 'utf8')
  assert.ok(source.length <= 64_000, file + ' exceeds the fixture source limit')
  const declaration = new RegExp('\\bexport\\s+(?=function\\s+' + functionName + '\\s*\\()')
  assert.ok(declaration.test(source), file + ' must retain its named export function')
  const executable = source.replace(declaration, '')
  const cases = functionName === 'summarizeOrders'
    ? `[...${JSON.stringify(inputs)}, [NaN, Infinity, -Infinity].map(amount => ({ id: 'invalid', customer: 'A', status: 'paid', amount }))]`
    : JSON.stringify(inputs)
  // Only source text and JSON cross the boundary. Host callbacks/objects are not exposed.
  const script = new vm.Script("'use strict';\n" + executable + `\n;JSON.stringify(${cases}.map(input => {
    const before = JSON.stringify(input)
    const output = ${functionName}(input)
    return { output, unchanged: before === JSON.stringify(input) }
  }))`, { filename: file })
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' })
  const serialized = script.runInContext(context, { timeout: 500 })
  assert.equal(typeof serialized, 'string', file + ' must return serializable values')
  const actual = JSON.parse(serialized)
  for (let index = 0; index < expected.length; index++) {
    assert.deepEqual(actual[index].output, expected[index], file + ' case ' + (index + 1))
    assert.equal(actual[index].unchanged, true, file + ' must not mutate input; case ' + (index + 1))
  }
  return file + ': ' + expected.length + ' cases passed'
}

export async function runWorkflowTests(project, delegated, module = 'all', supplemented = false, extended = false) {
  try {
    assert.ok(['all', 'contacts', 'orders'].includes(module), 'Unknown fixture test module')
    if (!delegated) {
      assert.equal(await readFile(path.join(project, 'notice.txt'), 'utf8'), expectedNotice(supplemented), 'notice.txt exact content')
      return { exitCode: 0, output: 'notice.txt: exact content and newline passed' }
    }
    const output = []
    if (module !== 'orders') output.push(await testModule(project, 'contacts.mjs', 'normalizeContacts', [...contactInputs, ...(extended ? extendedContactInputs : [])], expectedContacts(supplemented, extended)))
    if (module !== 'contacts') output.push(await testModule(project, 'orders.mjs', 'summarizeOrders', [...orderInputs, ...(extended ? extendedOrderInputs : [])], expectedOrders(extended)))
    return { exitCode: 0, output: output.join('\n') }
  } catch (error) {
    return { exitCode: 1, output: String(error.message ?? error) }
  }
}

export async function verifyWorkflow(project, delegated, extended = false) {
  const expectedFiles = delegated ? ['README.md', 'contacts.mjs', 'orders.mjs'] : ['README.md', 'notice.txt']
  if (delegated && extended) expectedFiles.push('CONTACTS.md', 'ORDERS.md')
  assert.deepEqual((await readdir(project)).sort(), expectedFiles.sort(), 'Only requested project files may exist')
  assert.equal(await readFile(path.join(project, 'README.md'), 'utf8'), readme(project, delegated, extended), 'Project instructions must remain unchanged')
  if (delegated && extended) {
    assert.equal(await readFile(path.join(project, 'CONTACTS.md'), 'utf8'), contactsProtocol, 'Contact protocol must remain unchanged')
    assert.equal(await readFile(path.join(project, 'ORDERS.md'), 'utf8'), ordersProtocol, 'Order protocol must remain unchanged')
  }
  const tests = await runWorkflowTests(project, delegated, 'all', true, extended)
  assert.equal(tests.exitCode, 0, tests.output)
  return { files: expectedFiles, output: tests.output }
}

if (process.argv[1] && path.resolve(process.argv[1]) === helperPath) {
  const project = process.cwd()
  const files = await readdir(project), delegated = files.includes('contacts.mjs'), extended = files.includes('CONTACTS.md')
  const result = await runWorkflowTests(project, delegated, process.argv[2] ?? 'all', process.env.AGENTRIX_WORKFLOW_SUPPLEMENTED === '1', extended)
  console.log(JSON.stringify(result))
  process.exitCode = result.exitCode
}
