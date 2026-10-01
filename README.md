# 🏃 路跑路線規劃（桃園 / 台灣）

設定起點、終點與經過點，一次產生 **1～10 條（預設 3 條）彼此分散的路跑路線**。每次按「重新產生」都用新的隨機種子，產生不一樣的路線。

- 起點、終點、經過點：點地圖、搜尋地名、使用目前位置都可以設定；標記可拖曳，經過點可調整順序
- 環狀路線（跑回起點）
- 路線長度：**指定公里數**（誤差目標 ±3%）或 **最短路徑**
- **總爬升**：不限，或自訂大約的公尺數。會盡量接近目標，但不保證剛好；受當地地形限制達不到時會顯示警告
- **盡量避開紅綠燈**：路線引擎對每個號誌路口加上成本，實測同一段路的號誌數約減半
- 路型偏好：人行道／步道、腳踏車道、小徑／土路、一般馬路，各自可設 **偏好／不限／避開**
- **努力程度**滑桿（1 最快～5 最仔細）：越往右嘗試越多候選路線，距離、爬升與偏好越容易符合，但需要較久時間（見下方「努力程度」）
- 每條路線顯示：地圖路線、總水平距離、總爬升、總下降、高度剖面圖（滑鼠移上去，地圖會標出對應位置）、紅綠燈數量與位置、路型比例、依配速估算的完成時間
- **路線結果排序**：可依距離、總爬升、紅綠燈數、人行道＋腳踏車道佔比排序，並切換由小到大／由大到小（只改顯示順序，路線名稱與顏色不變；設定會記住）
- **路線圖層開關**：地圖左上角可勾選在目前路線上標示「紅綠燈」「人行道／步道」「腳踏車道」「小徑／土路」「便利商店」，並顯示各自的數量或公里數（設定會記住）
- **路線附近的便利商店**（100 m 內）：
  - 依品牌上色（7-11、全家、萊爾富、OK）
  - 點擊可看「路線約幾 km 處、距路線幾公尺、營業時間」
  - 高度剖面圖上會標出位置
  - 卡片顯示「最長幾 km 無補給」
  - 匯出的 GPX 會把便利商店寫成航點
- **匯入 GPX 分析**：
  - 把手錶紀錄或其他 App 的路線匯入後，會用與規劃路線相同的方式分析：距離、爬升、紅綠燈、路型比例、便利商店。
  - 可以直接和新規劃的路線比較。
  - 也可以一鍵把它的起終點與距離設為規劃條件。
- **鎖定**喜歡的路線，重新產生時只換掉其他幾條
- **GPX 匯出**，可匯入 Garmin、COROS、Strava 等

## 架構

```
瀏覽器 (React + MapLibre)
   │  /api/*
   ▼
API server (Node.js + Fastify)  ──►  BRouter（自架，Docker）  ← 台灣路網 + 高度資料（rd5）
   │  路線產生演算法、爬升計算、評分挑選
   └──►  Nominatim（只有按「搜尋」時才呼叫）

底圖：OpenFreeMap 向量圖磚（免 key、不限量）
```

| 資源 | 用途 | 額度 |
|---|---|---|
| **BRouter（自架）** | 路徑規劃、高度、號誌節點 | 沒有外部限制，只看本機效能 |
| OpenFreeMap | 地圖底圖 | 免 key，沒有公告的上限 |
| Nominatim | 地名搜尋 | 每秒 1 次（server 已節流並快取） |
| Overpass | 便利商店資料 | 只在 server 第一次啟動（或資料超過 30 天）時在背景下載一次全台資料 |

產生一次路線大約需要 10～30 次路徑運算，全部在本機 BRouter 完成，通常 1～3 秒內回應。

## 快速開始（Docker，建議）

需要：已安裝 Docker 的 WSL（Docker Desktop 的 WSL integration 或 docker engine 都可以）。

```bash
cd route_analyze
docker compose up -d --build
```

- 第一次啟動會自動下載台灣路網資料（`E120_N20.rd5`、`E120_N25.rd5`，約 35 MB），存在 `brouter/segments/`
- 完成後用瀏覽器開啟 **http://localhost:8787**
- 看 log：`docker compose logs -f`
- 停止：`docker compose down`

### 映像檔大小與樹莓派

兩個映像檔都以多階段建置（multi-stage build）瘦身，支援 x86_64 與 ARM64（樹莓派 4／5，需 64 位元系統）：

| 映像檔 | 內容 | 大小（估計） |
|---|---|---|
| brouter | Alpine＋Java 21 JRE＋BRouter | 約 180 MB（原本約 280 MB） |
| app | Alpine＋Node 22＋server 正式相依套件（41 MB）＋建置好的前端 | 約 210 MB（原本約 400 MB） |

- **其他佔用：** 路網資料 34 MB、便利商店資料 6 MB。
- **記憶體：** 實測 BRouter 高負載時峰值約 490 MB，包含規劃 42 km 環狀路線；API server 約 50 MB。2 GB 記憶體的樹莓派就夠用。
- **建置快取：** 建置過程的暫存層（含完整開發套件）會留在 Docker 快取中。確認可以正常運作後，可以用 `docker builder prune -f` 釋放空間，大約數百 MB。
- **Log 大小：** `docker-compose.yml` 已限制每個容器的 log 最多 3 個 10 MB 檔案，兩個容器合計上限 60 MB，長期運作也不會塞滿 SD 卡。
- **舊資料夾：** 由舊版升級時，舊的 `server/data/` 資料夾已經不再使用，可以刪除。便利商店資料會重新下載到 volume。

## 部署到樹莓派（24 小時運作）

以下以**樹莓派 4／5＋64 位元 Ubuntu** 為例，透過 SSH 操作。每個步驟都標明要在哪台機器上執行。

### 1. 確認環境（樹莓派）

```bash
uname -m      # 必須是 aarch64（64 位元）；armv7l 代表是 32 位元系統，映像檔無法使用
free -h       # 記憶體建議 2 GB 以上
df -h /       # 剩餘空間建議至少 3 GB
hostname -I   # 樹莓派的區網 IP
```

### 2. 安裝 Docker（樹莓派）

```bash
sudo apt update && sudo apt upgrade -y
sudo snap remove docker 2>/dev/null              # 如果裝過 snap 版就移除（有權限限制，容易出問題）
curl -fsSL https://get.docker.com | sudo sh      # 官方安裝腳本，一併安裝 Compose
sudo usermod -aG docker $USER                    # 之後不用 sudo 就能執行 docker
```

**登出再重新登入**，群組設定才會生效。然後確認安裝成功：

```bash
docker compose version
docker run --rm hello-world
```

### 3. 設定 Docker 的 DNS（樹莓派，建議）

家用路由器的 DNS（例如 `192.168.1.1`）常在容器內偶爾查詢逾時。讓 Docker 改用公用 DNS：

```bash
echo '{ "dns": ["168.95.1.1", "1.1.1.1"] }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
```

`168.95.1.1` 是 HiNet DNS。如果 `/etc/docker/daemon.json` 原本就有內容，請把 `"dns"` 加進去，不要整個覆蓋。

這個設定只影響**執行中的容器**，**建置時不會套用**。所以建置時下載 BRouter 的 `curl` 已經加上 `-4`（只查 IPv4），避開部分路由器同時處理 IPv4／IPv6 查詢時會逾時的問題。

### 4. 建置並啟動（樹莓派）

```bash
cd route_analyze                 # 樹莓派上的專案資料夾
docker compose up -d --build     # 第一次約 5～10 分鐘
docker compose ps                # 兩個容器都應為 running
docker compose logs -f app       # 等到看到「測試路線規劃成功」與「便利商店：下載完成」，再按 Ctrl+C 離開
```

同一個區網內，可以用 `http://<樹莓派IP>:8787` 開啟。確認一切正常後，清掉建置暫存：

```bash
docker builder prune -f
sudo apt clean
```

### 5. 開機自動啟動

- **Docker 服務：** 用官方腳本安裝時，已經設定為開機啟動。可以用 `systemctl is-enabled docker` 確認，應該顯示 `enabled`。
- **兩個容器：** 都設定了 `restart: unless-stopped`，Docker 啟動後會自動把它們帶起來。
- **網路比容器晚就緒：** 如果開機時網路還沒好，便利商店資料會在 1、5、15、30、60 分鐘後自動重試下載。

例外：手動執行 `docker compose stop` 或 `docker compose down` 之後，要再執行 `docker compose up -d`，重開機才會自動啟動。

#### 專案放在網路硬碟時（例如 RaiDrive 掛載的 `/mnt/onedrive`）

開機時 Docker 可能比網路硬碟早啟動。舊版的 compose 設定會讓 Docker 在「還沒掛載的空資料夾」底下自動建出專案路徑，接著網路硬碟因為掛載點不是空的而掛載失敗，`/mnt/onedrive` 就只剩專案那一串空資料夾。

`docker-compose.yml` 已經設定 `create_host_path: false`，不會再建出空資料夾。另外要讓 Docker 等網路硬碟掛好才啟動：

```bash
sudo systemctl edit docker.service
```

在編輯器中加入以下內容（掛載服務名稱、掛載點依實際情況修改），存檔離開：

```ini
[Unit]
Wants=raidrive.service
After=raidrive.service

[Service]
# 掛載服務啟動後還要十幾秒才真正掛好：最多等 3 分鐘，逾時仍啟動 Docker（其他容器照常運作）
ExecStartPre=/bin/sh -c 'for i in $(seq 1 180); do mountpoint -q /mnt/onedrive && exit 0; sleep 1; done; echo "/mnt/onedrive not mounted"; exit 0'
TimeoutStartSec=300
```

套用：

```bash
sudo systemctl daemon-reload
cd /mnt/onedrive/Desktop/code/route_analyze && docker compose up -d   # 讓新的 compose 設定生效
sudo reboot
```

重開機後用 `journalctl -b -u docker | head` 確認 Docker 是在掛載完成後才啟動。

如果已經發生掛載失敗：先 `sudo systemctl stop docker docker.socket raidrive`，確認 `mount | grep /mnt/onedrive` 沒有輸出、`sudo find /mnt/onedrive -type f` 也沒有任何檔案後，用 `sudo find /mnt/onedrive -mindepth 1 -depth -type d -empty -delete` 清掉空資料夾，再重開機。

### 6. 從外面連線：Tailscale（免費、固定 HTTPS 網址）

[Tailscale](https://tailscale.com/) 個人使用免費，會提供固定的 HTTPS 網址，樹莓派的路由器也不需要開放任何 port。有 HTTPS 之後，手機上的「使用目前位置（◎）」也能正常使用；用區網的 `http://` 網址時，瀏覽器會擋掉這個功能。

**安裝（樹莓派）**：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

如果腳本失敗，改用 apt 手動安裝：

```bash
. /etc/os-release
curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${VERSION_CODENAME}.noarmor.gpg" \
  | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${VERSION_CODENAME}.tailscale-keyring.list" \
  | sudo tee /etc/apt/sources.list.d/tailscale.list
sudo apt-get update && sudo apt-get install -y tailscale
```

**啟動與登入**：

```bash
sudo systemctl enable --now tailscaled   # 開機自動啟動
sudo tailscale up                        # 依照畫面上的網址用瀏覽器登入
```

**選擇連線方式**（擇一）：

```bash
# A. 只有你登入 Tailscale 的裝置能連（建議）
sudo tailscale serve --bg 8787

# B. 任何人都能用瀏覽器開啟（公開網址，沒有登入保護，請勿外流）
sudo tailscale funnel --bg 8787
```

```bash
tailscale serve status    # 顯示網址：https://<主機名稱>.<你的tailnet>.ts.net
```

- **設定會保留：** `--bg` 會記住設定，重開機後 `tailscaled` 會自動恢復，不需要重新設定。
- **第一次執行：** 可能會顯示一個網址，要你到 Tailscale 後台啟用 HTTPS 憑證（Funnel 還要另外啟用 Funnel）。啟用後再執行一次同樣的指令。
- **使用方式 A 時：** 手機和電腦都要安裝 Tailscale App，並登入同一個帳號。
- **停止對外連線：** `sudo tailscale serve reset`，會同時清除 serve 和 funnel 的設定。

### 7. 日後更新與維護

| 要做什麼 | 指令（都在樹莓派的專案資料夾執行） |
|---|---|
| 更新程式碼 | 程式碼更新後，執行 `docker compose up -d --build`，完成後可以再執行 `docker builder prune -f` |
| 更新路網資料 | 會自動更新（見〈資料自動更新〉）；要立刻更新：`rm brouter/segments/*.rd5 && docker compose restart brouter` |
| 看資源使用量 | `docker stats`、`docker system df` |
| 驗證重開機 | `sudo reboot`，1～2 分鐘後執行 `docker compose ps` 和 `tailscale serve status` |

### 樹莓派常見問題

- **建置時出現 `Could not resolve host`：** 容器內的 DNS 查詢逾時。請確認已完成第 3 步。建置 BRouter 仍然失敗時，可以改用主機網路建置：`docker build --network host -t route_analyze-brouter ./brouter`，再執行 `docker compose up -d`。
- **建置時出現 `snapshot ... does not exist: not found`：** Docker 的建置快取損壞，常見原因是建置途中重啟了 Docker。先試 `docker compose build --no-cache app`。還是失敗的話，執行：
  ```bash
  sudo systemctl stop docker docker.socket
  sudo rm -rf /var/lib/docker/buildkit     # 只清建置快取，不影響映像檔、容器和 volume
  sudo systemctl start docker
  ```
- **app 啟動時出現 `EACCES: permission denied`：** 原始檔案的權限太嚴格，常見於從 rclone 掛載的資料夾建置。目前的 Dockerfile 已經會自動修正權限；如果看到這個錯誤，請確認用的是最新的程式碼，並重新建置。

## 開發模式（前後端熱更新）

需要：Node.js 20 以上（建議 22）。

```bash
# 1. 只啟動 BRouter
docker compose up -d brouter

# 2. 安裝套件（第一次）
npm install

# 3. 同時啟動 API（:8787）與前端（:5173）
npm run dev
```

用瀏覽器開啟 **http://localhost:5173**。Vite 會把 `/api` 轉到 8787。

其他指令：

```bash
npm test            # 後端單元測試（弧線幾何、爬升計算、號誌合併、重疊率…）
npm run typecheck   # 前後端型別檢查
npm run build       # 建置前端到 web/dist
npm start           # 正式模式：由 API server 同時提供前端（http://localhost:8787）
```

## 使用方式

1. **設定起點**：直接點地圖、在搜尋框輸入地名後按「起點」，或按 ◎ 使用目前位置。
2. 點地圖時，模式會自動依序切換「起點 → 終點 → 經過點」；左上角會顯示目前的模式，也可以手動切換。
3. 勾選 **環狀路線** 就不需要終點。
4. 選擇 **指定距離（km）** 或 **最短路徑**，再設定紅綠燈與路型偏好。要更符合條件時，把 **努力程度** 往右拉。
5. 按 **產生路線**。點卡片或地圖上的路線可以切換要查看哪一條。
6. 不滿意就按 **重新產生**。想保留的路線先按 🔓 鎖定。

## 設定（環境變數）

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `8787` | API server port |
| `BROUTER_URL` | `http://localhost:17777` | BRouter 位址（docker compose 內為 `http://brouter:17777`） |
| `ROUTER_CONCURRENCY` | `4` | 同時送往 BRouter 的請求數 |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | 地名搜尋服務 |
| `USER_AGENT` | `route-analyze/0.1 …` | Nominatim 要求提供的識別 |

BRouter 容器：`JAVA_OPTS`（預設 `-Xmx768m -XX:+UseSerialGC`）、`MAX_THREADS`（預設 4）、`SEGMENTS`（要下載的分區）。

## 擴展到全台灣

路網資料的兩個分區本來就涵蓋全台灣，API 也接受台灣本島範圍內的座標，所以**現在就可以在台灣任何地方使用**。跟「桃園」有關的只有兩個預設值：

- 地圖初始中心：`web/src/components/MapView.tsx` 的 `TAOYUAN_CENTER`
- 地名搜尋的優先範圍：`server/src/config.ts` 的 `geocodeViewbox`（只影響排序，不會限制搜尋結果）

因為路徑運算全部在本機，擴展範圍不會碰到外部 API 的額度限制。

## 匯入 GPX

在「產生路線」按鈕下方按 **📂 匯入 GPX 分析**，選擇 `.gpx` 檔。

- **支援格式：**
  - 軌跡（`trkpt`）：手錶紀錄、Strava、Garmin Connect 匯出等。
  - 路線點（`rtept`）：其他規劃軟體匯出。
- **貼齊道路：** 紅綠燈、路型等資料需要知道實際走的是哪條路，所以會把軌跡貼齊到道路上：
  1. 實際紀錄（軌跡點帶時間）先把 GPS 飄移平滑掉（沿軌跡前後 15 m 平均）；規劃軟體匯出的軌跡（沒有時間，例如 RideWithGPS 的賽道檔）本身就在路上，不做平滑，以免把轉角削掉。
  2. 每隔約 100 m 取一個途經點，讓 BRouter 依序經過（中性設定，不避紅綠燈、不偏好路型）。
  3. 途經點被吸到路口延伸段或死巷時，會出現假的「U 字折返」，會自動偵測並移除、重新比對。原始軌跡本身真的有折返（跑到底再原路回來、賽道折返點）則會保留。
  4. 賽道常經過封閉園區、活動管制路段或 OpenStreetMap 沒畫的小路，BRouter 走不過去只能繞一大圈。比對結果明顯比軌跡長時，會逐段找出這些路段，直接沿用原軌跡（這些路段不計紅綠燈與路型）。
- **高度：** GPX 有高度資料時，爬升／下降與高度圖使用 GPX 的高度（路線規劃軟體的地形資料比 SRTM 精細），只做輕度平滑；沒有高度，或是本工具匯出的檔案，則和規劃路線一樣用 BRouter 的 SRTM 高度計算。
- **準確度實測：**
  - 7.85 km 市區路線（模擬手錶紀錄）：距離誤差 < 0.5%，路型比例誤差約 ±2%，紅綠燈數可能差 1～2 個（在不同路口過馬路）。
  - 2026 新屋馬 21K（RideWithGPS 賽道檔，標示 21.7 km／爬升 109 m）：匯入後 21.69 km／爬升 102 m。
- **提示訊息：**
  - 有路段在道路資料中走不過去、改用原軌跡時會提示長度。
  - 軌跡有 10% 以上對不上道路（山徑、操場、GPS 訊號不良）時會提示。
  - 路線點（rtept）檔案是依道路連接各點，實際路徑可能與原規劃軟體不同。
- **匯入的路線：**
  - 以深灰色顯示，名稱為 GPX1、GPX2…。
  - 不佔「路線數量」的名額，重新產生時會保留。
  - 按 ✕ 移除。

## 便利商店資料

- **來源：** OpenStreetMap 的 `shop=convenience`，全台約 1.2 萬間；已排除沒有賣水的「蝦皮店到店」取貨點。
- **下載與快取：** API server 啟動時在背景下載一次，存到 `server/data/convenience-stores.json`，大約 1 分鐘，不影響路線規劃。之後直接讀檔，超過 30 天會自動在背景更新（見〈資料自動更新〉）。Docker 模式下，資料存在具名 volume `app-data`，重建映像檔也會保留。
- **下載失敗時：** Overpass 公開伺服器偶爾會忙碌。失敗時會沿用舊檔，並在 1、5、15、30、60 分鐘後自動重試；如果還沒有任何資料，畫面會顯示提示。
- **強制更新：** 開發模式刪除 `server/data/convenience-stores.json` 後重啟 server；Docker 模式執行 `docker compose exec app rm /app/server/data/convenience-stores.json && docker compose restart app`。

## 資料自動更新

路網和便利商店資料都會自動保持更新，而且都在背景進行，不會拖慢開機或啟動。

| 資料 | 檢查時機 | 何時下載 | 更新時的影響 | 設定（`docker-compose.yml`） |
|---|---|---|---|---|
| 路網（`*.rd5`，約 34 MB） | 啟動 1 分鐘後，之後每天 | 本地檔超過 7 天，**且** brouter.de 有較新版本（官方約每週更新） | 下載完 BRouter 自動重啟，中斷約數秒 | `SEGMENTS_MAX_AGE_DAYS: 7` |
| 便利商店（Overpass，約 1 分鐘） | 啟動時，之後每天 | 本地資料超過 30 天 | 無，下載完直接換新 | `STORES_MAX_AGE_DAYS: 30` |

- **下載失敗：** 繼續使用舊資料。路網隔天再試；便利商店在 1、5、15、30、60 分鐘後重試。
- **調整天數：** 修改 `docker-compose.yml` 的數字後執行 `docker compose up -d`。路網設成 `0` 等於每次啟動都向官方確認（沒有新版不會下載）；便利商店建議維持 30 天，避免增加 Overpass 公開伺服器的負擔。
- **查看紀錄：** `docker compose logs brouter | grep 路網`、`docker compose logs app | grep 便利商店`。
- **立刻更新路網：**

  ```bash
  rm brouter/segments/*.rd5
  docker compose restart brouter   # 啟動時會重新下載（需要等下載完才能規劃路線）
  ```

## 演算法說明

### 紅綠燈迴避

`brouter/profiles/running.brf` 是 BRouter 的路跑 profile。每次請求時，server 依使用者的勾選替換參數，再上傳成一個暫時的 custom profile：

- 節點帶有 `highway=traffic_signals` 或 `crossing=traffic_signals` 時，加上 `signal_penalty`（預設等同多跑 250 m）的成本。這是「盡量」避開，真的繞不開時還是會經過。
- 顯示的紅綠燈數量取自 BRouter 回傳的節點 tag。同一個路口常有多個號誌節點，距離 35 m 內的會合併成一個路口計算。
- 資料來源是 OpenStreetMap。桃園市區的號誌標記大致完整，郊區可能有缺漏。

### 路型偏好

| 選項 | 對應 OSM tag | 成本係數 |
|---|---|---|
| 人行道／步道 | `highway=footway/pedestrian/…`、有鋪面的 `path`／`track`、道路上標有 `sidewalk=*` | 偏好 1.0／不限 1.3（有其他路型設為偏好時 1.8）／避開 5.0 |
| 腳踏車道 | `highway=cycleway`、`bicycle=designated`、`cycleway=track` | 同上 |
| 小徑／土路 | 沒有標示鋪面的 `highway=path/track/bridleway`（山徑、土路、產業道路），以及標示未鋪面（`surface=ground/dirt/gravel/…`）的人行步道 | 同上 |
| 一般馬路 | 其他沒有人行道的道路 | 同上 |

另外，大馬路（trunk、primary、secondary）沒有人行道時會再加一點成本；高速公路禁止通行。

「避開」是加成本而非禁止：附近只有小徑可走、或繞路代價太大時仍可能經過。實測龜山楓樹坑 8 km 環狀路線，小徑比例：避開 0～3%、不限 0～32%、偏好 0～59%。
OSM 上許多小徑沒有標示鋪面，因此部分其實有鋪面的產業道路也會被算成小徑。

### 環狀路線：不限圓形，設定條件優先

環狀路線（沒有經過點時）不再把途經點排成圓形，而是「去程 + 回程」：

1. **去程**：起點 →（0～1 個隨機途經點）→ 折返點。強制經過的點很少，BRouter 能依紅綠燈、路型等設定自由選路。
2. **回程**：折返點 → 起點，並在去程路徑上加一條**有權重的 nogo 線**（BRouter `polylines` 參數）。沿著去程往回跑會一路被加成本；只是交叉一下則成本很小。所以路線形狀自由、允許交叉，但會盡量避免往返重複。
3. 用割線法調整折返點離起點的距離，讓總長接近目標。
4. **第二輪**：
   - 從第一輪表現好的路線中，挑出偏好路型（例如腳踏車道）的路段，當作去程的固定錨點。
   - 由最好的幾條路線微調方位與距離，再產生一批候選。
5. 評分以設定條件為主：
   - 偏好路型比例
   - 避開路型比例
   - 每公里紅綠燈數
   - 折返比例
   - 距離仍需在 8% 內

實測（10 km 環狀，各 3 次平均，與舊的圓形版本比較）：

| 情境 | 圓形版本 | 目前版本 |
|---|---|---|
| 中壢，偏好腳踏車道 | 腳踏車道 15% | 29% |
| 觀音，偏好腳踏車道 | 腳踏車道 12% | 29% |
| 桃園，偏好人行道、避開馬路 | 馬路 40% | 27% |
| 龜山 | 折返 32% | 15% |

在路網稀疏的地方（例如只有一條路進出的山區），回程仍可能部分重複，卡片上會顯示「重複路段」比例。

有經過點的環狀路線，以及 A→B 路線，仍使用下方的圓弧繞路方式。

開發時可設定環境變數 `DEBUG_GEN=1`，server 會印出每個候選路線的分數與各項指標。

### 指定距離，而且每次都不同

1. 先算出經過所有使用者指定點的最短路徑，得到實際路線長度，以及路網繞行係數（實際路線長 ÷ 直線距離）。
2. 多出的距離（目標 − 最短）隨機分配給各路段。每條候選路線都隨機決定這些參數：
   - 往路段的哪一側繞
   - 途經點數量
   - 位置抖動
   - 環狀路線的方位角
3. 途經點放在「通過 A、B 兩點、弧長等於目標長度的圓弧」上。A、B 重合時（純環狀路線），就放在通過起點、周長等於目標長度的圓上。
4. 用**割線法**縮放繞路幅度，最多 4 次（依努力程度），讓實際長度收斂到目標 ±3% 內。
5. 平行產生 8 個候選（依努力程度），評分依據：
   - 長度誤差
   - 折返比例
   - 每公里紅綠燈數
   - 路型偏好
6. 依分數**挑出彼此重疊率低**的路線（數量可選 1～10 條，鎖定的路線也算在內）。鎖定的路線也會列入比較，所以新路線會刻意避開它們。要的條數越多，候選數也會自動增加（至少為條數的 1.5 倍），才湊得出彼此分散的路線；附近路網有限時會放寬重疊門檻，仍不足則顯示「只找到 N 條」。

每次請求都用 `crypto.getRandomValues` 產生新種子。種子會顯示在結果下方，方便除錯。

### 自訂總爬升

目標是「大概符合」，距離仍然是主要條件：

1. 第一輪照常產生候選（努力程度 3 為 8 個）。
2. 從中挑出爬升最接近目標的 3 條，微調形狀（方位角、往哪一側繞、途經點位置），再產生同樣數量的候選。這樣會往地形較合適的方向探索。
3. 如果第一輪全部都**爬太多**，第二輪會改用「減少爬升」的 profile（`avoid_climb`：坡度超過 1% 的上下坡都加成本）。BRouter 只能懲罰爬坡、不能鼓勵爬坡，所以要更多爬升時只能靠第 2 步的形狀探索。
4. 評分加入爬升誤差項，但距離誤差超過 8% 的候選一律排在後面。
5. 最接近的路線仍與目標相差超過 30%（且超過 15 m）時會顯示警告。例如在平坦的桃園市區要求 200 m，或在龜山要求很低的爬升。

實測（10 km 環狀）：中壢目標 60 m，得到 60／57／59 m；龜山目標 150 m，得到 155／167／159 m。

### 努力程度

介面上的滑桿決定每次產生路線要試多少候選。3 是預設，數字都是指每一輪：

| 等級 | 每輪候選 | 長度調整次數（A→B／環狀） | 額外精修輪數 | 最短路徑模式的隨機候選 |
|---|---|---|---|---|
| 1 最快 | 4 | 3／2 | 0 | 3 |
| 2 較快 | 6 | 4／3 | 0 | 4 |
| 3 平衡 | 8 | 4／3 | 0 | 5 |
| 4 較仔細 | 10 | 5／4 | 1 | 8 |
| 5 最仔細 | 12 | 6／4 | 2 | 12 |

額外精修：由目前分數最好的 3 條候選微調形狀，再產生一批候選，逐輪往更符合條件的方向靠近。沒有自訂爬升的 A→B 指定距離路線，也會因此得到第二輪。

實測（本機 BRouter，同一種子）：

| 情境 | 等級 1 | 等級 3 | 等級 5 |
|---|---|---|---|
| 10 km 環狀，目標爬升 80 m | 98／60／47 m，26 次運算 | 69／60／58 m，62 次運算 | 84／71／72 m，194 次運算 |
| 10 km 環狀，偏好人行道 | 人行道 52／32／47% | 52／32／62% | 58／48／59% |
| 16 km A→B，目標爬升 150 m | 16.80／15.97／16.92 km | 16.16／15.19／15.97 km | 15.96／16.08／16.29 km |

等級 5 的路徑運算次數約為預設的 3 倍。樹莓派上耗時也會等比例增加，建議需要時才調高。

### 爬升／下降

直接累加 DEM（SRTM）高度會因雜訊高估總爬升。因此會先每 20 m 重新取樣、做移動平均，再加上 2 m 的遲滯門檻後才累加。

## 專案結構

```
route_analyze/
├─ docker-compose.yml        # brouter + app
├─ Dockerfile                # app（API + 前端）
├─ brouter/
│  ├─ Dockerfile, entrypoint.sh
│  ├─ profiles/running.brf   # 路跑 profile 樣板
│  └─ segments/              # 路網資料（自動下載，不進版控）
├─ shared/types.ts           # 前後端共用型別
├─ server/src/
│  ├─ index.ts               # Fastify API：POST /api/routes、GET /api/geocode、GET /api/health
│  ├─ generator.ts           # 候選路線產生、迭代、評分、多樣性挑選
│  ├─ shapes.ts              # 圓弧／繞圈途經點幾何
│  ├─ metrics.ts             # 爬升、號誌、路型比例、重疊率
│  ├─ brouter.ts, profile.ts # BRouter client 與 profile 參數化
│  └─ geocode.ts             # Nominatim 代理（節流 + 快取）
└─ web/src/
   ├─ App.tsx
   └─ components/            # MapView、PointsPanel、OptionsPanel、RouteCards、ElevationChart
```

## 疑難排解

- **先做健康檢查**：開啟 http://localhost:8787/api/health，會實際規劃一段測試路線。`"brouter":"ok"` 代表正常，否則會顯示 BRouter 的錯誤訊息。
- **`datafile E120_N20.rd5 not found`**：路網資料沒有下載成功。確認 `brouter/segments/` 裡有兩個 `.rd5` 檔（約 22 MB 與 12 MB），然後執行 `docker compose restart brouter`。
- **「無法連線到 BRouter」**：確認 `docker compose ps` 中 brouter 是 running 狀態。第一次啟動要先等路網資料下載完（看 `docker compose logs brouter`）。開發模式下，API 預設連 `http://localhost:17777`。
- **地圖一片空白**：底圖來自 OpenFreeMap，需要網路連線。
- **「起點附近 300 公尺內找不到可通行的道路」**：點到海上、河中或沒有道路的山區了，換個位置再試。
- **山區或海邊的路線有很多折返**：當地路網稀疏，卡片會顯示「重複路段」比例，並附上警告。
- **開發模式改了程式碼卻沒更新**：專案放在 `/mnt/c/...`（Windows 磁碟、OneDrive）時，WSL 收不到檔案變更事件。前端已自動改用輪詢；後端（`tsx watch`）若沒有自動重啟，請手動 Ctrl+C 後再執行 `npm run dev`。想要最順的開發體驗，可以把專案放到 WSL 自己的檔案系統（例如 `~/code/route_analyze`）。
- **沒有顯示便利商店**：開啟 http://localhost:8787/api/health 查看 `stores.status`。`loading` 代表還在下載；`error` 代表下載失敗，可以重啟 server 再試。
- **port 被占用**：修改 `docker-compose.yml` 的 `ports`，或在開發模式設定 `PORT`。
