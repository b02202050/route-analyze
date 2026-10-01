# 🏃 路跑路線規劃 Route Analyze

自架的路跑路線規劃工具：設定起點（與終點、經過點），一次產生多條**彼此分散**、符合距離／爬升／路型偏好的路跑路線，並避開紅綠燈。

- 路徑運算全部在自架的 [BRouter](https://github.com/abrensch/brouter) 完成，沒有外部 API 額度限制
- 地圖與道路資料來自 [OpenStreetMap](https://www.openstreetmap.org/)
- 預設涵蓋**台灣**，可改成其他地區（見[更換地區](#更換地區)）

## 功能

- **路線條件**：環狀或 A→B、經過點、指定公里數（±3%）或最短路徑、大約的總爬升
- **偏好**：盡量避開紅綠燈；人行道／步道、腳踏車道、小徑／土路、一般馬路可各設「偏好／不限／避開」
- **一次 1～10 條路線**，彼此盡量不重疊；可鎖定喜歡的路線，只重新產生其他條
- **努力程度**滑桿：在「快速產生」與「多試候選、更符合條件」之間取捨
- **路線資訊**：距離、爬升／下降、高度剖面圖、紅綠燈數量與位置、路型比例、預估完成時間，可依這些數值排序
- **沿途便利商店**（100 m 內）：品牌、營業時間、最長無補給距離
- **GPX**：匯出到 Garmin／COROS／Strava 等；也可匯入手錶紀錄或其他 App 的路線，用同樣方式分析比較

## 快速開始

需要 [Docker](https://docs.docker.com/get-docker/)（含 Compose）。支援 x86_64 與 ARM64。

```bash
git clone https://github.com/b02202050/route-analyze.git
cd route-analyze
docker compose up -d --build
```

開啟 **http://localhost:8787**。

- 第一次啟動會下載路網資料（約 35 MB）到 `brouter/segments/`，完成前無法規劃路線
- 便利商店資料會在背景下載（約 1 分鐘），不影響規劃
- 確認狀態：開啟 http://localhost:8787/api/health，`"ok": true` 代表一切正常
- 看 log：`docker compose logs -f`；停止：`docker compose down`

## 使用方式

1. **設定起點**：點地圖、搜尋地名，或按 ◎ 使用目前位置。點地圖會依序設定「起點 → 終點 → 經過點」，標記可拖曳。
2. 勾選 **環狀路線** 就不需要終點。
3. 設定距離、爬升、紅綠燈與路型偏好，以及要產生幾條路線。
4. 按 **產生路線**。點卡片或地圖上的路線切換檢視。
5. 不滿意就按 **重新產生**；想保留的路線先按 🔓 鎖定。

> 「使用目前位置」需要 HTTPS（或 `localhost`）。從其他裝置連線時，請在前面加一個提供 HTTPS 的反向代理。

## 架構

```
瀏覽器（React + MapLibre）
   │  /api/*
   ▼
API server（Node.js + Fastify）──► BRouter（自架，Docker）← 路網 + 高度資料（rd5）
   │  候選路線產生、評分、挑選
   ├──► Nominatim：地名搜尋（只有按「搜尋」時）
   └──► Overpass：便利商店資料（啟動時背景下載並快取）

底圖：OpenFreeMap 向量圖磚（免 key）
```

產生一次路線約需 10～250 次路徑運算（依條件、路線數量與努力程度），通常數秒內完成。

## 設定

### API server（`app`）

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `8787` | API server port |
| `BROUTER_URL` | `http://localhost:17777` | BRouter 位址（compose 內為 `http://brouter:17777`） |
| `ROUTER_CONCURRENCY` | `4` | 同時送往 BRouter 的請求數 |
| `STORES_MAX_AGE_DAYS` | `30` | 便利商店資料超過幾天就在背景重新下載 |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | 地名搜尋服務 |
| `OVERPASS_URLS` | overpass-api.de、kumi.systems | 便利商店資料來源（逗號分隔，依序嘗試） |
| `USER_AGENT` | `route-analyze/0.1 …` | 呼叫 Nominatim／Overpass 時的識別 |

### BRouter（`brouter`）

| 變數 | 預設 | 說明 |
|---|---|---|
| `SEGMENTS` | `E120_N20 E120_N25` | 要下載的路網分區（5°×5°） |
| `SEGMENTS_MAX_AGE_DAYS` | `7` | 路網檔超過幾天就檢查官方是否有新版 |
| `JAVA_OPTS` | `-Xmx768m -XX:+UseSerialGC` | JVM 參數 |
| `MAX_THREADS` | `4` | BRouter 同時處理的請求數 |

修改 `docker-compose.yml` 後執行 `docker compose up -d` 套用。

### 資料自動更新

兩種資料都在背景更新，不會拖慢啟動：

- **路網**：啟動 1 分鐘後及之後每天檢查；本地檔超過 `SEGMENTS_MAX_AGE_DAYS` 天且官方有新版時才下載，下載完 BRouter 自動重啟（中斷數秒）。
- **便利商店**：啟動時及之後每天檢查；超過 `STORES_MAX_AGE_DAYS` 天就重新下載。資料存在具名 volume `app-data`，重建映像檔也會保留。
- 下載失敗時都會沿用舊資料並稍後重試。

立刻更新路網：`rm brouter/segments/*.rd5 && docker compose restart brouter`。

## 開發

需要 Node.js 20 以上（建議 22），以及 Docker（只用來跑 BRouter）。

```bash
docker compose up -d brouter   # 只啟動 BRouter
npm install
npm run dev                    # API（:8787）與前端（:5173），皆支援熱更新
```

開啟 **http://localhost:5173**，Vite 會把 `/api` 轉到 8787。

| 指令 | 說明 |
|---|---|
| `npm test` | 後端單元測試 |
| `npm run typecheck` | 前後端型別檢查 |
| `npm run build` | 建置前端到 `web/dist` |
| `npm start` | 正式模式，由 API server 同時提供前端（:8787） |

設定 `DEBUG_GEN=1` 時，server 會印出每個候選路線的分數與各項指標，調整評分時很有用。

### 專案結構

```
route-analyze/
├─ docker-compose.yml          # brouter + app
├─ Dockerfile                  # app（API + 前端）
├─ brouter/
│  ├─ Dockerfile, entrypoint.sh  # 下載／自動更新路網並啟動 BRouter
│  ├─ profiles/running.brf     # 路跑 profile 樣板（紅綠燈、路型成本）
│  └─ segments/                # 路網資料（自動下載，不進版控）
├─ shared/types.ts             # 前後端共用的 API 型別
├─ server/src/
│  ├─ index.ts                 # Fastify 路由與參數驗證
│  ├─ generator.ts             # 候選路線產生、迭代、評分、多樣性挑選
│  ├─ shapes.ts                # 繞路途經點幾何
│  ├─ metrics.ts               # 爬升、號誌、路型分類與比例、重疊率
│  ├─ importer.ts              # GPX 軌跡貼齊道路
│  ├─ brouter.ts, profile.ts   # BRouter client 與 profile 參數化
│  ├─ stores.ts                # 便利商店下載、快取與沿途查詢
│  ├─ geocode.ts               # Nominatim 代理（節流 + 快取）
│  └─ config.ts                # 環境變數與服務範圍
└─ web/src/
   ├─ App.tsx, api.ts, lib.ts
   └─ components/              # MapView、PointsPanel、OptionsPanel、RouteCards、ElevationChart
```

### API

| 方法 | 路徑 | 說明 |
|---|---|---|
| `POST` | `/api/routes` | 產生路線（請求／回應格式見 `shared/types.ts` 的 `GenerateRequest`／`GenerateResponse`） |
| `POST` | `/api/import` | 把 GPX 軌跡點貼齊道路並分析（`ImportRequest`） |
| `GET` | `/api/geocode?q=` | 地名搜尋 |
| `GET` | `/api/health` | 實際規劃一段測試路線，並回報便利商店資料狀態 |

## 貢獻

歡迎任何形式的貢獻！

## 疑難排解

- **`/api/health` 顯示 BRouter 錯誤**：確認 `docker compose ps` 中 brouter 為 running，`brouter/segments/` 裡有 `.rd5` 檔；第一次啟動要等路網下載完（`docker compose logs brouter`）。
- **「起點附近 300 公尺內找不到可通行的道路」**：點到海上、河中或沒有道路的地方，換個位置再試。
- **路線很多折返**：當地路網稀疏，卡片會顯示「重複路段」比例。
- **沒有顯示便利商店**：查看 `/api/health` 的 `stores.status`：`loading` 代表還在下載，`error` 代表下載失敗（會自動重試）。
- **地圖一片空白**：底圖來自 OpenFreeMap，需要網路連線。
- **建置時 `Could not resolve host`**：容器內 DNS 查詢逾時，可在 `/etc/docker/daemon.json` 設定 `"dns"` 為公用 DNS 後重啟 Docker。
- **開發模式改了程式碼沒有更新**：專案放在網路磁碟或 WSL 的 `/mnt/c` 下時收不到檔案變更事件，請手動重啟 `npm run dev`，或把專案移到本機檔案系統。
- **port 被占用**：修改 `docker-compose.yml` 的 `ports`，或在開發模式設定 `PORT`。

---

## 運作原理

以下給想了解或改進演算法的人參考。

### 路徑成本（`running.brf`）

每次請求時，server 依使用者設定替換 profile 樣板中的參數，再上傳成暫時的 custom profile。

- **紅綠燈**：帶 `highway=traffic_signals` 或 `crossing=traffic_signals` 的節點加上約 250 m 的成本。這是「盡量」避開；顯示時 35 m 內的號誌合併成一個路口計算。
- **路型**：

  | 路型 | 對應 OSM tag |
  |---|---|
  | 人行道／步道 | `highway=footway/pedestrian/…`、有鋪面的 `path`／`track`、標有 `sidewalk=*` 的道路 |
  | 腳踏車道 | `highway=cycleway`、`bicycle=designated`、`cycleway=track` |
  | 小徑／土路 | 沒有標示鋪面的 `highway=path/track/bridleway`、標示未鋪面的人行步道 |
  | 一般馬路 | 其他沒有人行道的道路 |

  成本係數：偏好 1.0、不限 1.3（有其他路型設為偏好時 1.8）、避開 5.0。「避開」是加成本而非禁止。大馬路沒有人行道時再加一點成本；高速公路禁止通行。

### 產生候選路線

- **A→B 或有經過點**：先算最短路徑，把多出的距離隨機分配給各路段，途經點放在「弧長等於目標長度的圓弧」上（隨機決定往哪側繞、途經點數量與位置抖動），再用**割線法**縮放繞路幅度，讓長度收斂到目標 ±3%。
- **純環狀路線**：「去程＋回程」。去程是起點 →（0～1 個途經點）→ 折返點；回程在去程路徑上加一條有權重的 nogo 線（BRouter `polylines`），盡量不走回頭路但允許交叉。第二輪會把去程錨定在第一輪找到的偏好路型路段上。
- **自訂爬升**：從爬升最接近目標的候選微調形狀再產生一輪；全部爬太多時改用「減少爬升」設定（坡度超過 1% 加成本）。距離仍是主要條件。
- **最短路徑模式**：最短路徑＋BRouter 替代路線＋隨機側向偏移的候選。

### 評分與挑選

評分項目：長度誤差（超過 8% 一律排後面）、爬升誤差、折返比例、每公里紅綠燈數、偏好／避開路型比例。依分數挑出**彼此重疊率低**的路線（含已鎖定的路線），找不夠時逐步放寬門檻。

### 努力程度

| 等級 | 每輪候選 | 長度調整次數（A→B／環狀） | 額外精修輪數 |
|---|---|---|---|
| 1 最快 | 4 | 3／2 | 0 |
| 2 | 6 | 4／3 | 0 |
| 3（預設） | 8 | 4／3 | 0 |
| 4 | 10 | 5／4 | 1 |
| 5 最仔細 | 12 | 6／4 | 2 |

精修輪由目前最好的 3 條候選微調形狀再試一批。要求的路線條數越多，候選數也會自動增加（至少為條數的 1.5 倍）。等級 5 的運算量約為預設的 3 倍。

### 爬升計算

直接累加 DEM（SRTM）高度會因雜訊高估爬升，因此先每 20 m 重新取樣、移動平均，再加 2 m 遲滯門檻後累加。匯入的 GPX 若帶有高度，改用 GPX 高度（10 m 取樣、1 m 門檻）。

### 匯入 GPX

紅綠燈與路型統計需要知道實際走的是哪條路，所以會把軌跡貼齊到道路：

1. 實際紀錄（軌跡點帶時間）先平滑 GPS 飄移；規劃軟體匯出的軌跡不平滑，以免削掉轉角。
2. 每約 100 m 取一個途經點讓 BRouter 依序經過，並自動移除途經點被吸到死巷造成的假折返。
3. 遇到路網中走不過去的路段（封閉園區、OSM 沒畫的小路），改沿用原軌跡，並提示長度。

### 便利商店

來源為 OpenStreetMap 的 `shop=convenience`（已排除不賣水的取貨點），由 Overpass 下載後快取在 `server/data/convenience-stores.json`（Docker 為 volume `app-data`）。

### 更換地區

路網分區、服務範圍與預設值集中在以下位置：

| 項目 | 位置 |
|---|---|
| 路網分區 | `brouter/Dockerfile` 的 `SEGMENTS`（分區名稱見 [brouter.de/brouter/segments4](https://brouter.de/brouter/segments4/)） |
| API 接受的座標範圍 | `server/src/config.ts` 的 `serviceBounds` |
| 便利商店下載範圍 | `server/src/config.ts` 的 `storesBbox` |
| 地名搜尋優先範圍 | `server/src/config.ts` 的 `geocodeViewbox`（只影響排序） |
| 地圖初始中心 | `web/src/components/MapView.tsx` |

## 資料來源與致謝

- 道路、號誌、便利商店資料：© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors（ODbL）
- 路徑引擎與路網檔：[BRouter](https://github.com/abrensch/brouter)
- 高度資料：SRTM（隨 BRouter 路網檔提供）
- 底圖：[OpenFreeMap](https://openfreemap.org/)
- 地名搜尋：[Nominatim](https://nominatim.org/)

## 授權

[MIT](LICENSE)：可自由使用、修改、散布與商用，只需保留版權與授權聲明。
