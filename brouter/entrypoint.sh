#!/bin/sh
set -e

# 第一次啟動時下載路網分區檔（官方每週更新；刪除檔案後重啟即可更新）
for seg in $SEGMENTS; do
  f="/segments/${seg}.rd5"
  if [ ! -s "$f" ]; then
    echo "下載路網資料 ${seg}.rd5 ..."
    # -4：只查 IPv4，避免部分路由器 DNS 同時查詢 A／AAAA 時逾時
    curl -4 -fL --retry 5 --retry-all-errors --retry-delay 5 -o "${f}.tmp" "${SEGMENTS_URL}/${seg}.rd5"
    mv "${f}.tmp" "$f"
  fi
done

echo "啟動 BRouter（port 17777）"
# 注意：customprofiles 必須是「相對於 profiles 目錄」的路徑，
# BRouter 內部以 new File(profileDir, customProfileDir) 組合，給絕對路徑會導致上傳 profile 失敗
exec java $JAVA_OPTS -cp /brouter/brouter.jar btools.server.RouteServer \
  /segments /brouter/profiles customprofiles 17777 "$MAX_THREADS" 0.0.0.0
