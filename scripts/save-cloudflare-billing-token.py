
"""Save a Billing Read token locally without displaying or overwriting it."""

import getpass
import argparse
import os
from pathlib import Path
import re
import sys
import warnings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--purpose", choices=("billing", "observability"), default="billing")
    args = parser.parse_args()
    label = "Billing Read" if args.purpose == "billing" else "Workers Observability"
    if not sys.stdin.isatty():
        raise SystemExit("일반 터미널에서 직접 실행해주세요. 파이프 입력은 허용하지 않습니다.")

    root = Path(__file__).resolve().parent.parent
    directory = root / "private"
    target = directory / f"cloudflare-{args.purpose}-token.txt"
    if directory.is_symlink():
        raise SystemExit("private 디렉터리의 심볼릭 링크는 허용하지 않습니다.")
    directory.mkdir(mode=0o700, exist_ok=True)
    if not directory.is_dir():
        raise SystemExit("private 경로가 디렉터리가 아닙니다.")
    if os.path.lexists(target):
        raise SystemExit("저장 파일이 이미 존재합니다. 기존 파일을 덮어쓰지 않습니다.")

    # Fail closed if getpass cannot disable terminal echo.
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            token = getpass.getpass(f"{label} 토큰 (화면에 표시되지 않음): ").strip()
        except getpass.GetPassWarning:
            raise SystemExit("숨김 입력을 사용할 수 없습니다. 일반 터미널에서 다시 실행해주세요.")
    if not token or any(character.isspace() for character in token):
        raise SystemExit("토큰이 비어 있거나 공백을 포함합니다. 저장하지 않았습니다.")
    if not re.fullmatch(r"cf(?:ut|at)_[A-Za-z0-9]{40}[0-9a-fA-F]{8}|[A-Za-z0-9_-]{40}", token):
        raise SystemExit("Cloudflare API 토큰 형식이 아닙니다. 명령이나 설명 대신 생성 화면의 토큰 원문만 입력해주세요. 저장하지 않았습니다.")

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(target, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as file:
        os.fchmod(file.fileno(), 0o600)
        file.write(token)
        file.flush()
        os.fsync(file.fileno())
    print(f"저장 완료: private/{target.name} (소유자만 읽기/쓰기)")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        raise SystemExit("입력을 취소했습니다. 토큰은 저장하지 않았습니다.")
    except OSError:
        raise SystemExit("파일 저장에 실패했습니다. 경로와 접근 권한을 확인해주세요.")
