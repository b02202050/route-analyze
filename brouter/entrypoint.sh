#!/bin/sh
set -e

url_of() { echo "${SEGMENTS_URL}/$1.rd5"; }

# 第一次啟動時下載路網分區檔（沒有就無法規劃，必須等下載完成）
for seg in $SEGMENTS; do
  f="/segments/${seg}.rd5"
  if [ ! -s "$f" ]; then
    echo "下載路網資料 ${seg}.rd5 ..."
    # -4：只查 IPv4，避免部分路由器 DNS 同時查詢 A／AAAA 時逾時
    # -R：檔案時間設為伺服器上的更新時間
    curl -4 -fL -R --retry 5 --retry-all-errors --retry-delay 5 -o "${f}.tmp" "$(url_of "$seg")"
    mv "${f}.tmp" "$f"
  fi
done

# 背景更新：啟動 1 分鐘後檢查一次，之後每天檢查。
# 本地檔案超過 SEGMENTS_MAX_AGE_DAYS 天才向伺服器詢問，且只有伺服器有較新版本時才下載（curl -z）。
# 有更新就結束 BRouter，由 Docker（restart: unless-stopped）自動重啟載入新資料，中斷約數秒。
update_loop() {
  set +e
  sleep 60
  while true; do
    now=$(date +%s)
    changed=""
    for seg in $SEGMENTS; do
      f="/segments/${seg}.rd5"
      age_days=$(( (now - $(stat -c %Y "$f")) / 86400 ))
      [ "$age_days" -lt "$SEGMENTS_MAX_AGE_DAYS" ] && continue
      rm -f "${f}.tmp"
      if curl -4 -fsSL -R -z "$f" --retry 3 --retry-all-errors --retry-delay 10 -o "${f}.tmp" "$(url_of "$seg")"; then
        if [ -s "${f}.tmp" ]; then
          changed="$changed $seg"
        else
          # 伺服器沒有較新版本：更新檔案時間，SEGMENTS_MAX_AGE_DAYS 天後再問
          rm -f "${f}.tmp"
          touch "$f"
          echo "路網資料 ${seg}.rd5 已是最新版"
        fi
      else
        rm -f "${f}.tmp"
        echo "路網資料 ${seg}.rd5 檢查更新失敗，繼續使用舊檔，明天再試"
      fi
    done
    if [ -n "$changed" ]; then
      for seg in $changed; do mv "/segments/${seg}.rd5.tmp" "/segments/${seg}.rd5"; done
      echo "路網資料已更新：${changed}，重新啟動 BRouter 載入新資料"
      kill 1
      exit 0
    fi
    sleep 86400
  done
}
update_loop &

echo "啟動 BRouter（port 17777）"
# 注意：customprofiles 必須是「相對於 profiles 目錄」的路徑，
# BRouter 內部以 new File(profileDir, customProfileDir) 組合，給絕對路徑會導致上傳 profile 失敗
exec java $JAVA_OPTS -cp /brouter/brouter.jar btools.server.RouteServer \
  /segments /brouter/profiles customprofiles 17777 "$MAX_THREADS" 0.0.0.0
