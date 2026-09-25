# ---- 第一階段：下載並解壓 BRouter（unzip 等工具只存在這一層）----
# 只保留 jar 與 lookups.dat；路跑 profile 由 API server 上傳，其他內建 profile 用不到
FROM alpine:3.20 AS fetch
ARG BROUTER_VERSION=1.7.10
RUN apk add --no-cache curl unzip \
 && curl -fsSL -o /tmp/brouter.zip \
      "https://github.com/abrensch/brouter/releases/download/v${BROUTER_VERSION}/brouter-${BROUTER_VERSION}.zip" \
 && unzip -q /tmp/brouter.zip -d /tmp/b \
 && mkdir -p /out/profiles/customprofiles \
 && mv "/tmp/b/brouter-${BROUTER_VERSION}/brouter-${BROUTER_VERSION}-all.jar" /out/brouter.jar \
 && cp "/tmp/b/brouter-${BROUTER_VERSION}/profiles2/lookups.dat" /out/profiles/

# ---- 第二階段：精簡的 Java 21 執行環境（Alpine，支援 ARM64／樹莓派）----
# BRouter 以 Java 11 編譯，只用到 java.base 的基本 API，可在 Java 21 執行
FROM eclipse-temurin:21-jre-alpine
# curl 用於第一次啟動時下載路網資料
RUN apk add --no-cache curl
WORKDIR /brouter
COPY --from=fetch /out/ /brouter/
COPY profiles/running.brf /brouter/profiles/running.brf
COPY entrypoint.sh /entrypoint.sh
# 避免在 Windows 上 checkout 時被轉成 CRLF
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh && mkdir -p /segments

# E120_N20 + E120_N25 兩個 5°×5° 分區即涵蓋全台灣（含桃園）
# SerialGC：單人使用時記憶體負擔最小，適合樹莓派等小型主機
ENV SEGMENTS="E120_N20 E120_N25" \
    SEGMENTS_URL="https://brouter.de/brouter/segments4" \
    JAVA_OPTS="-Xmx768m -XX:+UseSerialGC" \
    MAX_THREADS=4

EXPOSE 17777
ENTRYPOINT ["/entrypoint.sh"]
