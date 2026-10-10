// retail-drive-mac.swift — drive the real retail client window on macOS
// (tools/launch-retail-client-mac.sh, tools/capture-retail-ab.ts).
// Built on demand: swiftc -O tools/retail-drive-mac.swift -o <cache>/retail-drive
//
//   retail-drive win                 → "pid x y w h" of the client window (on- or off-screen), exit 1 if none
//   retail-drive front               → activate the client; exit 0 once it is frontmost, 3 if it never is
//   retail-drive click X Y           → left click at a point inside the window
//   retail-drive key CODE...         → press keys named by KeyboardEvent.code (F12, KeyR, Backslash, Shift+KeyA)
//   retail-drive type TEXT           → Return (opens chat), TEXT, Return
//   retail-drive idle                → seconds since the last HID input (any source)
//   retail-drive seq JSON            → timed key holds: [[ms, "down"|"up", CODE], ...] from the
//                                      moment it starts (prints {"start": epoch ms} first). Exit 3
//                                      if the client loses focus, 4 if someone else touches the
//                                      machine mid-sequence (held keys are released only while
//                                      the client is still frontmost). tools/retail-movement-ab.ts
//   retail-drive access              → exit 0 when this process may send input (Accessibility),
//                                      capture the screen (Screen Recording) and raise the client
//                                      (Automation → System Events), else 5 + which is missing
//
// Input commands refuse (exit 3) unless the client process is frontmost: a
// keypress that lands in another app is a keypress into the user's work
// (2026-10-02: an F12 meant for the client toggled DevTools in Chrome).
// Wine reads the virtual key code, not the event's unicode string, and setting
// only the Shift flag latches Shift, so keys are US-layout codes with real
// Shift down/up events.
import AppKit
import CoreGraphics
import Foundation
import IOKit

let title = "Asheron's Call"
let src = CGEventSource(stateID: .hidSystemState)

func window() -> (pid: pid_t, x: Int, y: Int, w: Int, h: Int)? {
  let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
  // Prefer the on-screen window; Wine keeps hidden helper windows with the same title.
  let mine = list.filter { ($0[kCGWindowName as String] as? String) == title }
  let pick = mine.first { ($0[kCGWindowIsOnscreen as String] as? Bool) == true }
    ?? mine.max { a, b in
      let wa = (a[kCGWindowBounds as String] as? [String: Any])?["Width"] as? Int ?? 0
      let wb = (b[kCGWindowBounds as String] as? [String: Any])?["Width"] as? Int ?? 0
      return wa < wb
    }
  guard let w = pick, let b = w[kCGWindowBounds as String] as? [String: Any] else { return nil }
  return (pid_t(w[kCGWindowOwnerPID as String] as? Int ?? 0), b["X"] as? Int ?? 0, b["Y"] as? Int ?? 0,
          b["Width"] as? Int ?? 0, b["Height"] as? Int ?? 0)
}

func isFront(_ pid: pid_t) -> Bool { NSWorkspace.shared.frontmostApplication?.processIdentifier == pid }

func requireFront() -> pid_t {
  guard let w = window() else { FileHandle.standardError.write("retail-drive: no client window\n".data(using: .utf8)!); exit(1) }
  guard isFront(w.pid) else { FileHandle.standardError.write("retail-drive: client is not frontmost; refusing input\n".data(using: .utf8)!); exit(3) }
  return w.pid
}

let codes: [String: CGKeyCode] = [
  "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9,
  "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17, "Digit1": 18, "Digit2": 19,
  "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24, "Digit9": 25, "Digit7": 26, "Minus": 27,
  "Digit8": 28, "Digit0": 29, "BracketRight": 30, "KeyO": 31, "KeyU": 32, "BracketLeft": 33, "KeyI": 34, "KeyP": 35,
  "Enter": 36, "KeyL": 37, "KeyJ": 38, "Quote": 39, "KeyK": 40, "Semicolon": 41, "Backslash": 42, "Comma": 43,
  "Slash": 44, "KeyN": 45, "KeyM": 46, "Period": 47, "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51,
  "Escape": 53, "F5": 96, "F6": 97, "F7": 98, "F3": 99, "F8": 100, "F9": 101, "F11": 103, "F10": 109, "F12": 111,
  "F4": 118, "F2": 120, "F1": 122, "ShiftLeft": 56, "AltLeft": 58, "Home": 115, "PageUp": 116, "Delete": 117, "End": 119, "PageDown": 121,
  "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
]
let shiftKey: CGKeyCode = 56
let altKey: CGKeyCode = 58

func post(_ k: CGKeyCode, _ down: Bool, _ flags: CGEventFlags = []) {
  let e = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: down)
  e?.flags = flags
  e?.post(tap: .cghidEventTap)
  usleep(30000)
}

func press(_ k: CGKeyCode, shift: Bool) {
  if shift { post(shiftKey, true, .maskShift); post(k, true, .maskShift); post(k, false, .maskShift); post(shiftKey, false) }
  else { post(k, true); post(k, false) }
}

/** "Shift+KeyA" → (code, shift). */
func parseKey(_ s: String) -> (CGKeyCode, Bool)? {
  let shift = s.hasPrefix("Shift+")
  let name = shift ? String(s.dropFirst(6)) : s
  guard let k = codes[name] else { return nil }
  return (k, shift)
}

let charKeys: [Character: String] = [
  " ": "Space", ".": "Period", ",": "Comma", "-": "Minus", "=": "Equal", "/": "Slash", ";": "Semicolon",
  "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "`": "Backquote",
]
let shiftedChars: [Character: String] = [
  "@": "Digit2", "_": "Minus", "+": "Equal", ":": "Semicolon", "!": "Digit1", "#": "Digit3", "$": "Digit4",
  "%": "Digit5", "^": "Digit6", "&": "Digit7", "*": "Digit8", "(": "Digit9", ")": "Digit0", "?": "Slash",
  "\"": "Quote", "{": "BracketLeft", "}": "BracketRight", "|": "Backslash", "~": "Backquote", "<": "Comma", ">": "Period",
]

func keyFor(_ ch: Character) -> (CGKeyCode, Bool)? {
  if let n = shiftedChars[ch] { return codes[n].map { ($0, true) } }
  if let n = charKeys[ch] { return codes[n].map { ($0, false) } }
  if ch.isLetter, let ascii = ch.asciiValue {
    let upper = ch.isUppercase
    return codes["Key" + String(Character(UnicodeScalar(ascii)).uppercased())].map { ($0, upper) }
  }
  if ch.isNumber, let n = codes["Digit" + String(ch)] { return (n, false) }
  return nil
}

func hidIdleSeconds() -> Double {
  let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
  defer { IOObjectRelease(service) }
  guard let prop = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?
    .takeRetainedValue() as? NSNumber else { return 0 }
  return prop.doubleValue / 1e9
}

/**
 * Automation permission to send Apple Events to System Events. Checks only, unless
 * ACJS_ASK_AUTOMATION is set (install-gpu-worker.sh --probe-retail, attended): then
 * macOS shows its consent dialog and this waits for the answer.
 */
func automationStatus() -> OSStatus {
  let bundle = "com.apple.systemevents"
  if NSRunningApplication.runningApplications(withBundleIdentifier: bundle).isEmpty,
     let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) {
    let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = false
    let done = DispatchSemaphore(value: 0)
    NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, _ in done.signal() }
    _ = done.wait(timeout: .now() + 5)
  }
  let target = NSAppleEventDescriptor(bundleIdentifier: bundle)
  return AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard,
                                           ProcessInfo.processInfo.environment["ACJS_ASK_AUTOMATION"] == "1")
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "win":
  guard let w = window() else { exit(1) }
  print(w.pid, w.x, w.y, w.w, w.h)
case "front":
  guard let w = window() else { exit(1) }
  // System Events, not NSRunningApplication.activate: macOS 14+ cooperative
  // activation ignores one app's request to front another.
  let script = NSAppleScript(source: "tell application \"System Events\" to set frontmost of (first process whose unix id is \(w.pid)) to true")
  for _ in 0..<20 {
    var err: NSDictionary?
    script?.executeAndReturnError(&err)
    usleep(250000)
    if isFront(w.pid), let now = window(), now.w > 0 { exit(0) }
  }
  exit(3)
case "click":
  _ = requireFront()
  guard args.count == 3, let x = Double(args[1]), let y = Double(args[2]) else { exit(2) }
  let p = CGPoint(x: x, y: y)
  for (t, d) in [(CGEventType.mouseMoved, 150000), (.leftMouseDown, 80000), (.leftMouseUp, 0)] {
    CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(useconds_t(d))
  }
case "key":
  _ = requireFront()
  post(shiftKey, true, .maskShift); post(shiftKey, false)   // clear a latched Shift
  for name in args.dropFirst() {
    guard let (k, shift) = parseKey(name) else { FileHandle.standardError.write("retail-drive: unknown key \(name)\n".data(using: .utf8)!); exit(2) }
    press(k, shift: shift)
    usleep(250000)
  }
case "type":
  _ = requireFront()
  guard args.count == 2 else { exit(2) }
  post(shiftKey, true, .maskShift); post(shiftKey, false)
  press(36, shift: false); usleep(500000)
  for ch in args[1] {
    guard let (k, shift) = keyFor(ch) else { FileHandle.standardError.write("retail-drive: no key for \(ch)\n".data(using: .utf8)!); exit(2) }
    press(k, shift: shift)
  }
  press(36, shift: false)
case "idle":
  print(String(format: "%.1f", hidIdleSeconds()))
case "seq":
  let pid = requireFront()
  guard args.count == 2, let data = args[1].data(using: .utf8),
        let evs = try? JSONSerialization.jsonObject(with: data) as? [[Any]] else { exit(2) }
  var held = Set<CGKeyCode>()
  var lastOwn = Date()
  func flags() -> CGEventFlags {
    var f: CGEventFlags = []
    if held.contains(shiftKey) { f.insert(.maskShift) }
    if held.contains(altKey) { f.insert(.maskAlternate) }
    return f
  }
  func send(_ k: CGKeyCode, _ down: Bool) {
    if down { held.insert(k) } else { held.remove(k) }
    let e = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: down)
    e?.flags = flags()
    e?.post(tap: .cghidEventTap)
    lastOwn = Date()
  }
  func bail(_ code: Int32, _ why: String) -> Never {
    if isFront(pid) { for k in held where k != shiftKey { send(k, false) }; if held.contains(shiftKey) { send(shiftKey, false) } }
    FileHandle.standardError.write("retail-drive seq: \(why)\n".data(using: .utf8)!)
    exit(code)
  }
  func guardOk() {
    if !isFront(pid) { bail(3, "client lost focus") }
    // HIDIdleTime counts our own events: input newer than our last post is someone else's.
    if hidIdleSeconds() + 0.5 < Date().timeIntervalSince(lastOwn) { bail(4, "machine used during the sequence") }
  }
  send(shiftKey, true); send(shiftKey, false)   // clear a latched Shift
  let start = Date()
  print("{\"start\": \(Int64(start.timeIntervalSince1970 * 1000))}"); fflush(stdout)
  for ev in evs {
    guard ev.count == 3, let ms = (ev[0] as? NSNumber)?.doubleValue, let dir = ev[1] as? String,
          let name = ev[2] as? String, let k = codes[name] else { bail(2, "bad event \(ev)") }
    while true {
      let left = ms / 1000 - Date().timeIntervalSince(start)
      if left <= 0 { break }
      usleep(useconds_t(min(left, 0.1) * 1e6))
      guardOk()
    }
    guardOk()
    send(k, dir == "down")
  }
  for k in held { send(k, false) }
case "access":
  // TCC grants belong to the app that launched us (iTerm2 for a terminal,
  // the launchd job's program for the GPU worker), not to this binary.
  var missing: [String] = []
  if !AXIsProcessTrusted() { missing.append("Accessibility") }
  if !CGPreflightScreenCaptureAccess() { missing.append("Screen Recording") }
  // `front` raises the client through System Events, which needs Automation.
  // Unasked, macOS shows a consent dialog on the first `front`; under launchd
  // nobody answers it, the client never comes forward, and the run dies as
  // "not frontmost" (2026-10-04). Jobs check without prompting.
  let ae = automationStatus()
  if ae != noErr { missing.append("Automation → System Events (\(ae == -1743 ? "denied" : ae == -1744 ? "not yet asked" : "OSStatus \(ae)"))") }
  if !missing.isEmpty { print("missing: " + missing.joined(separator: ", ")); exit(5) }
  print("ok")
default:
  FileHandle.standardError.write("usage: retail-drive win|front|click X Y|key CODE...|type TEXT|idle|access\n".data(using: .utf8)!)
  exit(2)
}
