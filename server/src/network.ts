import dns from 'node:dns';
import net from 'node:net';

// 對外連線（Overpass、Nominatim 都在歐洲）的網路設定，需在其他模組之前載入。
//
// Node 20+ 連線時會輪流嘗試 IPv6／IPv4（happy eyeballs），每個位址預設只等 250 ms。
// Docker 容器常「查得到 IPv6 位址但沒有 IPv6 網路」，加上從台灣連歐洲約 250～300 ms，
// 結果 IPv4 等不到、IPv6 立刻失敗，整體回報 ETIMEDOUT（fetch failed）。
// → 優先使用 IPv4，並放寬每個位址的等待時間。
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
