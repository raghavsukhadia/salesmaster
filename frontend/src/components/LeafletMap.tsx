import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { TrackStatus } from '../field/format'

export interface MapMarker {
  id: string
  lat: number
  lng: number
  kind: 'salesman' | 'dealer' | 'origin' | 'target' | 'pin'
  status?: TrackStatus // salesmen: only 'live' is drawn as live
  verified?: boolean // dealers: dashed outline when the saved location is not verified
  label: string
  detail?: string
  initial?: string
  selected?: boolean
}
export interface MapCircle { lat: number; lng: number; radiusM: number; tone?: 'blue' | 'orange' }

interface Props {
  markers: MapMarker[]
  circles?: MapCircle[]
  line?: [number, number][]
  fitKey?: string | number // bounds are re-fitted only when this changes, so a live poll never fights the user's panning
  focusMarkerId?: string // focus the selected salesman while retaining every dealer pin
  onMarkerClick?: (m: MapMarker) => void
  onMapClick?: (lat: number, lng: number) => void
  className?: string
  label: string
}

const COLORS = { live: '#2563eb', stale: '#d97706', lost: '#64748b', no_fix: '#94a3b8', off_duty: '#94a3b8' } as const

function iconFor(m: MapMarker): L.DivIcon {
  if (m.kind === 'dealer' || m.kind === 'target') {
    const stroke = m.selected ? '#991b1b' : '#b91c1c'
    return L.divIcon({
      className: 'dealer-map-marker', iconSize: [30, 40], iconAnchor: [15, 40], popupAnchor: [0, -35],
      html: `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40" style="overflow:visible;filter:drop-shadow(0 2px 2px rgba(0,0,0,.3))">
        <path d="M15 1C7.3 1 1 7.3 1 15c0 10.3 14 24 14 24s14-13.7 14-24C29 7.3 22.7 1 15 1Z" fill="#ef4444" stroke="${stroke}" stroke-width="${m.selected ? 3 : 1.5}"${m.verified === false ? ' stroke-dasharray="3 2"' : ''}/>
        <circle cx="15" cy="14.5" r="5.5" fill="white"/>
      </svg>`,
    })
  }
  const ring = m.selected ? 'box-shadow:0 0 0 4px rgba(37,99,235,.45),0 1px 4px rgba(0,0,0,.5);' : 'box-shadow:0 1px 4px rgba(0,0,0,.45);'
  let html: string
  let size = 22
  if (m.kind === 'salesman') {
    const st = m.status ?? 'live'
    const color = COLORS[st]
    // Live = solid. Stale/lost = visibly different (lighter, dashed ring) so an old position is never mistaken for a current one.
    const style = st === 'live'
      ? `background:${color};border:3px solid #fff;`
      : `background:#fff;border:3px dashed ${color};color:${color};`
    html = `<div style="width:30px;height:30px;border-radius:50%;${style}${ring}display:flex;align-items:center;justify-content:center;color:${st === 'live' ? '#fff' : color}"><svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6" r="3" fill="currentColor"/><path d="M4 18v-2a6 6 0 0 1 12 0v2Z" fill="currentColor"/></svg></div>`
    size = 30
  } else if (m.kind === 'origin') {
    html = `<div style="width:20px;height:20px;border-radius:50%;background:rgba(255,107,26,.25);border:3px solid #ff6b1a;${ring}"></div>`
    size = 20
  } else if (m.kind === 'pin') {
    html = `<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#2563eb;border:2px solid #fff;${ring}"></div>`
  } else {
    html = `<div style="width:22px;height:22px;border-radius:4px;background:#ff6b1a;border:3px solid #fff;${ring}"></div>`
  }
  return L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
}

export default function LeafletMap({ markers, circles = [], line, fitKey, focusMarkerId, onMarkerClick, onMapClick, className = 'h-[480px]', label }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const clickCb = useRef(onMapClick)
  const latest = useRef({ markers, circles, line })
  useEffect(() => { clickCb.current = onMapClick; latest.current = { markers, circles, line } })

  useEffect(() => {
    if (!el.current) return
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([20.59, 78.96], 5)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m)
    layer.current = L.layerGroup().addTo(m)
    m.on('click', (e: L.LeafletMouseEvent) => clickCb.current?.(e.latlng.lat, e.latlng.lng))
    const ro = new ResizeObserver(() => m.invalidateSize())
    ro.observe(el.current)
    map.current = m
    return () => { ro.disconnect(); m.remove(); map.current = null; layer.current = null }
  }, [])

  useEffect(() => {
    const g = layer.current
    if (!g) return
    g.clearLayers()
    for (const c of circles) {
      const color = c.tone === 'orange' ? '#ff6b1a' : '#2563eb'
      L.circle([c.lat, c.lng], { radius: c.radiusM, color, weight: 1.5, fillColor: color, fillOpacity: 0.08, interactive: false }).addTo(g)
    }
    if (line && line.length > 1) L.polyline(line, { color: '#2563eb', weight: 3, opacity: 0.8, interactive: false }).addTo(g)
    for (const m of markers) {
      const mk = L.marker([m.lat, m.lng], { icon: iconFor(m), title: m.label, keyboard: true, zIndexOffset: m.selected ? 1000 : m.kind === 'salesman' ? 500 : 0 })
      const tip = document.createElement('div') // textContent, never innerHTML: names are user data
      const b = document.createElement('strong'); b.textContent = m.label; tip.appendChild(b)
      if (m.detail) { tip.appendChild(document.createElement('br')); tip.appendChild(document.createTextNode(m.detail)) }
      mk.bindTooltip(tip, { direction: 'top', offset: [0, -10] })
      if (m.kind === 'dealer' || m.kind === 'target') mk.bindPopup(tip.cloneNode(true) as HTMLElement, { autoPan: false })
      if (onMarkerClick) mk.on('click', (e) => { L.DomEvent.stopPropagation(e); onMarkerClick(m) })
      mk.addTo(g)
      if (m.selected && (m.kind === 'dealer' || m.kind === 'target')) mk.openPopup()
    }
  }, [markers, circles, line, onMarkerClick])

  useEffect(() => {
    const m = map.current
    if (!m || fitKey === undefined) return
    const { markers: ms, circles: cs, line: ln } = latest.current
    const focus = focusMarkerId ? ms.find((marker) => marker.id === focusMarkerId) : undefined
    if (focus) { m.setView([focus.lat, focus.lng], 15); return }
    const b = L.latLngBounds([])
    ms.forEach((x) => b.extend([x.lat, x.lng]))
    // LatLng.toBounds works without a map; Circle.getBounds() needs the circle to already be on one and throws otherwise.
    cs.forEach((c) => b.extend(L.latLng(c.lat, c.lng).toBounds(c.radiusM * 2)))
    ln?.forEach((p) => b.extend(p))
    if (b.isValid()) m.fitBounds(b, { padding: [40, 40], maxZoom: 15 })
  }, [fitKey, focusMarkerId])

  return <div ref={el} role="application" aria-label={label} className={`z-0 w-full overflow-hidden rounded-2xl border bg-slate-100 ${className}`} />
}
