"""Keep the staged app in sync with the installed DSH runtime package."""
import json
import pathlib
import shutil


def dsh_runtime_version(bundle):
    package = pathlib.Path(bundle) / (
        'Contents/Resources/app/node_modules/@deepseek-ai/dsh/package.json')
    if not package.is_file():
        return None
    return json.loads(package.read_text()).get('version')


def refresh_staged_bundle(source, target):
    source = pathlib.Path(source)
    target = pathlib.Path(target)
    if target.exists() and dsh_runtime_version(source) != dsh_runtime_version(target):
        shutil.rmtree(target)
    if not target.exists():
        shutil.copytree(source, target, symlinks=True)
        return True
    return False
