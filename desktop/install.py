"""Back up the existing app and replace only its launcher and bundle metadata."""
import datetime
import hashlib
import json
import pathlib
import plistlib
import shutil
import subprocess


def bundle_executable_path(bundle):
    bundle = pathlib.Path(bundle)
    info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
    executable = info.get('CFBundleExecutable')
    if not isinstance(executable, str) or not executable or pathlib.Path(executable).name != executable:
        raise ValueError(f'Invalid CFBundleExecutable in {bundle}: {executable!r}')
    return bundle / 'Contents/MacOS' / executable


def digest(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def _restore_path(saved, installed, relative_path):
    source = saved / relative_path
    target = installed / relative_path
    if target.is_dir() and not target.is_symlink():
        shutil.rmtree(target)
    elif target.exists() or target.is_symlink():
        target.unlink()
    if source.is_dir() and not source.is_symlink():
        shutil.copytree(source, target, symlinks=True)
    elif source.exists() or source.is_symlink():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target, follow_symlinks=False)


def install_app(installed, staged, backup, last_backup_file, run=subprocess.run):
    installed = pathlib.Path(installed)
    staged = pathlib.Path(staged)
    backup = pathlib.Path(backup)
    last_backup_file = pathlib.Path(last_backup_file)

    run(['codesign', '--verify', '--deep', '--strict', str(staged)], check=True)
    backup.mkdir(parents=True, exist_ok=False)
    saved = backup / installed.name
    shutil.copytree(installed, saved, symlinks=True)

    launcher_rel = pathlib.Path('Contents/MacOS/deepseek-harness')
    info_rel = pathlib.Path('Contents/Info.plist')
    signature_rel = pathlib.Path('Contents/_CodeSignature')
    electron_name = plistlib.loads((staged / info_rel).read_bytes()).get('DSHElectronExecutable')
    electron_rel = pathlib.Path('Contents/MacOS') / electron_name if electron_name else None
    original_launcher = bundle_executable_path(saved)
    recovery_parts = [launcher_rel, info_rel, signature_rel]
    if electron_rel and (saved / electron_rel).is_file():
        recovery_parts.append(electron_rel)

    record = {
        'installed': str(installed),
        'backup': str(saved),
        'original_launcher_path': str(original_launcher.relative_to(saved)),
        'original_launcher_sha256': digest(original_launcher),
        'replacement_launcher_sha256': digest(staged / launcher_rel),
    }
    (backup / 'recovery.json').write_text(json.dumps(record, indent=2) + '\n')

    try:
        # Keep the application directory itself in place so existing Dock items
        # continue to resolve it. Do not replace bundled Node or user runtime/data.
        for part in (launcher_rel, info_rel):
            shutil.copy2(staged / part, installed / part)
        installed_info = plistlib.loads((installed / info_rel).read_bytes())
        embedded_electron = installed / 'Contents/MacOS' / installed_info.get(
            'DSHElectronExecutable', '')
        if embedded_electron.is_file():
            run(['codesign', '--force', '--sign', '-', str(embedded_electron)], check=True)
        run(['codesign', '--force', '--options', 'runtime', '--sign', '-', str(installed)],
            check=True)
        run(['codesign', '--verify', '--deep', '--strict', str(installed)], check=True)
    except BaseException:
        for part in recovery_parts:
            _restore_path(saved, installed, part)
        raise

    last_backup_file.parent.mkdir(parents=True, exist_ok=True)
    last_backup_file.write_text(str(saved) + '\n')
    print(f'Installed: {installed}')
    print(f'Original app backup: {saved}')


def main():
    root = pathlib.Path(__file__).resolve().parent
    installed = pathlib.Path('/Applications/DeepSeek Harness.app')
    staged = root / 'build/DeepSeek Harness.app'
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = pathlib.Path.home() / '.dsh/backups' / f'mac-app-auth-{stamp}'
    install_app(installed, staged, backup, root / 'build/last-backup.txt')


if __name__ == '__main__':
    main()
