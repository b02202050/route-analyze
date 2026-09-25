import maplibregl, { type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { LatLng, RouteResult } from '../../../shared/types';
import { CATEGORY_COLOR, SIGNAL_COLOR, STORE_COLOR, type LayerToggles } from '../lib';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const TAOYUAN_CENTER: [number, number] = [121.3, 24.99];

interface Props {
  start: LatLng | null;
  end: LatLng | null;
  loop: boolean;
  waypoints: LatLng[];
  routes: RouteResult[];
  colors: Record<string, string>;
  selectedId: string | null;
  hoverPoint: [number, number] | null;
  /** 選取路線上要標示的紅綠燈／人行道／腳踏車道 */
  layers: LayerToggles;
  /** 值改變時把視野移到所有路線 */
  fitKey: number;
  /** 值改變時飛到該點 */
  focus: { p: LatLng; key: number } | null;
  onMapClick: (p: LatLng) => void;
  onMovePoint: (kind: 'start' | 'end' | 'waypoint', index: number, p: LatLng) => void;
  onSelectRoute: (id: string) => void;
}

const emptyFC = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

function makeMarkerEl(className: string, text: string) {
  const el = document.createElement('div');
  el.className = `marker ${className}`;
  el.textContent = text;
  return el;
}

export default function MapView(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [loaded, setLoaded] = useState(false);
  // 事件處理器永遠讀最新 props
  const propsRef = useRef(props);
  propsRef.current = props;

  // 初始化地圖
  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: STYLE_URL,
      center: TAOYUAN_CENTER,
      zoom: 12,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(
      new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }),
      'top-right',
    );
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      // 地名改用中文（name 在台灣本來就是中文）
      for (const layer of map.getStyle().layers ?? []) {
        if (layer.type !== 'symbol') continue;
        const tf = map.getLayoutProperty(layer.id, 'text-field');
        if (tf && JSON.stringify(tf).includes('name')) {
          map.setLayoutProperty(layer.id, 'text-field', [
            'coalesce',
            ['get', 'name:zh-Hant'],
            ['get', 'name'],
            ['get', 'name:latin'],
          ]);
        }
      }

      map.addSource('routes', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'routes-casing',
        type: 'line',
        source: 'routes',
        layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['get', 'order'] },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['case', ['get', 'selected'], 10, 6],
          'line-opacity': ['case', ['get', 'selected'], 0.95, 0.6],
        },
      });
      map.addLayer({
        id: 'routes-line',
        type: 'line',
        source: 'routes',
        layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['get', 'order'] },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['get', 'selected'], 6, 3.5],
          'line-opacity': ['case', ['get', 'selected'], 1, 0.55],
        },
      });
      // 選取路線上的人行道／腳踏車道（白邊 + 路型顏色，疊在路線上方）
      map.addSource('way-overlay', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'way-overlay-casing',
        type: 'line',
        source: 'way-overlay',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 9 },
      });
      map.addLayer({
        id: 'way-overlay-line',
        type: 'line',
        source: 'way-overlay',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 5 },
      });

      map.addLayer({
        id: 'routes-arrows',
        type: 'symbol',
        source: 'routes',
        filter: ['==', ['get', 'selected'], true],
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 120,
          'text-field': '›',
          'text-size': 22,
          'text-keep-upright': false,
          'text-allow-overlap': true,
          'text-font': ['Noto Sans Bold'],
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': ['get', 'color'], 'text-halo-width': 1 },
      });

      map.addSource('signals', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'signals',
        type: 'circle',
        source: 'signals',
        paint: {
          'circle-radius': 6,
          'circle-color': SIGNAL_COLOR,
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });

      map.addSource('stores', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'stores',
        type: 'circle',
        source: 'stores',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 16, 7],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });
      map.on('mouseenter', 'stores', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'stores', () => (map.getCanvas().style.cursor = ''));

      map.addSource('hover', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'hover',
        type: 'circle',
        source: 'hover',
        paint: {
          'circle-radius': 7,
          'circle-color': '#111',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 3,
        },
      });

      map.on('mouseenter', 'routes-line', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'routes-line', () => (map.getCanvas().style.cursor = ''));
      setLoaded(true);
    });

    const popup = new maplibregl.Popup({ closeButton: true, offset: 10, maxWidth: '260px' });
    map.on('click', (e) => {
      const p = propsRef.current;
      // 點到便利商店 → 顯示資訊，不設定地點
      const store = map.getLayer('stores') ? map.queryRenderedFeatures(e.point, { layers: ['stores'] })[0] : undefined;
      if (store) {
        const pr = store.properties as { name: string; alongM: number; offsetM: number; hours?: string };
        const box = document.createElement('div');
        box.className = 'store-popup';
        const title = document.createElement('strong');
        title.textContent = pr.name;
        const info = document.createElement('div');
        info.textContent = `路線約 ${(pr.alongM / 1000).toFixed(1)} km 處 · 距路線 ${pr.offsetM} m`;
        box.append(title, info);
        if (pr.hours) {
          const hours = document.createElement('div');
          hours.textContent = `營業時間：${pr.hours === '24/7' ? '24 小時' : pr.hours}`;
          box.append(hours);
        }
        popup.setLngLat((store.geometry as GeoJSON.Point).coordinates as [number, number]).setDOMContent(box).addTo(map);
        return;
      }
      // 點到「未選取」的路線 → 切換選取；否則視為設定地點
      const hit = map.getLayer('routes-line')
        ? map.queryRenderedFeatures(e.point, { layers: ['routes-line'] })
        : [];
      const other = hit.find((f) => f.properties?.id && f.properties.id !== p.selectedId);
      if (other) {
        p.onSelectRoute(other.properties!.id as string);
        return;
      }
      p.onMapClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // 標記（起點、終點、經過點）
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    const add = (p: LatLng, el: HTMLElement, kind: 'start' | 'end' | 'waypoint', index: number) => {
      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([p.lng, p.lat])
        .addTo(map);
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        propsRef.current.onMovePoint(kind, index, { lat: ll.lat, lng: ll.lng });
      });
      el.addEventListener('click', (ev) => ev.stopPropagation());
      markersRef.current.push(marker);
    };
    props.waypoints.forEach((w, i) => add(w, makeMarkerEl('marker-way', String(i + 1)), 'waypoint', i));
    if (props.end && !props.loop) add(props.end, makeMarkerEl('marker-end', '終'), 'end', 0);
    if (props.start) add(props.start, makeMarkerEl('marker-start', props.loop ? '起終' : '起'), 'start', 0);
  }, [props.start, props.end, props.waypoints, props.loop]);

  // 路線
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: props.routes.map((r) => ({
        type: 'Feature',
        properties: {
          id: r.id,
          color: props.colors[r.id] ?? '#555',
          selected: r.id === props.selectedId,
          order: r.id === props.selectedId ? 10 : 0,
        },
        geometry: { type: 'LineString', coordinates: r.coordinates.map((c) => [c[0], c[1]]) },
      })),
    };
    (map.getSource('routes') as GeoJSONSource).setData(fc);

    const selected = props.routes.find((r) => r.id === props.selectedId);
    const { layers } = props;
    (map.getSource('way-overlay') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: (selected?.wayRuns ?? [])
        .filter((run) => (run.category === 'sidewalk' && layers.sidewalk) || (run.category === 'cycleway' && layers.cycleway))
        .map((run) => ({
          type: 'Feature',
          properties: { color: CATEGORY_COLOR[run.category] },
          geometry: {
            type: 'LineString',
            coordinates: selected!.coordinates.slice(run.from, run.to + 1).map((c) => [c[0], c[1]]),
          },
        })),
    });
    (map.getSource('stores') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: (layers.stores ? (selected?.stores ?? []) : []).map((s) => ({
        type: 'Feature',
        properties: {
          name: s.name,
          color: STORE_COLOR[s.brand],
          alongM: s.alongM,
          offsetM: s.offsetM,
          hours: s.openingHours ?? '',
        },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      })),
    });
    (map.getSource('signals') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: (layers.signals ? (selected?.signals ?? []) : []).map((s) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: s },
      })),
    });
  }, [loaded, props.routes, props.selectedId, props.colors, props.layers]);

  // 高度圖游標對應的位置
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource('hover') as GeoJSONSource).setData(
      props.hoverPoint
        ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: props.hoverPoint } }
        : emptyFC(),
    );
  }, [loaded, props.hoverPoint]);

  // 產生新路線後縮放到全部路線
  useEffect(() => {
    const map = mapRef.current;
    if (!map || props.routes.length === 0) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const r of props.routes) for (const c of r.coordinates) bounds.extend([c[0], c[1]]);
    const small = map.getContainer().clientWidth < 600;
    map.fitBounds(bounds, {
      // 下方留空間給高度剖面圖
      padding: { top: 50, left: 40, right: 60, bottom: small ? 130 : 200 },
      maxZoom: 16,
      duration: 600,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.focus) return;
    map.flyTo({ center: [props.focus.p.lng, props.focus.p.lat], zoom: Math.max(map.getZoom(), 15) });
  }, [props.focus]);

  return <div ref={containerRef} className="map" />;
}
