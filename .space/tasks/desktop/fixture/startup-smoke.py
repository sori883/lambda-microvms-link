import json
import os
from pathlib import Path
import subprocess
import time

evidence = Path(__file__).resolve().parents[1] / "evidence" / "startup-fix"
context = json.loads((evidence / "final-context.json").read_text())
directory = Path(context["directory"])
common = [context["binary"], "--state-dir", context["stateDirectory"]]
viewers = []
for name in context["sessions"]:
    created = subprocess.run(
        common + [
            "--profile", context["profile"], "--region", context["region"], "--json",
            "session", "create", name, "--image", "lambda-microvms-link-dev",
            "--image-version", context["imageVersion"], "--duration", "900",
        ],
        cwd=directory, check=True, capture_output=True, text=True, timeout=130,
    )
    (evidence / f"{name}-create.json").write_text(created.stdout)
    url = directory / f"{name}-url.txt"
    errors = directory / f"{name}-stderr.txt"
    started = time.time()
    with os.fdopen(os.open(url, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600), "w") as out:
        with os.fdopen(os.open(errors, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600), "w") as err:
            child = subprocess.Popen(
                common + ["session", "desktop", name, "--no-open"],
                cwd=directory, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True,
            )
    item = {"session": name, "pid": child.pid, "startedAt": started}
    (directory / f"{name}-viewer.json").write_text(json.dumps(item))
    viewers.append((child, item, url, errors))

results = []
for child, item, url, errors in viewers:
    while not url.stat().st_size and child.poll() is None and time.time() - item["startedAt"] < 130:
        time.sleep(0.2)
    result = {
        "session": item["session"], "imageVersion": context["imageVersion"],
        "firstAttempt": True, "ready": url.stat().st_size > 0,
        "secondsToReady": round(url.stat().st_mtime - item["startedAt"], 3) if url.stat().st_size else None,
        "exitCode": child.poll(), "stderr": errors.read_text(),
    }
    results.append(result)
(evidence / "fresh-starts.json").write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps(results))
assert all(result["ready"] and result["exitCode"] is None for result in results)
