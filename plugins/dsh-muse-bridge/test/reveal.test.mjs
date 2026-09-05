import assert from 'node:assert/strict';
import test from 'node:test';
import { revealPathInFinder } from '../lib/index.js';

test('revealPathInFinder rejects non-string or empty paths', async () => {
  const r1 = await revealPathInFinder('');
  assert.equal(r1.ok, false);
  assert.equal(r1.error?.code, 'bad-request');

  const r2 = await revealPathInFinder('   ');
  assert.equal(r2.ok, false);
  assert.equal(r2.error?.code, 'bad-request');

  const r3 = await revealPathInFinder(null);
  assert.equal(r3.ok, false);
  assert.equal(r3.error?.code, 'bad-request');
});

test('revealPathInFinder reveals existing file on macOS with open -R', async () => {
  let executedCmd = null;
  let executedArgs = null;

  const mockExec = (cmd, args, cb) => {
    executedCmd = cmd;
    executedArgs = args;
    cb(null);
  };

  const res = await revealPathInFinder('/mock/dir/file.py', {
    platform: 'darwin',
    exec: mockExec,
    fsExists: (p) => p === '/mock/dir/file.py',
    fsStat: () => ({ isDirectory: () => false }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.value?.isDir, false);
  assert.equal(executedCmd, 'open');
  assert.deepEqual(executedArgs, ['-R', '/mock/dir/file.py']);
});

test('revealPathInFinder reveals directory on macOS with open <dir>', async () => {
  let executedCmd = null;
  let executedArgs = null;

  const mockExec = (cmd, args, cb) => {
    executedCmd = cmd;
    executedArgs = args;
    cb(null);
  };

  const res = await revealPathInFinder('/mock/dir', {
    platform: 'darwin',
    exec: mockExec,
    fsExists: (p) => p === '/mock/dir',
    fsStat: () => ({ isDirectory: () => true }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.value?.isDir, true);
  assert.equal(executedCmd, 'open');
  assert.deepEqual(executedArgs, ['/mock/dir']);
});

test('revealPathInFinder falls back to closest ancestor directory if target does not exist', async () => {
  let executedCmd = null;
  let executedArgs = null;

  const mockExec = (cmd, args, cb) => {
    executedCmd = cmd;
    executedArgs = args;
    cb(null);
  };

  const res = await revealPathInFinder('/mock/dir/sub/nonexistent.py', {
    platform: 'darwin',
    exec: mockExec,
    fsExists: (p) => p === '/mock/dir',
    fsStat: () => ({ isDirectory: () => true }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.value?.isDir, true);
  assert.equal(res.value?.target, '/mock/dir');
  assert.equal(executedCmd, 'open');
  assert.deepEqual(executedArgs, ['/mock/dir']);
});

test('revealPathInFinder supports win32 explorer.exe', async () => {
  let executedCmd = null;
  let executedArgs = null;

  const mockExec = (cmd, args, cb) => {
    executedCmd = cmd;
    executedArgs = args;
    cb(null);
  };

  const res = await revealPathInFinder('C:\\mock\\file.txt', {
    platform: 'win32',
    exec: mockExec,
    fsExists: () => true,
    fsStat: () => ({ isDirectory: () => false }),
  });

  assert.equal(res.ok, true);
  assert.equal(executedCmd, 'explorer.exe');
  assert.deepEqual(executedArgs, ['/select,C:\\mock\\file.txt']);
});

test('revealPathInFinder expands ~ using home directory', async () => {
  let capturedTarget = null;
  const mockExec = (_cmd, _args, cb) => cb(null);

  const res = await revealPathInFinder('~/projects/app.js', {
    platform: 'darwin',
    exec: mockExec,
    home: '/Users/testuser',
    fsExists: (p) => {
      capturedTarget = p;
      return true;
    },
    fsStat: () => ({ isDirectory: () => false }),
  });

  assert.equal(res.ok, true);
  assert.equal(capturedTarget, '/Users/testuser/projects/app.js');
});
