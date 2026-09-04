"""Back up the existing app and replace only its launcher and bundle metadata."""
import datetime
import hashlib
import json
import pathlib
import shutil
import subprocess

root = pathlib.Path(__file__).resolve().parent
installed = pathlib.Path('/Applications/DeepSeek Harness.app')
staged = root / 'build/DeepSeek Harness.app'
stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
backup = pathlib.Path.home() / '.dsh/backups' / f'mac-app-auth-{stamp}'
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(staged)], check=True)
backup.mkdir(parents=True, exist_ok=False)
saved = backup / installed.name
shutil.copytree(installed, saved, symlinks=True)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

parts = ['Contents/MacOS/deepseek-harness', 'Contents/Info.plist']
record = {
    'installed': str(installed), 'backup': str(saved),
    'original_launcher_sha256': digest(saved / parts[0]),
    'replacement_launcher_sha256': digest(staged / parts[0]),
}
(backup / 'recovery.json').write_text(json.dumps(record, indent=2) + '\n')
try:
    # Keep the application directory itself in place so existing Dock items
    # continue to resolve it. Do not replace bundled Node or user runtime/data.
    for part in parts:
        shutil.copy2(staged / part, installed / part)
    subprocess.run(['codesign', '--force', '--options', 'runtime', '--sign', '-', str(installed)], check=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(installed)], check=True)
except BaseException:
    shutil.copytree(saved, installed, symlinks=True, dirs_exist_ok=True)
    raise
(root / 'build/last-backup.txt').write_text(str(saved) + '\n')
print(f'Installed: {installed}')
print(f'Original app backup: {saved}')
