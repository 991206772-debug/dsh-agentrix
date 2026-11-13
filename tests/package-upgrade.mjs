// Isolated npm install/upgrade/rollback, file integrity, and packaged native-runtime replay.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const root = fileURLToPath(new URL('..', import.meta.url))
const baseline = process.argv[2]
assert.match(baseline ?? '', /^[a-f0-9]{7,40}$/, 'pass the reviewed baseline commit')
assert.ok(process.env.DSH_EXECUTABLE && process.env.DSH_MODULE_ROOT, 'installed DSH runtime paths are required')
const directory = await mkdtemp(path.join(os.tmpdir(), 'agentrix-package-'))
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000 })
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
function npm(args, cwd) {
  return process.env.npm_execpath ? run(process.execPath, [process.env.npm_execpath, ...args], cwd)
    : process.platform === 'win32' ? run('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...args], cwd) : run('npm', args, cwd)
}
try {
  const old = path.join(directory, 'baseline'), artifacts = path.join(directory, 'artifacts'), install = path.join(directory, 'install')
  await Promise.all([mkdir(old), mkdir(artifacts), mkdir(install)])
  const archive = path.join(directory, 'baseline.tar')
  run('git', ['archive', '--format=tar', '--output=' + archive, baseline], root)
  run('tar', ['-xf', archive, '-C', old], root)
  const oldPackage = JSON.parse(npm(['pack', '--ignore-scripts', '--json'], old))[0]
  const nextPackage = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], root))[0]
  const installed = path.join(install, 'node_modules', '@local', 'dsh-delegation-first')
  async function verify(source, manifest) {
    for (const file of manifest.files) {
      const digest = data => createHash('sha256').update(data).digest('hex')
      assert.equal(digest(await readFile(path.join(installed, file.path))), digest(await readFile(path.join(source, file.path))), file.path)
    }
  }
  function replay(scenario) {
    const output = run(process.env.DSH_EXECUTABLE, [path.join(root, 'tests', 'native-reliability.mjs'), scenario], root,
      { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTRIX_PACKAGE_ROOT: installed })
    assert.match(output, /PASS: installed native reliability/)
    process.stdout.write(output)
  }
  npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.join(old, oldPackage.filename)], install)
  await verify(old, oldPackage); replay('direct')
  npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.join(artifacts, nextPackage.filename)], install)
  await verify(root, nextPackage); replay('cancel-cleanup'); replay('acceptance-save'); replay('delivery-persistence'); replay('audited-resolutions'); replay('project-directory')
  npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.join(old, oldPackage.filename)], install)
  await verify(old, oldPackage); replay('direct')
  console.log('PASS: baseline install, current tgz upgrade and baseline rollback match every packaged file; isolated native replays passed')
} finally { await rm(directory, { recursive: true, force: true }) }
