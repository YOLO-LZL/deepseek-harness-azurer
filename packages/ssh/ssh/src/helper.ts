/**
 * The remote helper script installed into the DSH-managed remote directory.
 * Runs under `bash` with the frame protocol on stdin/stdout; a persistent
 * channel executes one op per frame. All paths/argv/env/file content travel as
 * structured JSON frames (binary as base64) — nothing is concatenated into a
 * command text on the host side.
 *
 * Protocol version is checked on install (filename embeds the version) and on
 * every ping; the host refuses a mismatched helper.
 * @module @deepseek-ai/dsh-ssh/helper
 */

/** Protocol version of the frame/op vocabulary. */
export const SSH_HELPER_PROTOCOL_VERSION = 1

/**
 * Filename stem of the installed helper (version is embedded).
 * @param version - helper protocol version to encode in the filename.
 * @returns the remote helper filename.
 */
export function helperFileName(version = SSH_HELPER_PROTOCOL_VERSION): string {
  return `dsh-ssh-helper.v${version}.sh`
}

/** One line of the protocol banner the helper prints on startup. */
export const HELPER_BANNER = `dsh-ssh-helper ${SSH_HELPER_PROTOCOL_VERSION}`

/**
 * The python dispatcher inlined into the helper's frame loop. Runs one op per
 * frame; every shell command is built with `shlex.quote`, so paths and argv
 * never interpolate. Binary payloads are base64.
 */
const SSH_HELPER_DISPATCHER = `
import json, sys, base64, subprocess, shlex, os

def j(v): return json.dumps(v)

def err(msg, code="remote-io"):
    return json.dumps({"ok": False, "error": {"message": msg, "code": code}})

def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)

def q(s): return shlex.quote(s)

def probe(path):
    r1 = sh("test -L " + q(path))
    if r1.returncode == 0:
        r2 = sh("readlink -- " + q(path))
        return ("symlink", r2.stdout.strip(), 0)
    r2 = sh("stat -c %s " + q(path))
    r3 = sh("test -d " + q(path))
    r4 = sh("test -f " + q(path))
    kind = "directory" if r3.returncode == 0 else ("file" if r4.returncode == 0 else "other")
    size = int(r2.stdout.strip() or "0")
    return (kind, "", size)

req = json.load(sys.stdin)
op = req.get("op")
try:
    if op == "ping":
        out = j({"ok": True, "version": \${SSH_HELPER_PROTOCOL_VERSION}, "banner": \${HELPER_BANNER_JSON}})
    elif op == "realpath":
        cmd = "realpath -m -- " + q(req["path"]) if req.get("lenient") else "realpath -- " + q(req["path"])
        r = sh(cmd)
        out = j({"ok": r.returncode == 0, "path": r.stdout.strip(), "error": r.stderr.strip()})
    elif op == "exists":
        r = sh("test -e " + q(req["path"]) + " || test -L " + q(req["path"]))
        out = j({"ok": True, "exists": r.returncode == 0})
    elif op == "isdir":
        r = sh("test -d " + q(req["path"]))
        out = j({"ok": True, "isDir": r.returncode == 0})
    elif op == "readlink":
        r = sh("readlink -- " + q(req["path"]))
        out = j({"ok": r.returncode == 0, "target": r.stdout.strip(), "error": r.stderr.strip()})
    elif op == "stat":
        path = req["path"]
        follow = req.get("follow", False)
        r0 = sh("test -e " + q(path) + " || test -L " + q(path))
        if r0.returncode != 0:
            out = j({"ok": True, "missing": True})
        else:
            target = path
            if follow:
                r = sh("readlink -f -- " + q(path))
                if r.returncode != 0:
                    out = err(r.stderr.strip())
                else:
                    target = r.stdout.strip()
            kind, link, size = probe(target)
            r = sh("stat -c %a " + q(target))
            mode = int(r.stdout.strip() or "0")
            r = sh("stat -c %Y " + q(target))
            mtime = int(r.stdout.strip() or "0")
            out = j({"ok": True, "type": kind, "size": size, "mode": mode,
                     "mtimeMs": mtime * 1000, "symlinkTarget": link})
    elif op == "list":
        path = req["path"]
        r = sh("test -d " + q(path))
        if r.returncode != 0:
            out = err("list: not a directory: " + path)
        else:
            r = sh("find " + q(path) + " -mindepth 1 -maxdepth 1 -print0")
            entries = []
            for raw in r.stdout.split("\\0"):
                if raw == "":
                    continue
                name = os.path.basename(raw)
                kind, _, size = probe(raw)
                entries.append({"name": name, "type": kind, "size": size})
            out = j({"ok": True, "entries": entries})
    elif op == "read":
        path = req["path"]
        r = sh("test -f " + q(path))
        if r.returncode != 0:
            out = err("read: not a regular file: " + path)
        else:
            with open(path, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
            out = j({"ok": True, "data": data, "size": os.path.getsize(path)})
    elif op == "write":
        path = req["path"]
        data = base64.b64decode(req["data"])
        mode = req.get("mode")
        no_overwrite = req.get("noOverwrite", False)
        d = os.path.dirname(path) or "."
        tmp = os.path.join(d, ".dsh-write.%d.%d" % (os.getpid(), os.getpid()))
        try:
            with open(tmp, "wb") as f:
                f.write(data)
            if mode:
                os.chmod(tmp, int(mode, 8))
            if no_overwrite:
                os.link(tmp, path)
                os.unlink(tmp)
            else:
                os.replace(tmp, path)
            out = j({"ok": True})
        except Exception as e:
            try:
                os.unlink(tmp)
            except Exception:
                pass
            out = err(str(e))
    elif op == "mkdir":
        r = sh("mkdir -p -- " + q(req["path"]))
        out = j({"ok": r.returncode == 0, "error": r.stderr.strip()})
    elif op == "rm":
        r = sh("rm -rf -- " + q(req["path"]))
        out = j({"ok": r.returncode == 0, "error": r.stderr.strip()})
    elif op == "chmod":
        r = sh("chmod " + q(req["mode"]) + " -- " + q(req["path"]))
        out = j({"ok": r.returncode == 0, "error": r.stderr.strip()})
    elif op == "which":
        command = req["command"]
        path = req.get("path")
        cmd = ("PATH=" + q(path) + " command -v -- " + q(command)) if path else ("command -v -- " + q(command))
        r = sh(cmd)
        out = j({"ok": True, "path": r.stdout.strip()})
    elif op == "exec":
        cwd = req["cwd"]
        argv = req["argv"]
        env = req.get("env", [])
        stdin_b64 = req.get("stdin", "")
        stdout_max = int(req.get("stdoutMax", 65536))
        stderr_max = int(req.get("stderrMax", 65536))
        state = req["stateDir"]
        os.makedirs(state, mode=0o700, exist_ok=True)
        stdin_file = os.path.join(state, "stdin")
        if stdin_b64:
            with open(stdin_file, "wb") as f:
                f.write(base64.b64decode(stdin_b64))
        out_file = os.path.join(state, "out")
        err_file = os.path.join(state, "err")
        pgid_file = os.path.join(state, "pgid")
        env_parts = " ".join(q(item) for item in env)
        argv_parts = " ".join(q(item) for item in argv)
        stdin_part = ("< " + q(stdin_file)) if stdin_b64 else "< /dev/null"
        script = ("cd " + q(cwd) + " || exit 127; "
                  + "exec env -i " + env_parts + " -- " + argv_parts + " "
                  + stdin_part + " > " + q(out_file) + " 2> " + q(err_file))
        inner = "printf '%s' \\"$$\\" > " + q(pgid_file) + "; " + script
        r = sh("setsid bash -c " + q(inner))
        with open(pgid_file) as f:
            pgid = f.read().strip()
        out = j({"ok": True, "exitCode": r.returncode, "pgid": pgid,
                 "stdout": b64cap(out_file, stdout_max), "stderr": b64cap(err_file, stderr_max),
                 "stdoutTruncated": os.path.getsize(out_file) > stdout_max,
                 "stderrTruncated": os.path.getsize(err_file) > stderr_max})
    elif op == "kill":
        pgid = req["pgid"]
        signal = req["signal"]
        r = sh("kill -s " + signal + " -- -" + str(pgid))
        out = j({"ok": True, "killed": r.returncode == 0})
    elif op == "alive":
        pgid = req["pgid"]
        r = sh("kill -0 -- -" + str(pgid))
        out = j({"ok": True, "alive": r.returncode == 0})
    elif op == "spawn":
        cwd = req["cwd"]
        argv = req["argv"]
        env = req.get("env", [])
        stdin_b64 = req.get("stdin", "")
        state = req["stateDir"]
        os.makedirs(state, mode=0o700, exist_ok=True)
        stdin_file = os.path.join(state, "stdin")
        pipe = req.get("stdinPipe", False)
        if pipe:
            r = sh("mkfifo " + q(os.path.join(state, "stdin.pipe")))
            if r.returncode != 0:
                out = err(r.stderr.strip())
            else:
                out_file = os.path.join(state, "out")
                err_file = os.path.join(state, "err")
                pgid_file = os.path.join(state, "pgid")
                status_file = os.path.join(state, "status")
                env_parts = " ".join(q(item) for item in env)
                argv_parts = " ".join(q(item) for item in argv)
                inner = ("cd " + q(cwd) + " || exit 127; "
                         + "exec env -i " + env_parts + " -- " + argv_parts
                         + " < " + q(os.path.join(state, "stdin.pipe"))
                         + " > " + q(out_file) + " 2> " + q(err_file))
                full = ("setsid bash -c " + q("( " + inner + " ); printf '%s' \\"$?\\" > " + q(status_file))
                        + " & echo $! > " + q(pgid_file))
                sh(full)
                out = j({"ok": True})
        elif stdin_b64:
            with open(stdin_file, "wb") as f:
                f.write(base64.b64decode(stdin_b64))
            out_file = os.path.join(state, "out")
            err_file = os.path.join(state, "err")
            pgid_file = os.path.join(state, "pgid")
            status_file = os.path.join(state, "status")
            env_parts = " ".join(q(item) for item in env)
            argv_parts = " ".join(q(item) for item in argv)
            inner = ("cd " + q(cwd) + " || exit 127; "
                     + "exec env -i " + env_parts + " -- " + argv_parts
                     + " < " + q(stdin_file) + " > " + q(out_file) + " 2> " + q(err_file))
            full = ("setsid bash -c " + q("( " + inner + " ); printf '%s' \\"$?\\" > " + q(status_file))
                    + " & echo $! > " + q(pgid_file))
            sh(full)
            out = j({"ok": True})
        else:
            out_file = os.path.join(state, "out")
            err_file = os.path.join(state, "err")
            pgid_file = os.path.join(state, "pgid")
            status_file = os.path.join(state, "status")
            env_parts = " ".join(q(item) for item in env)
            argv_parts = " ".join(q(item) for item in argv)
            inner = ("cd " + q(cwd) + " || exit 127; "
                     + "exec env -i " + env_parts + " -- " + argv_parts
                     + " < /dev/null > " + q(out_file) + " 2> " + q(err_file))
            full = ("setsid bash -c " + q("( " + inner + " ); printf '%s' \\"$?\\" > " + q(status_file))
                    + " & echo $! > " + q(pgid_file))
            sh(full)
            out = j({"ok": True})
    elif op == "read-range":
        path = req["path"]
        offset = int(req.get("offset", 0))
        max_bytes = int(req.get("maxBytes", 65536))
        r = sh("test -f " + q(path))
        if r.returncode != 0:
            out = err("read-range: not a regular file: " + path)
        else:
            total = os.path.getsize(path)
            r = sh("dd if=" + q(path) + " bs=1 skip=" + str(offset) + " count=" + str(max_bytes) + " 2>/dev/null | base64 -w0")
            out = j({"ok": True, "data": r.stdout.strip(), "total": total})
    elif op == "stat-file":
        path = req["path"]
        r = sh("test -f " + q(path))
        if r.returncode != 0:
            out = j({"ok": True, "missing": True})
        else:
            out = j({"ok": True, "size": os.path.getsize(path)})
    else:
        out = err("unknown op: " + str(op))
except Exception as e:
    out = err(str(e))
sys.stdout.write(out)
`

/**
 * Assemble the full helper script: the banner echo, the shell frame loop, and
 * the python dispatcher inlined as a heredoc.
 * @returns the exact script bytes the host installs and verifies.
 */
export function renderHelperSource(): string {
  const bannerJson = JSON.stringify(HELPER_BANNER)
  const dispatcher = SSH_HELPER_DISPATCHER
    .replace('${SSH_HELPER_PROTOCOL_VERSION}', String(SSH_HELPER_PROTOCOL_VERSION))
    .replace('${HELPER_BANNER_JSON}', bannerJson)
  const b64capDef = `
def b64cap(path, cap):
    with open(path, "rb") as f:
        data = f.read()
    if len(data) > cap:
        data = data[:cap]
    return base64.b64encode(data).decode("ascii")
`
  const dispatcherWithCap = b64capDef + dispatcher
  return `#!/usr/bin/env bash
# DeepSeek Harness SSH helper — protocol ${SSH_HELPER_PROTOCOL_VERSION}.
# Frame format on stdin: <16 hex chars length>\\n<JSON payload>\\n. Replies use
# the same framing. JSON payloads are ASCII (binary is base64).
set -u

read_frame() {
  local hex="" ch len payload nl
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
    IFS= read -r -N 1 ch || return 1
    hex+="$ch"
  done
  case "$hex" in
    *[!0-9a-f]*) return 1 ;;
  esac
  len=$((16#$hex))
  IFS= read -r -N "$len" payload || return 1
  IFS= read -r -N 1 nl || return 1
  [ "$nl" = "$(printf '\\n')" ] || return 1
  printf '%s' "$payload"
}

write_frame() {
  local payload="$1"
  printf '%016x\\n%s\\n' "\${#payload}" "$payload"
}

# pty mode: write own pid, exec the requested argv
if [ "\${1:-}" = "--pty" ]; then
  pid_file="$2"
  shift 2
  printf '%s' "$$" > "$pid_file"
  exec "$@"
fi

# stdin-fifo mode: forward {data: base64} frames to a fifo; empty data closes it
if [ "\${1:-}" = "--stdin-fifo" ]; then
  fifo="$2"
  while true; do
    frame=$(read_frame) || break
    data=$(printf '%s' "$frame" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("data",""))' 2>/dev/null)
    if [ -z "$data" ]; then
      break
    fi
    printf '%s' "$data" | base64 -d > "$fifo" || break
  done
  exit 0
fi

printf '%s\\n' ${bannerJson}

while true; do
  frame=$(read_frame) || break
  resp=$(printf '%s' "$frame" | python3 - <<'DSH_PY'
${dispatcherWithCap}
DSH_PY
  )
  write_frame "$resp" || break
done
exit 0
`
}
