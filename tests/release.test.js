import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))

test('release package contains its installable bundle, documentation and storefront assets without local records', async () => {
  const args = ['pack', '--dry-run', '--ignore-scripts', '--json']
  const command = process.env.npm_execpath
    ? [process.execPath, [process.env.npm_execpath, ...args]]
    : process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', 'npm.cmd pack --dry-run --ignore-scripts --json']]
      : ['npm', args]
  const packed = spawnSync(command[0], command[1], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(packed.status, 0, packed.stderr || packed.error?.message)
  const [manifest] = JSON.parse(packed.stdout)
  const files = new Set(manifest.files.map(file => file.path))
  for (const file of ['index.js', 'orchestrator.js', 'supervision.js', 'completion.js', 'task-records.js', 'client.js',
    'cordis.patch.yml', 'README.md', 'LICENSE', 'docs/usage.md', 'icon.svg', 'assets/icon.png', 'screenshots.json']) {
    assert.ok(files.has(file), `missing release file: ${file}`)
  }
  for (const file of files) {
    assert.ok(!/^(?:tests\/|dist\/|release\/|\.env|task_plan\.md$|findings\.md$|progress\.md$)/.test(file), `local file entered release: ${file}`)
    if (!/\.(?:js|json|md|yml)$/.test(file)) continue
    const content = await readFile(path.join(root, file), 'utf8')
    assert.doesNotMatch(content, /[a-z]:[/\\]+Users[/\\]+|[a-z]:[/\\]+tools[/\\]+test(?:[/\\]+|\b)/i, `local path in ${file}`)
    assert.doesNotMatch(content, /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, `real session ID in ${file}`)
  }
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(files.has(packageJson.dsh.bundle.patch.replace(/^\.\//, '')))
  const screenshots = JSON.parse(await readFile(path.join(root, 'screenshots.json'), 'utf8'))
  assert.ok(Array.isArray(screenshots) && screenshots.length >= 1 && screenshots.length <= 8)
  for (const file of screenshots) {
    assert.ok(!file.startsWith('/') && !file.includes('..'), `screenshot leaves plugin directory: ${file}`)
    assert.ok(files.has(file), `missing screenshot: ${file}`)
  }
})
