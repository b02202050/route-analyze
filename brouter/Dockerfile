FROM eclipse-temurin:17-jre

ARG BROUTER_VERSION=1.7.10

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /brouter
RUN curl -fsSL -o /tmp/brouter.zip \
      "https://github.com/abrensch/brouter/releases/download/v${BROUTER_VERSION}/brouter-${BROUTER_VERSION}.zip" \
 && unzip -q /tmp/brouter.zip -d /tmp/b \
 && mv "/tmp/b/brouter-${BROUTER_VERSION}/brouter-${BROUTER_VERSION}-all.jar" /brouter/brouter.jar \
 && mkdir -p /brouter/profiles/customprofiles /segments \
 && cp /tmp/b/brouter-${BROUTER_VERSION}/profiles2/* /brouter/profiles/ \
 && rm -rf /tmp/b /tmp/brouter.zip

COPY profiles/running.brf /brouter/profiles/running.brf
COPY entrypoint.sh /entrypoint.sh
# 避免在 Windows 上 checkout 時被轉成 CRLF
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# E120_N20 + E120_N25 兩個 5°×5° 分區即涵蓋全台灣（含桃園）
ENV SEGMENTS="E120_N20 E120_N25" \
    SEGMENTS_URL="https://brouter.de/brouter/segments4" \
    JAVA_OPTS="-Xmx1g" \
    MAX_THREADS=4

EXPOSE 17777
ENTRYPOINT ["/entrypoint.sh"]
