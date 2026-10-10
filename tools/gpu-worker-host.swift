// gpu-worker-host.swift — the launchd program for the GPU worker, built into
// ~/Applications/ACJS GPU Worker.app by tools/install-gpu-worker.sh.
//
// macOS attributes privacy permissions (Accessibility, Screen Recording) to the
// process launchd started, and every descendant inherits it. retail-ab jobs
// drive the real retail client, so they need both; with /bin/bash as the
// launchd program the grant would cover every bash script. This host is its
// own small signed app: it runs the worker as a CHILD (an exec would hand the
// pid to node and lose the app identity), so the grant covers only it.
//
//   acjs-gpu-worker <repo>            run tools/gpu-worker.sh, exit with its status
//   acjs-gpu-worker <repo> --probe    run the retail driver's `access` check instead
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: acjs-gpu-worker <repo> [--probe]\n".data(using: .utf8)!)
  exit(2)
}
let repo = args[1]
let p = Process()
if args.count > 2 && args[2] == "--probe" {
  let driver = NSHomeDirectory() + "/Library/Caches/acjs/retail-client/retail-drive"
  p.executableURL = URL(fileURLWithPath: driver)
  p.arguments = ["access"]
} else {
  p.executableURL = URL(fileURLWithPath: "/bin/bash")
  p.arguments = [repo + "/tools/gpu-worker.sh"]
}
p.currentDirectoryURL = URL(fileURLWithPath: repo)
do { try p.run() } catch {
  FileHandle.standardError.write("acjs-gpu-worker: \(error)\n".data(using: .utf8)!)
  exit(1)
}
p.waitUntilExit()
exit(p.terminationStatus)
