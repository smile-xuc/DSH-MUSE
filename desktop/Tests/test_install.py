import hashlib
import json
import pathlib
import plistlib
import tempfile
import unittest

from desktop.install import install_app


def make_bundle(bundle, executable, executable_bytes, *, electron_name=None):
    macos = bundle / 'Contents/MacOS'
    macos.mkdir(parents=True)
    (macos / executable).write_bytes(executable_bytes)
    info = {'CFBundleExecutable': executable}
    if electron_name:
        info['DSHElectronExecutable'] = electron_name
        (macos / electron_name).write_bytes(b'embedded Electron runtime')
    (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.installed = self.root / 'Applications/DeepSeek Harness.app'
        self.staged = self.root / 'build/DeepSeek Harness.app'
        self.backup = self.root / 'backups/backup-1'
        self.last_backup_file = self.root / 'build/last-backup.txt'
        make_bundle(self.staged, 'deepseek-harness', b'new native launcher',
                    electron_name='DeepSeek Harness')

    def tearDown(self):
        self.temp.cleanup()

    def run_install(self):
        commands = []
        install_app(self.installed, self.staged, self.backup,
                    self.last_backup_file,
                    run=lambda command, check: commands.append(command))
        return commands

    def test_installs_over_fresh_electron_bundle_and_records_its_executable(self):
        old_executable = b'original Electron executable'
        make_bundle(self.installed, 'DeepSeek Harness', old_executable)

        commands = self.run_install()

        record = json.loads((self.backup / 'recovery.json').read_text())
        self.assertEqual(record['original_launcher_path'],
                         'Contents/MacOS/DeepSeek Harness')
        self.assertEqual(record['original_launcher_sha256'],
                         hashlib.sha256(old_executable).hexdigest())
        self.assertEqual((self.installed / 'Contents/MacOS/deepseek-harness').read_bytes(),
                         b'new native launcher')
        self.assertEqual((self.installed / 'Contents/MacOS/DeepSeek Harness').read_bytes(),
                         old_executable)
        self.assertEqual(plistlib.loads((self.installed / 'Contents/Info.plist').read_bytes())[
            'CFBundleExecutable'], 'deepseek-harness')
        self.assertEqual(self.last_backup_file.read_text(),
                         str(self.backup / self.installed.name) + '\n')
        self.assertEqual(commands[-3:], [
            ['codesign', '--force', '--sign', '-',
             str(self.installed / 'Contents/MacOS/DeepSeek Harness')],
            ['codesign', '--force', '--options', 'runtime', '--sign', '-', str(self.installed)],
            ['codesign', '--verify', '--deep', '--strict', str(self.installed)],
        ])

    def test_installs_over_existing_swift_launcher_bundle(self):
        old_launcher = b'old Swift launcher'
        make_bundle(self.installed, 'deepseek-harness', old_launcher)

        commands = self.run_install()

        record = json.loads((self.backup / 'recovery.json').read_text())
        self.assertEqual(record['original_launcher_path'],
                         'Contents/MacOS/deepseek-harness')
        self.assertEqual(record['original_launcher_sha256'],
                         hashlib.sha256(old_launcher).hexdigest())
        self.assertEqual((self.installed / 'Contents/MacOS/deepseek-harness').read_bytes(),
                         b'new native launcher')
        self.assertEqual(len(commands), 3)
        self.assertNotIn('deepseek-harness', commands[1][-1])
        self.assertIn('--verify', commands[-1])

    def test_rolls_back_replacement_and_electron_signature_on_signing_failure(self):
        original_info = {'CFBundleExecutable': 'DeepSeek Harness'}
        make_bundle(self.installed, 'DeepSeek Harness', b'original Electron executable')
        electron_path = self.installed / 'Contents/MacOS/DeepSeek Harness'
        signature_dir = self.installed / 'Contents/_CodeSignature'
        signature_dir.mkdir()
        (signature_dir / 'CodeResources').write_text('original signature')

        def fail_outer_sign(command, check):
            if command[-1] == str(electron_path):
                electron_path.write_bytes(b're-signed Electron')
            elif command[-1] == str(self.installed):
                (signature_dir / 'CodeResources').write_text('failed replacement signature')
                raise RuntimeError('outer signing failed')

        with self.assertRaisesRegex(RuntimeError, 'outer signing failed'):
            install_app(self.installed, self.staged, self.backup,
                        self.last_backup_file, run=fail_outer_sign)

        self.assertEqual(electron_path.read_bytes(), b'original Electron executable')
        self.assertEqual((signature_dir / 'CodeResources').read_text(), 'original signature')
        self.assertFalse((self.installed / 'Contents/MacOS/deepseek-harness').exists())
        self.assertEqual(plistlib.loads((self.installed / 'Contents/Info.plist').read_bytes()),
                         original_info)


if __name__ == '__main__':
    unittest.main()
