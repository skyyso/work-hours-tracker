#!/usr/bin/env bash
set -euo pipefail

# 获取工程根目录（本脚本位于 android/ 目录下）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${SCRIPT_DIR}/app/src/main/assets/www"

echo "==> 准备同步 Web 静态资产到 Android assets: ${TARGET_DIR}"

rm -rf "${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"

# 复制核心前端文件与资源（Web 端纯净不改动，隔离复制）
cp "${ROOT_DIR}/index.html" "${TARGET_DIR}/"
cp "${ROOT_DIR}/sync.js" "${TARGET_DIR}/"
cp "${ROOT_DIR}/manifest.webmanifest" "${TARGET_DIR}/"

cp -r "${ROOT_DIR}/shared" "${TARGET_DIR}/"
cp -r "${ROOT_DIR}/vendor" "${TARGET_DIR}/"
cp -r "${ROOT_DIR}/icons" "${TARGET_DIR}/"

echo "==> Web 静态资源复制完成："
ls -lh "${TARGET_DIR}"
