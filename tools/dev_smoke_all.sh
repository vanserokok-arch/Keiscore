#!/usr/bin/env bash

set -u -o pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROBTEST_DIR="/Users/evgenijtazelnikov/Documents/KeisHP/probtest"
OUT_ROOT="/tmp/keiscore-roi"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
SUMMARY_FILE="$OUT_ROOT/smoke-all-$TIMESTAMP-summary.tsv"

mkdir -p "$OUT_ROOT"
cd "$ROOT_DIR" || exit 1

echo "Building project..."
if ! npm run build; then
  echo "Build failed"
  exit 1
fi

echo -e "label\tfile\tpage\texit_code\tregistration\tfield_not_confirmed\tdebug_dir" > "$SUMMARY_FILE"

run_smoke_case() {
  local label="$1"
  local file_path="$2"
  local page_from="$3"
  local page_to="$4"
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  local debug_dir="$OUT_ROOT/$label/$ts"
  mkdir -p "$debug_dir"

  local cmd=(node smoke.mjs "$file_path")
  if [[ "$page_from" != "-" && "$page_to" != "-" ]]; then
    cmd+=("--from=$page_from" "--to=$page_to")
  fi

  KEISCORE_DEBUG_ROI_DIR="$debug_dir" "${cmd[@]}" > "$debug_dir/run.log" 2>&1
  local exit_code=$?

  local registration_line
  registration_line="$(rg -o '"registration":\s*(null|".*")' "$debug_dir/run.log" -S | tail -n 1 || true)"
  if [[ -z "$registration_line" ]]; then
    registration_line="\"registration\": null"
  fi
  local registration_value
  registration_value="${registration_line#\"registration\": }"

  local fnc_hits
  fnc_hits="$(rg -c 'FIELD_NOT_CONFIRMED' "$debug_dir/run.log" -S || true)"
  if [[ -z "$fnc_hits" ]]; then
    fnc_hits="0"
  fi

  local page_value="-"
  if [[ "$page_from" != "-" ]]; then
    page_value="$page_from"
  fi

  echo -e "$label\t$file_path\t$page_value\t$exit_code\t$registration_value\t$fnc_hits\t$debug_dir" >> "$SUMMARY_FILE"
  echo "Done: $label page=$page_value exit=$exit_code registration=$registration_value debug=$debug_dir"
}

echo "Running fixtures..."
run_smoke_case "fixtures_case1_passport" "$ROOT_DIR/fixtures/case1/pdf/passport.pdf" "-" "-"
run_smoke_case "fixtures_case1_registration" "$ROOT_DIR/fixtures/case1/pdf/registration.pdf" "-" "-"
run_smoke_case "fixtures_case2_passport" "$ROOT_DIR/fixtures/case2/pdf/passport.pdf" "-" "-"
run_smoke_case "fixtures_case2_registration" "$ROOT_DIR/fixtures/case2/pdf/registration.pdf" "-" "-"

echo "Running probtest PDFs..."
for pdf in "$PROBTEST_DIR"/*test.pdf; do
  [[ -f "$pdf" ]] || continue
  base_name="$(basename "$pdf" .pdf)"
  pages="$(pdfinfo "$pdf" | awk '/^Pages:/ {print $2}' | tr -d '[:space:]')"
  if [[ -z "$pages" || ! "$pages" =~ ^[0-9]+$ ]]; then
    pages=1
  fi
  page=0
  while [[ "$page" -lt "$pages" ]]; do
    run_smoke_case "probtest_${base_name}_p${page}" "$pdf" "$page" "$page"
    page=$((page + 1))
  done
done

echo
echo "Summary: $SUMMARY_FILE"
cat "$SUMMARY_FILE"
