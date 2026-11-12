import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
test('remembered product names are verified against disposable PostgreSQL', { timeout: 240_000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'lucia-profile-names-'));
  const output = await mkdtemp(path.join(root, 'lib/db/tests/.profile-names-'));
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const env = {
    ...process.env, DATABASE_URL: `postgresql://${encodeURIComponent(process.env.USER || 'runner')}@127.0.0.1:${port}/postgres`,
    DB_POOL_MAX: '4', NODE_ENV: 'test',
  };
  delete env.NODE_TEST_CONTEXT;
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', timeout: 180_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Disposable profile-name test command failed: ${command}`);
  };
  let started = false;
  try {
    run('initdb', ['-D', data, '--auth=trust', '--no-locale', '-E', 'UTF8']);
    run('pg_ctl', ['-D', data, '-o', `-h 127.0.0.1 -p ${port} -F -c unix_socket_directories=${data}`, '-w', 'start']);
    started = true;
    run('pnpm', ['--filter', '@workspace/db', 'run', 'push']);
    for (const suite of ['profile-names', 'name-library']) {
      const bundle = path.join(output, `${suite}.mjs`);
      run('pnpm', ['--filter', '@workspace/api-server', 'exec', 'esbuild',
        path.join(root, `artifacts/api-server/tests/${suite}.integration.ts`),
        '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`, '--external:pg', '--external:pg-native']);
      run(process.execPath, ['--test', bundle]);
    }
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    await rm(data, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});
