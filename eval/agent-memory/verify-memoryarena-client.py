#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--memoryarena-repo", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    repo = Path(args.memoryarena_repo).resolve()
    memory_dir = repo / "memory"
    if not (memory_dir / "client.py").is_file():
        raise SystemExit(f"MemoryArena client.py not found under {memory_dir}")
    sys.path.insert(0, str(memory_dir))
    from client import MemoryClient  # pylint: disable=import-error,import-outside-toplevel

    started = time.time()
    left_user = f"context-window-left-{uuid.uuid4()}"
    right_user = f"context-window-right-{uuid.uuid4()}"
    left = MemoryClient(
        user_id=left_user,
        memory_system_name="context-window",
        base_url=args.base_url,
        timeout=30,
    )
    right = MemoryClient(
        user_id=right_user,
        memory_system_name="context-window",
        base_url=args.base_url,
        timeout=30,
    )
    left_add = left.add("Bob lives in Boston and his favorite color is teal.")
    right_add = right.add("Alice lives in Santa Clara and her favorite color is black.")
    left_prompt = left.wrap_user_prompt("Where does Bob live?")
    right_prompt = right.wrap_user_prompt("Where does Alice live?")

    assert left_add["status"] == "ok"
    assert right_add["status"] == "ok"
    assert "<memory_context>" in left_prompt and "</memory_context>" in left_prompt
    assert "Boston" in left_prompt and "Santa Clara" not in left_prompt
    assert "Santa Clara" in right_prompt and "Boston" not in right_prompt

    commit = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True
    ).strip()
    artifact = {
        "format": "context-window.memoryarena-http-verification.v1",
        "memoryArenaCommit": commit,
        "memoryClientPath": str(memory_dir / "client.py"),
        "baseUrl": args.base_url,
        "memorySystemName": "context-window",
        "passed": True,
        "durationMs": round((time.time() - started) * 1000),
        "checks": {
            "initialize": True,
            "add": True,
            "wrapUserPrompt": True,
            "boundedMemoryContext": True,
            "userIsolation": True,
        },
        "leftPrompt": left_prompt,
        "rightPrompt": right_prompt,
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output),
        "passed": True,
        "durationMs": artifact["durationMs"],
        "memoryArenaCommit": commit,
    }, indent=2))


if __name__ == "__main__":
    main()
