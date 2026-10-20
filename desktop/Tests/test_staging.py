import json
import pathlib
import tempfile
import unittest

from desktop.staging import refresh_staged_bundle


def add_runtime(bundle, version, marker):
    package = bundle / 'Contents/Resources/app/node_modules/@deepseek-ai/dsh'
    package.mkdir(parents=True)
    (package / 'package.json').write_text(json.dumps({'version': version}))
    (bundle / 'Contents/MacOS').mkdir(parents=True, exist_ok=True)
    (bundle / 'Contents/MacOS/DeepSeek Harness').write_text(marker)


class StagingTests(unittest.TestCase):
    def test_replaces_staged_bundle_when_dsh_runtime_version_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source = root / 'Applications/DeepSeek Harness.app'
            target = root / 'build/DeepSeek Harness.app'
            add_runtime(source, '0.2.1-alpha.3', 'new Electron')
            add_runtime(target, '0.2.1-alpha.1', 'old Electron')
            (target / 'Contents/MacOS/deepseek-harness').write_text('old launcher')

            refreshed = refresh_staged_bundle(source, target)

            package = target / 'Contents/Resources/app/node_modules/@deepseek-ai/dsh/package.json'
            self.assertTrue(refreshed)
            self.assertEqual(json.loads(package.read_text())['version'], '0.2.1-alpha.3')
            self.assertEqual((target / 'Contents/MacOS/DeepSeek Harness').read_text(),
                             'new Electron')
            self.assertFalse((target / 'Contents/MacOS/deepseek-harness').exists())


if __name__ == '__main__':
    unittest.main()
