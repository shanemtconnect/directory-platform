"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { siteConfig } from "@/config/site.config";
import {
  mapStyleUrl,
  plottablePins,
  resolveView,
  toFeatureCollection,
  type ListingMapProps,
  type PlottedPin,
} from "./types";

// Type-only, so it is erased at build and pulls no MapLibre code into the page.
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";

/**
 * A map of listing pins that is never load-bearing.
 *
 * Three rules drive every decision below, in this order:
 *
 * 1. The listings are server-rendered elsewhere on the page. This component is
 *    decoration. If anything at all goes wrong — no key, no WebGL, a 403 on the
 *    style, a dead tile CDN — it collapses to `null` and says nothing. The
 *    reference site puts a grey box with an error string in the middle of its
 *    results page; we do not copy that.
 * 2. MapLibre is ~250kB of JS. It is not fetched until an IntersectionObserver
 *    says the container is nearly on screen, so it can never be on the critical
 *    path for LCP.
 * 3. Every pin is a real anchor element, not a canvas-painted circle, so it is
 *    focusable, middle-clickable and readable by a screen reader.
 */

const SOURCE_ID = "listing-pins";

/**
 * An invisible layer.
 *
 * `querySourceFeatures` only returns features from tiles that have actually
 * loaded, and a GeoJSON source only loads tiles when some layer references it.
 * Everything visible on this map is a DOM marker, so this layer exists purely to
 * keep the source alive. It paints nothing.
 */
const ANCHOR_LAYER_ID = "listing-pins-anchor";

/** If the style has neither loaded nor errored by now, treat it as dead. */
const STARTUP_TIMEOUT_MS = 12_000;

/** Start fetching roughly one screen before the container arrives. */
const PREFETCH_MARGIN = "400px 0px";

const CLUSTER_EASE_MS = 500;

type Phase = "idle" | "loading" | "ready" | "failed";

type MapLibreModule = typeof import("maplibre-gl");

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** GeoJSON feature properties are untyped by nature; narrow rather than cast. */
function readString(properties: unknown, key: string): string | null {
  if (typeof properties !== "object" || properties === null) return null;
  const value: unknown = (properties as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readNumber(properties: unknown, key: string): number | null {
  if (typeof properties !== "object" || properties === null) return null;
  const value: unknown = (properties as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildPinElement(name: string, href: string, accent: string): HTMLElement {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.title = name;
  anchor.setAttribute("aria-label", name);
  anchor.style.cssText = [
    "display:block",
    "width:16px",
    "height:16px",
    "border-radius:50%",
    `background:${accent}`,
    "box-shadow:0 0 0 2px #fff,0 1px 3px rgba(0,0,0,.45)",
    "cursor:pointer",
  ].join(";");
  return anchor;
}

function buildClusterElement(count: number, label: string, accent: string): HTMLButtonElement {
  const size = 26 + Math.min(count, 200) / 8;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = String(count);
  button.setAttribute("aria-label", label);
  button.style.cssText = [
    "display:flex",
    "align-items:center",
    "justify-content:center",
    `width:${String(size)}px`,
    `height:${String(size)}px`,
    "padding:0",
    "border:2px solid #fff",
    "border-radius:50%",
    `background:${accent}`,
    "color:#fff",
    "font:600 12px/1 system-ui,sans-serif",
    "box-shadow:0 1px 4px rgba(0,0,0,.45)",
    "cursor:pointer",
  ].join(";");
  return button;
}

export function ListingMap({
  pins,
  centre,
  zoom,
  className,
  height = "420px",
}: ListingMapProps): React.ReactElement | null {
  // Referenced as a static member expression so Next can inline it at build.
  const styleUrl = useMemo(() => mapStyleUrl(process.env.NEXT_PUBLIC_MAPTILER_KEY), []);

  const plotted = useMemo(() => plottablePins(pins), [pins]);

  // Object props are commonly inlined by callers; depend on the values, not the
  // identity, so a re-render does not churn the view.
  const centreLat = centre?.lat ?? null;
  const centreLng = centre?.lng ?? null;
  const view = useMemo(
    () =>
      resolveView(
        plotted,
        centreLat !== null && centreLng !== null ? { lat: centreLat, lng: centreLng } : undefined,
        zoom,
      ),
    [plotted, centreLat, centreLng, zoom],
  );

  /** Changes only when the plotted geometry changes, not on every render. */
  const signature = useMemo(
    () => plotted.map((pin) => `${pin.id}@${String(pin.lat)},${String(pin.lng)}`).join("|"),
    [plotted],
  );

  const enabled = styleUrl !== null && view !== null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const moduleRef = useRef<MapLibreModule | null>(null);
  const syncRef = useRef<(() => void) | null>(null);
  const plottedRef = useRef<PlottedPin[]>(plotted);
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    plottedRef.current = plotted;
  }, [plotted]);

  // Stage 1: wait until the container is nearly on screen. Nothing is fetched
  // before this fires.
  useEffect(() => {
    if (!enabled || phase !== "idle") return;
    const element = containerRef.current;
    if (element === null) return;

    if (typeof IntersectionObserver === "undefined") {
      setPhase("loading");
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          setPhase("loading");
        }
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [enabled, phase]);

  // Stage 2: fetch MapLibre, build the map, wire the markers.
  useEffect(() => {
    if (phase !== "loading") return;
    const element = containerRef.current;
    if (element === null || styleUrl === null || view === null) return;

    let disposed = false;
    let styleReady = false;
    let map: MapLibreMap | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const markers = new Map<string, MapLibreMarker>();
    const reduceMotion = prefersReducedMotion();
    const accent = siteConfig.theme.primary;

    /**
     * The only failure path. No message, no retry, no grey box — the container
     * unmounts and the page reads exactly as it did before hydration.
     */
    const collapse = (): void => {
      if (disposed) return;
      setPhase("failed");
    };

    void (async () => {
      // Both imports are dynamic so the stylesheet lands in the async chunk
      // beside the JS instead of in the route's render-blocking CSS. Started
      // first so it downloads in parallel, but awaited separately: an unstyled
      // map still beats no map, so a CSS failure must not collapse anything.
      const stylesheet = import("maplibre-gl/dist/maplibre-gl.css").catch(() => undefined);

      let maplibre: MapLibreModule;
      try {
        maplibre = await import("maplibre-gl");
      } catch {
        collapse();
        return;
      }
      await stylesheet;
      if (disposed) return;

      try {
        map = new maplibre.Map({
          container: element,
          style: styleUrl,
          center: [view.centre.lng, view.centre.lat],
          zoom: view.zoom,
          attributionControl: { compact: true },
          dragRotate: false,
          pitchWithRotate: false,
          touchZoomRotate: true,
          refreshExpiredTiles: false,
          fadeDuration: reduceMotion ? 0 : 300,
        });
      } catch {
        // No WebGL, or a container the browser refuses to render into.
        collapse();
        return;
      }

      const instance = map;
      mapRef.current = instance;
      moduleRef.current = maplibre;

      const syncMarkers = (): void => {
        if (disposed) return;
        let features;
        try {
          features = instance.querySourceFeatures(SOURCE_ID);
        } catch {
          return;
        }

        // Source tiles overlap, so the same feature comes back more than once.
        const seen = new Set<string>();

        for (const feature of features) {
          const geometry = feature.geometry;
          if (geometry.type !== "Point") continue;
          const lng = geometry.coordinates[0];
          const lat = geometry.coordinates[1];
          if (typeof lng !== "number" || typeof lat !== "number") continue;

          const clusterId = readNumber(feature.properties, "cluster_id");
          const id = readString(feature.properties, "id");
          const key = clusterId !== null ? `c:${String(clusterId)}` : `p:${id ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (markers.has(key)) continue;

          let element_: HTMLElement;
          if (clusterId !== null) {
            const count = readNumber(feature.properties, "point_count") ?? 0;
            element_ = buildClusterElement(
              count,
              `${String(count)} ${siteConfig.entity.plural} here. Zoom in to see them.`,
              accent,
            );
            element_.addEventListener("click", () => {
              const source = instance.getSource(SOURCE_ID);
              if (!(source instanceof maplibre.GeoJSONSource)) return;
              void source
                .getClusterExpansionZoom(clusterId)
                .then((expanded) => {
                  if (disposed) return;
                  instance.easeTo({
                    center: [lng, lat],
                    zoom: expanded,
                    duration: reduceMotion ? 0 : CLUSTER_EASE_MS,
                  });
                })
                .catch(() => {
                  /* A cluster that will not expand is not worth a message. */
                });
            });
          } else {
            const href = readString(feature.properties, "href");
            const name = readString(feature.properties, "name");
            if (href === null || name === null) continue;
            element_ = buildPinElement(name, href, accent);
          }

          markers.set(key, new maplibre.Marker({ element: element_ }).setLngLat([lng, lat]).addTo(instance));
        }

        for (const [key, marker] of markers) {
          if (seen.has(key)) continue;
          marker.remove();
          markers.delete(key);
        }
      };

      syncRef.current = syncMarkers;

      /**
       * An error before the style is up means the map will never work: no key,
       * a 403, a dead CDN. After the style is up it is a single missing tile,
       * which the map already renders around. Only the first case collapses.
       */
      instance.on("error", () => {
        if (!styleReady) collapse();
      });

      instance.on("load", () => {
        if (disposed) return;
        styleReady = true;
        if (timer !== undefined) clearTimeout(timer);

        try {
          instance.addSource(SOURCE_ID, {
            type: "geojson",
            data: toFeatureCollection(plottedRef.current),
            cluster: true,
            clusterRadius: 55,
            clusterMaxZoom: 15,
          });
          instance.addLayer({
            id: ANCHOR_LAYER_ID,
            type: "circle",
            source: SOURCE_ID,
            paint: { "circle-radius": 1, "circle-opacity": 0, "circle-stroke-width": 0 },
          });
          instance.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");

          if (view.bounds !== null) {
            // Always instant. This is the opening view, not a transition, and
            // an animated arrival is exactly what reduced-motion users opt out
            // of.
            instance.fitBounds(view.bounds, {
              padding: 48,
              maxZoom: 15,
              duration: 0,
              animate: false,
            });
          }
        } catch {
          collapse();
          return;
        }

        instance.on("sourcedata", syncMarkers);
        instance.on("moveend", syncMarkers);
        instance.on("zoomend", syncMarkers);
        syncMarkers();
        setPhase("ready");
      });

      timer = setTimeout(() => {
        if (!styleReady) collapse();
      }, STARTUP_TIMEOUT_MS);
    })();

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      syncRef.current = null;
      mapRef.current = null;
      moduleRef.current = null;
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      map?.remove();
    };
    // Deliberately not keyed on the pins. New pins go through the update effect
    // below; tearing the whole map down and refetching every tile because one
    // listing was geocoded would be gratuitous.
  }, [phase, styleUrl, view]);

  // Stage 3: push new pins into the live source without tearing the map down.
  useEffect(() => {
    if (phase !== "ready") return;
    const map = mapRef.current;
    const maplibre = moduleRef.current;
    if (map === null || maplibre === null) return;

    const source: unknown = map.getSource(SOURCE_ID);
    if (!(source instanceof maplibre.GeoJSONSource)) return;
    source.setData(toFeatureCollection(plottedRef.current));
    syncRef.current?.();
  }, [phase, signature]);

  if (!enabled || phase === "failed") return null;

  return (
    <div
      ref={containerRef}
      className={className}
      data-testid="listing-map"
      data-phase={phase}
      role="region"
      aria-label={`Map of ${siteConfig.entity.plural}`}
      style={{ height, width: "100%" }}
    />
  );
}

export default ListingMap;
