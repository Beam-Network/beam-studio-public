#!/bin/sh
set -eu

PUBLISHED_CHANNEL="@BEAM_STUDIO_DEFAULT_CHANNEL@"
PUBLISHED_CDN_BASE_URL="@BEAM_STUDIO_PUBLISHED_CDN_BASE_URL@"
INSTALL_DIR="${BEAM_STUDIO_INSTALL_DIR:-/opt/beam-studio}"
CONFIG_DIR="${BEAM_STUDIO_CONFIG_DIR:-/etc/beam-studio}"
CONFIG_PATH="$CONFIG_DIR/updater.json"
DOCKER_CONFIG_DIR="${BEAM_STUDIO_DOCKER_CONFIG_DIR:-$CONFIG_DIR/docker}"
SERVICE_PATH="/etc/systemd/system/beam-updater.service"
UPDATER_PATH="/usr/local/bin/beam-updater"
TEMPLATE_PATH="/usr/local/share/beam-studio/compose.release.template.yml"
SOCKET_PATH="${BEAM_UPDATER_SOCKET_PATH:-/run/beam-studio/updater.sock}"
SOCKET_GROUP="${BEAM_UPDATER_SOCKET_GROUP:-beam-studio}"
PUBLIC_KEY_PATH="$CONFIG_DIR/release-key.pem"
PUBLIC_KEY_BASE64="${BEAM_STUDIO_RELEASE_PUBLIC_KEY_BASE64:-@BEAM_STUDIO_RELEASE_PUBLIC_KEY_BASE64@}"
PUBLIC_URL="${BEAM_STUDIO_PUBLIC_URL:-http://localhost:3004}"

log() {
  printf '%s\n' "beam-studio installer: $*"
}

fail() {
  printf '%s\n' "beam-studio installer: error: $*" >&2
  exit 1
}

# The hostname portion of BEAM_STUDIO_PUBLIC_URL, empty for an IP literal.
public_url_hostname() {
  printf '%s' "$PUBLIC_URL" |
    sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#[:/].*$##' |
    grep -Ev '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || true
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' was not found"
}

print_banner() {
  printf '%s\n' \
    ' ____  _____    _    __  __' \
    '| __ )| ____|  / \  |  \/  |' \
    '|  _ \|  _|   / _ \ | |\/| |' \
    '| |_) | |___ / ___ \| |  | |' \
    '|____/|_____/_/   \_\_|  |_|' \
    '         B E A M   S T U D I O' \
    ''
}

render_channel_menu() {
  if [ "$menu_rendered" = true ]; then
    printf '\033[2A' >&2
  fi
  if [ "$selected" -eq 1 ]; then marker='>'; else marker=' '; fi
  printf '\r\033[2K  %s stable - production releases\n' "$marker" >&2
  if [ "$selected" -eq 2 ]; then marker='>'; else marker=' '; fi
  printf '\r\033[2K  %s dev    - latest development release\n' "$marker" >&2
  menu_rendered=true
}

channel_stty() {
  stty_attempt=0
  while [ "$stty_attempt" -lt 3 ]; do
    if stty "$@" </dev/tty 2>/dev/null; then
      return 0
    fi
    stty_attempt=$((stty_attempt + 1))
  done
  return 1
}

terminal_is_foreground() {
  [ -r "/proc/$$/stat" ] || return 1
  process_stat="$(sed 's/^.*) //' "/proc/$$/stat")" || return 1
  # Fields after the command name: state ppid pgrp session tty_nr tpgid.
  # shellcheck disable=SC2086
  set -- $process_stat
  [ "$#" -ge 6 ] && [ "$3" -gt 0 ] && [ "$3" = "$6" ]
}

claim_terminal_foreground() {
  terminal_is_foreground && return 0
  command -v stty >/dev/null 2>&1 || return 1
  tty_probe_state="$(stty -g </dev/tty 2>/dev/null)" || return 1
  # sudo-rs runs `curl ... | sudo sh` in a background process group of its pty,
  # where terminal reads and writes stop the whole group. It then hands over
  # the terminal but resumes only this shell, leaving the stopped child hung.
  # Trigger that handoff with a no-op probe and resume the probe from here.
  stty "$tty_probe_state" </dev/tty >/dev/null 2>&1 &
  tty_probe_pid=$!
  tty_probe_attempt=0
  while kill -0 "$tty_probe_pid" 2>/dev/null; do
    kill -CONT "$tty_probe_pid" 2>/dev/null || :
    tty_probe_attempt=$((tty_probe_attempt + 1))
    if [ "$tty_probe_attempt" -ge 250000 ]; then
      kill -KILL "$tty_probe_pid" 2>/dev/null || :
      break
    fi
  done
  wait "$tty_probe_pid" 2>/dev/null || :
  terminal_is_foreground
}

fallback_channel_menu() {
  channel_stty "$tty_state" || fail "cannot restore the interactive terminal; set BEAM_STUDIO_CHANNEL explicitly"
  trap - EXIT HUP INT TERM
  printf '%s\n' 'Arrow-key menu unavailable; use the numbered prompt.' >&2
  choose_channel_by_number
}

choose_channel_with_arrows() {
  require_command stty
  require_command dd
  tty_state="$(channel_stty -g)" || {
    printf '%s\n' 'Arrow-key menu unavailable; use the numbered prompt.' >&2
    choose_channel_by_number
    return
  }
  trap 'channel_stty "$tty_state" || :' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if ! channel_stty -echo -icanon min 1 time 0; then
    fallback_channel_menu
    return
  fi

  case "$DEFAULT_CHANNEL" in
    stable) selected=1 ;;
    dev) selected=2 ;;
  esac
  menu_rendered=false
  printf '%s\n' 'Choose an update channel (↑/↓, then Enter):' >&2
  render_channel_menu
  while :; do
    key="$(dd bs=1 count=1 </dev/tty 2>/dev/null)" || {
      fallback_channel_menu
      return
    }
    case "$key" in
      '') break ;;
      1 | 2) selected="$key"; render_channel_menu ;;
      q | Q) fail "installation cancelled" ;;
      "$(printf '\033')")
        if ! channel_stty min 0 time 2; then
          fallback_channel_menu
          return
        fi
        second="$(dd bs=1 count=1 </dev/tty 2>/dev/null)" || {
          fallback_channel_menu
          return
        }
        third="$(dd bs=1 count=1 </dev/tty 2>/dev/null)" || {
          fallback_channel_menu
          return
        }
        if ! channel_stty min 1 time 0; then
          fallback_channel_menu
          return
        fi
        case "$second$third" in
          '[A' | 'OA') selected=$((selected - 1)); [ "$selected" -ge 1 ] || selected=2 ;;
          '[B' | 'OB') selected=$((selected + 1)); [ "$selected" -le 2 ] || selected=1 ;;
          *) continue ;;
        esac
        render_channel_menu
        ;;
    esac
  done
  channel_stty "$tty_state" || fail "cannot restore the interactive terminal"
  trap - EXIT HUP INT TERM
  case "$selected" in
    1) CHANNEL=stable ;;
    2) CHANNEL=dev ;;
  esac
}

choose_channel_by_number() {
  printf '%s\n' \
    'Choose an update channel:' \
    '  1) stable' \
    '  2) dev' >&2
  while :; do
    printf 'Channel [default: %s]: ' "$DEFAULT_CHANNEL" >&2
    if ! IFS= read -r channel_choice </dev/tty; then
      fail "cannot read channel selection; set BEAM_STUDIO_CHANNEL explicitly"
    fi
    case "$channel_choice" in
      '') CHANNEL="$DEFAULT_CHANNEL"; break ;;
      1 | stable) CHANNEL=stable; break ;;
      2 | dev) CHANNEL=dev; break ;;
      *) printf '%s\n' 'Choose 1, 2, or a channel name.' >&2 ;;
    esac
  done
}

# The channel recorded by a previous installation, empty on a fresh host.
installed_channel() {
  [ -r "$CONFIG_PATH" ] || return 0
  sed -n 's/^[[:space:]]*"channel":[[:space:]]*"\([a-z]*\)".*$/\1/p' "$CONFIG_PATH" | head -n 1
}

# The stable (production) installer never shows a menu; the dev installer offers
# stable and dev. A rerun defaults to the installed channel so that it is never
# switched silently; BEAM_STUDIO_CHANNEL is the explicit way to change it.
choose_channel() {
  INSTALLED_CHANNEL="$(installed_channel)"
  case "$INSTALLED_CHANNEL" in
    stable | dev)
      DEFAULT_CHANNEL="$INSTALLED_CHANNEL"
      log "found an existing installation on the $INSTALLED_CHANNEL channel"
      ;;
    '') ;;
    *) log "ignoring unsupported installed channel: $INSTALLED_CHANNEL" ;;
  esac
  if [ -n "${BEAM_STUDIO_CHANNEL:-}" ]; then
    CHANNEL="$BEAM_STUDIO_CHANNEL"
  elif [ "$PUBLISHED_CHANNEL" = stable ]; then
    CHANNEL="$DEFAULT_CHANNEL"
  elif [ -t 2 ] && (: </dev/tty) 2>/dev/null && claim_terminal_foreground; then
    if [ "${TERM:-dumb}" != dumb ] &&
      command -v stty >/dev/null 2>&1 && command -v dd >/dev/null 2>&1; then
      choose_channel_with_arrows
    else
      choose_channel_by_number
    fi
  else
    CHANNEL="$DEFAULT_CHANNEL"
    log "no interactive terminal; using $CHANNEL (set BEAM_STUDIO_CHANNEL to override)"
  fi
  case "$CHANNEL" in
    stable) DEFAULT_CDN_BASE_URL="https://cdn.b1m.ai/studio" ;;
    dev)
      [ "$PUBLISHED_CHANNEL" = dev ] || [ -n "${BEAM_STUDIO_CDN_BASE_URL:-}" ] ||
        fail "the dev channel is served by the development installer; set BEAM_STUDIO_CDN_BASE_URL to use it from this one"
      DEFAULT_CDN_BASE_URL="$PUBLISHED_CDN_BASE_URL"
      ;;
    nightly) fail "the nightly channel is not published yet; use stable or dev" ;;
    *) fail "unsupported release channel: $CHANNEL" ;;
  esac
  if [ -n "$INSTALLED_CHANNEL" ] && [ "$INSTALLED_CHANNEL" != "$CHANNEL" ]; then
    log "switching the update channel from $INSTALLED_CHANNEL to $CHANNEL"
  fi
  CDN_BASE_URL="${BEAM_STUDIO_CDN_BASE_URL:-$DEFAULT_CDN_BASE_URL}"
  CDN_BASE_URL="${CDN_BASE_URL%/}"
  CONTROL_PLANE_URL="${BEAM_STUDIO_CONTROL_PLANE_URL:-$CDN_BASE_URL/latest.json}"
  log "selected update channel: $CHANNEL"
}

install_missing_packages() {
  missing_packages=""
  for package in curl jq openssl; do
    if ! command -v "$package" >/dev/null 2>&1; then
      missing_packages="$missing_packages $package"
    fi
  done
  [ -n "$missing_packages" ] || return 0
  log "installing required packages:$missing_packages"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    # Package names are intentionally fixed above; word splitting is required here.
    # shellcheck disable=SC2086
    DEBIAN_FRONTEND=noninteractive apt-get install -y $missing_packages
  elif command -v dnf >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    dnf install -y $missing_packages
  elif command -v yum >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    yum install -y $missing_packages
  elif command -v zypper >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    zypper --non-interactive install $missing_packages
  else
    fail "install$missing_packages with your package manager, then rerun the installer"
  fi
  for package in curl jq openssl; do
    require_command "$package"
  done
}

install_docker_engine() {
  log "installing Docker Engine and Docker Compose"
  docker_script="$(mktemp)"
  if curl --fail --silent --show-error --location https://get.docker.com \
    --output "$docker_script" && sh "$docker_script"; then
    rm -f "$docker_script"
    return 0
  fi
  rm -f "$docker_script"
  command -v apt-get >/dev/null 2>&1 || return 1
  log "Docker's install script failed; falling back to distribution packages"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq &&
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2
}

install_docker_compose() {
  log "installing Docker Compose"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq || return 1
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin ||
      DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y docker-compose-plugin
  elif command -v yum >/dev/null 2>&1; then
    yum install -y docker-compose-plugin
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install docker-compose
  else
    return 1
  fi
}

start_docker_daemon() {
  docker info >/dev/null 2>&1 && return 0
  log "starting the Docker daemon"
  systemctl enable --now docker.service >/dev/null 2>&1 || :
  docker_attempt=0
  until docker info >/dev/null 2>&1; do
    docker_attempt=$((docker_attempt + 1))
    [ "$docker_attempt" -lt 30 ] || return 1
    sleep 1
  done
}

ensure_docker() {
  docker_help="install Docker Engine with Compose v2 (https://docs.docker.com/engine/install/), then rerun the installer"
  if ! command -v docker >/dev/null 2>&1; then
    install_docker_engine || fail "could not install Docker; $docker_help"
    command -v docker >/dev/null 2>&1 || fail "Docker is still unavailable; $docker_help"
  fi
  if ! docker compose version >/dev/null 2>&1; then
    install_docker_compose || :
    docker compose version >/dev/null 2>&1 ||
      fail "Docker Compose v2 is required (the 'docker compose' command is unavailable); $docker_help"
  fi
  start_docker_daemon ||
    fail "the Docker daemon is not running; check 'systemctl status docker.service'"
}

pull_updater_image() {
  log "pulling the Beam Studio updater package"
  if [ ! -t 1 ] || [ "${TERM:-dumb}" = dumb ]; then
    docker --config "$DOCKER_CONFIG_DIR" pull --quiet "$UPDATER_IMAGE" >/dev/null
    return
  fi
  docker --config "$DOCKER_CONFIG_DIR" pull --quiet "$UPDATER_IMAGE" \
    >"$TEMP_DIR/updater-pull.log" 2>&1 &
  pull_pid=$!
  frame=0
  while kill -0 "$pull_pid" 2>/dev/null; do
    case $((frame % 4)) in
      0) spinner='|' ;;
      1) spinner='/' ;;
      2) spinner='-' ;;
      3) spinner='+' ;;
    esac
    printf '\r\033[2K  %s updater image' "$spinner"
    frame=$((frame + 1))
    sleep 0.2
  done
  printf '\r\033[2K'
  if wait "$pull_pid"; then
    printf '%s\n' '  [OK] updater image'
  else
    printf '%s\n' '  [FAILED] updater image' >&2
    cat "$TEMP_DIR/updater-pull.log" >&2
    fail "could not pull the updater image"
  fi
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

random_hex() {
  bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# Whether an env file defines KEY, with or without a value.
env_file_has() {
  grep -Eq "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$2"
}

# The value of KEY in an env file (last definition wins, as in Compose),
# without surrounding quotes.
env_file_value() {
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$2" |
    tail -n 1 |
    sed -E "s/[[:space:]]+$//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"
}

# Every setting the installer writes besides the two data-bound secrets, one
# KEY=value per line, for the current PUBLIC_URL. A fresh install writes all of
# them; a rerun appends whichever an existing .env lacks, so a key added here
# reaches hosts installed by an earlier release. A new secret that no existing
# data depends on may be generated here too: it is only used when missing.
install_env_defaults() {
  # The room consumer's bootstrap secret. Unlike the database password and the
  # vault key, no stored data depends on it, so a rerun may add it to a host
  # installed before it existed; the existing value always wins. Assigned
  # first so that a failed generation fails the caller's substitution.
  consumer_shared_secret="$(random_hex 32)"
  [ -n "$consumer_shared_secret" ] || return 1
  case "$PUBLIC_URL" in
    https://*) secure_cookies=true ;;
    *) secure_cookies=false ;;
  esac
  printf '%s\n' "BEAM_STUDIO_PUBLIC_URL=$PUBLIC_URL"
  printf '%s\n' "BEAM_STUDIO_SECURE_COOKIES=$secure_cookies"
  printf '%s\n' "STUDIO_PORT=${BEAM_STUDIO_PORT:-3004}"
  printf '%s\n' "STUDIO_BIND_ADDRESS=${BEAM_STUDIO_BIND_ADDRESS:-0.0.0.0}"
  printf '%s\n' "API_BIND_ADDRESS=127.0.0.1"
  # The hostname of the declared public URL, so a rebound name cannot drive
  # this install from a page the operator happens to visit. An IP-literal URL
  # yields an empty list, which is fine: an IP Host cannot be rebound.
  printf '%s\n' "BEAM_STUDIO_ALLOWED_HOSTS=$(public_url_hostname)"
  printf '%s\n' "BEAM_UPDATER_SOCKET_PATH=$SOCKET_PATH"
  # The api container mounts this directory rather than the socket file, so
  # it starts even when the updater has not created the socket yet (a host
  # reboot); see docs/self-update.md, "Host reboot".
  printf '%s\n' "BEAM_UPDATER_SOCKET_DIR=$(dirname "$SOCKET_PATH")"
  printf '%s\n' "BEAM_STUDIO_SHARED_SECRET=$consumer_shared_secret"
}

# Writes $INSTALL_DIR/.env on a fresh host. On a rerun the existing file is
# authoritative: no value is changed, secrets included, and only the settings
# an older installer did not write are appended. Without that, a host first
# installed by an earlier release never receives a setting added later, such
# as BEAM_STUDIO_ALLOWED_HOSTS.
write_install_env() {
  env_path="$INSTALL_DIR/.env"
  if [ ! -f "$env_path" ]; then
    # Assigned first so that a failed generation stops the installer (set -e)
    # instead of writing an empty secret.
    postgres_password="$(random_hex 24)"
    studio_secret_key="$(random_hex 32)"
    defaults="$(install_env_defaults)"
    (
      umask 0077
      {
        printf '%s\n' "POSTGRES_PASSWORD=$postgres_password"
        printf '%s\n' "BEAM_STUDIO_SECRET_KEY=$studio_secret_key"
        printf '%s\n' "$defaults"
      } >"$env_path"
    )
    chmod 0600 "$env_path"
    return 0
  fi

  # A new secret would not open the existing database or vault, so a missing
  # one is reported instead of generated.
  for secret in POSTGRES_PASSWORD BEAM_STUDIO_SECRET_KEY; do
    if [ -z "$(env_file_value "$secret" "$env_path")" ]; then
      fail "$env_path has no $secret; restore it from a backup before rerunning the installer (a new value would not match the existing data)"
    fi
  done

  # Derived settings follow the URL this host was installed with, not the
  # default of this run.
  if env_file_has BEAM_STUDIO_PUBLIC_URL "$env_path"; then
    PUBLIC_URL="$(env_file_value BEAM_STUDIO_PUBLIC_URL "$env_path")"
  fi

  missing_env=""
  added_keys=""
  defaults="$(install_env_defaults)"
  while IFS= read -r line; do
    key="${line%%=*}"
    env_file_has "$key" "$env_path" && continue
    missing_env="$missing_env$line
"
    added_keys="$added_keys $key"
  done <<EOF
$defaults
EOF

  if [ -z "$missing_env" ]; then
    log "preserving existing $env_path"
    return 0
  fi
  # Never glue the first new line onto an unterminated last line.
  if [ -n "$(tail -c 1 "$env_path")" ]; then
    missing_env="
$missing_env"
  fi
  printf '%s' "$missing_env" >>"$env_path"
  log "preserving existing $env_path; added missing settings:$added_keys"
}

# The claim code of this installation on stdout, or nothing once it is
# claimed. It is asked of the running api container through the updater, so it
# is the product's own derivation over the key the claim route checks, not a
# copy of it in shell.
read_claim_code() {
  "$UPDATER_PATH" claim-code --config "$CONFIG_PATH" --unclaimed-only 2>/dev/null
}

stdout_is_terminal() {
  [ -t 1 ]
}

# Tells the operator how to claim a Studio nobody owns yet. The code is a
# credential: it goes to the operator's terminal and nowhere else. When stdout
# is not a terminal (cloud-init, CI, a redirect) it would land in a log, so
# only the command that prints it is shown.
print_claim_instructions() {
  claim_url="${PUBLIC_URL%/}/settings/access"
  if ! claim_code="$(read_claim_code)"; then
    log "claim this Studio once in $claim_url; print its claim code with: sudo beam-updater claim-code"
    return 0
  fi
  # Already claimed: there is nothing left to do with the code.
  [ -n "$claim_code" ] || return 0
  if ! stdout_is_terminal; then
    log "this Studio is not claimed yet; open $claim_url, sign in, and enter the claim code printed by: sudo beam-updater claim-code (it is not shown here because this output is not a terminal)"
    return 0
  fi
  printf '\n%s\n' "Claim code: $claim_code"
  printf '%s\n' \
    "  Needed once: open $claim_url, sign in, and enter it to claim this Studio." \
    '  Print it again with: sudo beam-updater claim-code' \
    ''
}

# Tests source this file to exercise the functions above without installing.
if [ "${BEAM_STUDIO_INSTALLER_SOURCE_ONLY:-}" = 1 ]; then
  # shellcheck disable=SC2317 # reached only when executed rather than sourced
  return 0 2>/dev/null || exit 0
fi

require_command uname
OPERATING_SYSTEM="$(uname -s)"
if [ "$OPERATING_SYSTEM" != Linux ]; then
  fail "unsupported operating system: $OPERATING_SYSTEM; install Beam Studio on a Linux host with systemd"
fi

if [ "$(id -u)" -ne 0 ]; then
  fail "run this installer as root (for example: curl ... | sudo -E sh)"
fi

print_banner
# nightly is paused: an installer published for it falls back to the dev menu.
case "$PUBLISHED_CHANNEL" in
  dev | nightly) DEFAULT_CHANNEL=dev ;;
  *) PUBLISHED_CHANNEL=stable; DEFAULT_CHANNEL=stable ;;
esac
choose_channel
install_missing_packages

require_command base64
require_command curl
require_command dirname
require_command install
require_command jq
require_command mktemp
require_command openssl
require_command sed
require_command systemctl

ensure_docker

# Workers mount the host machine ID as the stable identity of their process guard.
if [ ! -s /etc/machine-id ]; then
  if command -v systemd-machine-id-setup >/dev/null 2>&1; then
    systemd-machine-id-setup >/dev/null 2>&1 || :
  fi
  [ -s /etc/machine-id ] ||
    fail "/etc/machine-id is missing; run systemd-machine-id-setup, then rerun the installer"
fi

if command -v getent >/dev/null 2>&1; then
  if ! getent group "$SOCKET_GROUP" >/dev/null 2>&1; then
    require_command groupadd
    groupadd --system "$SOCKET_GROUP"
  fi
else
  require_command groupadd
  groupadd --system --force "$SOCKET_GROUP"
fi

TEMP_DIR="$(mktemp -d)"
UPDATER_CONTAINER=""
cleanup() {
  if [ -n "$UPDATER_CONTAINER" ]; then
    docker --config "$DOCKER_CONFIG_DIR" rm -f "$UPDATER_CONTAINER" >/dev/null 2>&1 || true
  fi
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

install -d -m 0750 "$INSTALL_DIR" "$INSTALL_DIR/releases" "$INSTALL_DIR/backups"
install -d -m 0750 "$CONFIG_DIR"
install -d -m 0700 "$DOCKER_CONFIG_DIR"
install -d -m 0755 "$(dirname "$TEMPLATE_PATH")"
install -d -m 0770 "$(dirname "$SOCKET_PATH")"

if [ -n "${BEAM_STUDIO_PUBLIC_KEY_FILE:-}" ]; then
  [ -f "$BEAM_STUDIO_PUBLIC_KEY_FILE" ] ||
    fail "BEAM_STUDIO_PUBLIC_KEY_FILE does not exist"
  install -m 0644 "$BEAM_STUDIO_PUBLIC_KEY_FILE" "$TEMP_DIR/release-key.pem"
else
  [ -n "$PUBLIC_KEY_BASE64" ] || fail "installer does not contain a release public key"
  printf '%s' "$PUBLIC_KEY_BASE64" | base64 -d >"$TEMP_DIR/release-key.pem"
fi

if [ -n "${BEAM_STUDIO_REGISTRY_TOKEN:-}" ]; then
  [ -n "${BEAM_STUDIO_REGISTRY_USERNAME:-}" ] ||
    fail "BEAM_STUDIO_REGISTRY_USERNAME is required with BEAM_STUDIO_REGISTRY_TOKEN"
  log "authenticating to private registry packages"
  printf '%s' "$BEAM_STUDIO_REGISTRY_TOKEN" |
    docker --config "$DOCKER_CONFIG_DIR" login ghcr.io \
      --username "$BEAM_STUDIO_REGISTRY_USERNAME" --password-stdin >/dev/null
fi

log "downloading signed release control plane"
if ! curl --fail --silent --show-error --location \
  --header 'Cache-Control: no-cache' \
  "$CONTROL_PLANE_URL" \
  --output "$TEMP_DIR/latest.json"; then
  fail "release metadata for $CHANNEL is unavailable at $CONTROL_PLANE_URL"
fi

jq -er '.signature | select(type == "string" and test("^[A-Za-z0-9+/]+={0,2}$"))' \
  "$TEMP_DIR/latest.json" >"$TEMP_DIR/signature.base64" ||
  fail "latest.json does not contain a valid signature encoding"
base64 -d "$TEMP_DIR/signature.base64" >"$TEMP_DIR/signature.bin" ||
  fail "latest.json signature is not valid base64"
jq -cSj 'del(.signature)' "$TEMP_DIR/latest.json" >"$TEMP_DIR/signed-payload.json"
openssl pkeyutl -verify -pubin -rawin \
  -inkey "$TEMP_DIR/release-key.pem" \
  -in "$TEMP_DIR/signed-payload.json" \
  -sigfile "$TEMP_DIR/signature.bin" >/dev/null 2>&1 ||
  fail "latest.json signature verification failed"

UPDATER_IMAGE="$(jq -er --arg channel "$CHANNEL" '
  select(.schemaVersion == 1)
  | .channels[$channel].updater
  | select(
      type == "string"
      and test("^ghcr\\.io/beam-network/beam-studio-[a-z0-9._/-]+@sha256:[a-f0-9]{64}$")
    )
' "$TEMP_DIR/latest.json")" ||
  fail "latest.json does not contain a valid updater image for channel $CHANNEL"

pull_updater_image
UPDATER_CONTAINER="$(docker --config "$DOCKER_CONFIG_DIR" create "$UPDATER_IMAGE")"
docker --config "$DOCKER_CONFIG_DIR" cp \
  "$UPDATER_CONTAINER:/beam-updater" "$TEMP_DIR/beam-updater"
docker --config "$DOCKER_CONFIG_DIR" cp \
  "$UPDATER_CONTAINER:/compose.release.template.yml" "$TEMP_DIR/compose.release.template.yml"
docker --config "$DOCKER_CONFIG_DIR" rm "$UPDATER_CONTAINER" >/dev/null
UPDATER_CONTAINER=""
install -m 0755 "$TEMP_DIR/beam-updater" "$UPDATER_PATH.new"
mv "$UPDATER_PATH.new" "$UPDATER_PATH"
install -m 0644 "$TEMP_DIR/compose.release.template.yml" "$TEMPLATE_PATH.new"
mv "$TEMPLATE_PATH.new" "$TEMPLATE_PATH"

install -m 0644 "$TEMP_DIR/release-key.pem" "$PUBLIC_KEY_PATH"

write_install_env

ESCAPED_INSTALL_DIR="$(json_escape "$INSTALL_DIR")"
ESCAPED_CONTROL_PLANE_URL="$(json_escape "$CONTROL_PLANE_URL")"
ESCAPED_PUBLIC_KEY_PATH="$(json_escape "$PUBLIC_KEY_PATH")"
ESCAPED_TEMPLATE_PATH="$(json_escape "$TEMPLATE_PATH")"
ESCAPED_SOCKET_PATH="$(json_escape "$SOCKET_PATH")"
ESCAPED_SOCKET_GROUP="$(json_escape "$SOCKET_GROUP")"
ESCAPED_CHANNEL="$(json_escape "$CHANNEL")"
ESCAPED_DOCKER_CONFIG_DIR="$(json_escape "$DOCKER_CONFIG_DIR")"

umask 0027
{
  printf '%s\n' "{"
  printf '%s\n' "  \"instanceDir\": \"$ESCAPED_INSTALL_DIR\","
  printf '%s\n' "  \"composeProject\": \"beam-studio\","
  printf '%s\n' "  \"controlPlaneUrl\": \"$ESCAPED_CONTROL_PLANE_URL\","
  printf '%s\n' "  \"publicKeyPath\": \"$ESCAPED_PUBLIC_KEY_PATH\","
  printf '%s\n' "  \"composeTemplatePath\": \"$ESCAPED_TEMPLATE_PATH\","
  printf '%s\n' "  \"channel\": \"$ESCAPED_CHANNEL\","
  printf '%s\n' "  \"socketPath\": \"$ESCAPED_SOCKET_PATH\","
  printf '%s\n' "  \"socketGroup\": \"$ESCAPED_SOCKET_GROUP\","
  printf '%s\n' "  \"envFile\": \"$ESCAPED_INSTALL_DIR/.env\","
  printf '%s\n' "  \"dockerBinary\": \"docker\","
  printf '%s\n' "  \"backupEnabled\": true,"
  printf '%s\n' "  \"backupRetention\": 5,"
  printf '%s\n' "  \"updateTimeoutSeconds\": 900,"
  printf '%s\n' "  \"healthTimeoutSeconds\": 180"
  printf '%s\n' "}"
} >"$CONFIG_PATH"
chmod 0640 "$CONFIG_PATH"

cat >"$SERVICE_PATH" <<UNIT
[Unit]
Description=Beam Studio host updater
Documentation=https://github.com/Beam-Network/beam-studio-public
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=simple
User=root
Group=root
Environment=DOCKER_CONFIG=$ESCAPED_DOCKER_CONFIG_DIR
ExecStart=/usr/local/bin/beam-updater serve --config /etc/beam-studio/updater.json
Restart=on-failure
RestartSec=5s
TimeoutStopSec=31min
RuntimeDirectory=beam-studio
RuntimeDirectoryMode=0770
RuntimeDirectoryPreserve=yes
UMask=0007
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths="$INSTALL_DIR" "$(dirname "$SOCKET_PATH")"
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$SERVICE_PATH"

log "starting the host updater"
systemctl daemon-reload
systemctl enable beam-updater.service >/dev/null
systemctl restart beam-updater.service

attempt=0
while [ ! -S "$SOCKET_PATH" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    systemctl status beam-updater.service --no-pager >&2 || true
    fail "the updater socket was not created"
  fi
  sleep 1
done

log "installing the latest signed $CHANNEL release"
"$UPDATER_PATH" apply --config "$CONFIG_PATH" --wait

log "Beam Studio is installed"
log "Studio URL: $PUBLIC_URL"
log "Configuration: $INSTALL_DIR/.env"
print_claim_instructions
printf '%s\n' 'Thank you for choosing Beam Studio!'
