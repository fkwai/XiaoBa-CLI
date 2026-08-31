import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isBashCommandAllowed,
  isPathAllowed,
  isToolAllowed,
  isReadPathAllowed,
} from '../src/utils/safety';
import { ShellTool } from '../src/tools/bash-tool';
import { WriteTool } from '../src/tools/write-tool';

test('shell safety blocks confirmable destructive commands until explicitly confirmed', () => {
  assert.deepEqual(isBashCommandAllowed('git reset --hard'), {
    allowed: false,
    reason: '检测到会丢弃工作区改动的 git reset --hard。请先确认用户明确要求该危险操作，再用 confirm_dangerous=true 重试；如需强制绕过全部 shell 安全检查，请设置 GAUZ_BASH_ALLOW_DANGEROUS=true',
  });
  assert.deepEqual(isBashCommandAllowed('git reset --hard', { confirmed: true }), {
    allowed: true,
  });
});

test('shell safety keeps extreme destructive commands blocked even with command confirmation', () => {
  const result = isBashCommandAllowed('rm -rf /', { confirmed: true });

  assert.equal(result.allowed, false);
  assert.match(result.reason || '', /rm -rf \//);
  assert.match(result.reason || '', /GAUZ_BASH_ALLOW_DANGEROUS=true/);
});

test('shell safety supports explicit environment override for emergency maintenance', () => {
  assert.deepEqual(isBashCommandAllowed('rm -rf /', {
    env: { GAUZ_BASH_ALLOW_DANGEROUS: 'true' },
  }), { allowed: true });
});

test('execute_shell schema exposes confirm_dangerous and enforces it before execution', async () => {
  const shell = new ShellTool();
  const param = shell.definition.parameters.properties.confirm_dangerous;
  assert.equal(param?.type, 'boolean');

  const result = await shell.execute({
    command: 'git reset --hard',
  }, {
    workingDirectory: process.cwd(),
    conversationHistory: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PERMISSION_DENIED');
  assert.match(result.message, /confirm_dangerous=true/);
});

test('write safety blocks direct .env mutation unless explicitly allowed by environment', async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-safety-'));
  const previous = process.env.GAUZ_FS_ALLOW_DOTENV;
  delete process.env.GAUZ_FS_ALLOW_DOTENV;

  try {
    const envPath = path.join(testRoot, '.env');
    assert.equal(isPathAllowed(envPath, testRoot).allowed, false);

    const write = new WriteTool();
    const result = await write.execute({
      file_path: '.env',
      content: 'SECRET=value',
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.equal(fs.existsSync(envPath), false);

    process.env.GAUZ_FS_ALLOW_DOTENV = 'true';
    assert.equal(isPathAllowed(envPath, testRoot).allowed, true);
  } finally {
    if (previous === undefined) delete process.env.GAUZ_FS_ALLOW_DOTENV;
    else process.env.GAUZ_FS_ALLOW_DOTENV = previous;
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('isToolAllowed blocks dangerous tools by default', () => {
  // 危险工具默认被阻止
  assert.equal(isToolAllowed('execute_shell').allowed, false);
  assert.equal(isToolAllowed('execute_bash').allowed, false);
  assert.equal(isToolAllowed('write_file').allowed, false);
  assert.equal(isToolAllowed('edit_file').allowed, false);
  assert.equal(isToolAllowed('self_evolution').allowed, false);

  // 非危险工具默认允许
  assert.equal(isToolAllowed('read_file').allowed, true);
  assert.equal(isToolAllowed('glob').allowed, true);
  assert.equal(isToolAllowed('grep').allowed, true);
});

test('isToolAllowed allows dangerous tools when GAUZ_TOOL_ALLOW is set', () => {
  const previous = process.env.GAUZ_TOOL_ALLOW;

  try {
    process.env.GAUZ_TOOL_ALLOW = 'execute_shell,write_file';
    assert.equal(isToolAllowed('execute_shell').allowed, true);
    assert.equal(isToolAllowed('write_file').allowed, true);
    assert.equal(isToolAllowed('edit_file').allowed, false); // not in allow list

    process.env.GAUZ_TOOL_ALLOW = 'execute_shell,execute_bash,write_file,edit_file,self_evolution';
    assert.equal(isToolAllowed('execute_shell').allowed, true);
    assert.equal(isToolAllowed('execute_bash').allowed, true);
    assert.equal(isToolAllowed('write_file').allowed, true);
    assert.equal(isToolAllowed('edit_file').allowed, true);
    assert.equal(isToolAllowed('self_evolution').allowed, true);
  } finally {
    if (previous === undefined) delete process.env.GAUZ_TOOL_ALLOW;
    else process.env.GAUZ_TOOL_ALLOW = previous;
  }
});

test('isReadPathAllowed blocks paths outside working directory by default', () => {
  const cwd = '/project/src';
  // 同目录内的文件允许
  assert.equal(isReadPathAllowed('/project/src/file.txt', cwd).allowed, true);
  assert.equal(isReadPathAllowed('/project/src/sub/file.txt', cwd).allowed, true);

  // 外部路径默认阻止
  assert.equal(isReadPathAllowed('/etc/passwd', cwd).allowed, false);
  assert.equal(isReadPathAllowed('/home/user/file.txt', cwd).allowed, false);
  assert.equal(isReadPathAllowed('/tmp/file.txt', cwd).allowed, false);
});

test('isReadPathAllowed allows outside paths when GAUZ_FS_ALLOW_OUTSIDE_READ is set', () => {
  const previous = process.env.GAUZ_FS_ALLOW_OUTSIDE_READ;

  try {
    process.env.GAUZ_FS_ALLOW_OUTSIDE_READ = 'true';

    const cwd = '/project/src';
    assert.equal(isReadPathAllowed('/etc/passwd', cwd).allowed, true);
    assert.equal(isReadPathAllowed('/home/user/file.txt', cwd).allowed, true);
  } finally {
    if (previous === undefined) delete process.env.GAUZ_FS_ALLOW_OUTSIDE_READ;
    else process.env.GAUZ_FS_ALLOW_OUTSIDE_READ = previous;
  }
});

test('isBashCommandAllowed logs warning when bypass is activated', () => {
  // 捕获 console.warn 输出
  const warnCalls: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => warnCalls.push(msg);

  try {
    const result = isBashCommandAllowed('ls -la', {
      env: { GAUZ_BASH_ALLOW_DANGEROUS: 'true' }
    });

    assert.equal(result.allowed, true);
    assert.ok(warnCalls.length > 0, 'Should have logged a warning');
    assert.ok(warnCalls[0].includes('Shell safety checks have been bypassed'),
              'Warning should mention bypass');
    assert.ok(warnCalls[0].includes('GAUZ_BASH_ALLOW_DANGEROUS'),
              'Warning should mention the env var');
  } finally {
    console.warn = originalWarn;
  }
});
