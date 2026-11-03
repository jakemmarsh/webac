# shellcheck shell=bash
# ensure_aws_cli — put AWS CLI v2 on PATH, installing the official Linux bundle into ~/.local when it
# is missing (a fresh cloud container has none; `aws logs tail` needs v2). Sourced by
# tools/monitor/check.sh, tools/aws-logs.sh and tools/cloud/setup.sh. Returns 1 when no CLI could be
# found or installed (macOS: `brew install awscli`). Needs curl + unzip (installed via apt when root).
ensure_aws_cli() {
  # An earlier install into ~/.local/bin is not on a new shell's PATH.
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) [ -x "$HOME/.local/bin/aws" ] && export PATH="$HOME/.local/bin:$PATH" ;; esac
  command -v aws >/dev/null 2>&1 && return 0
  [ "$(uname -s)" = Linux ] || return 1
  if ! command -v unzip >/dev/null 2>&1 && [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip >/dev/null 2>&1 \
      || { apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip >/dev/null 2>&1; }
  fi
  command -v unzip >/dev/null 2>&1 || return 1
  local arch tmp
  arch="$(uname -m)"; [ "$arch" = arm64 ] && arch=aarch64
  tmp="$(mktemp -d)"
  curl -sSfL --retry 3 "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o "$tmp/awscli.zip" \
    && (cd "$tmp" && unzip -q awscli.zip) \
    && "$tmp/aws/install" --update -i "$HOME/.local/aws-cli" -b "$HOME/.local/bin" >/dev/null
  rm -rf "$tmp"
  [ -x "$HOME/.local/bin/aws" ] && export PATH="$HOME/.local/bin:$PATH"
  command -v aws >/dev/null 2>&1
}
