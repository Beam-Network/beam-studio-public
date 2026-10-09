import {
  visibleGraphLinks,
  type RoomGraph,
  type GraphLink,
} from "./room-member-graph-model";

export type GraphView = { yaw: number; pitch: number; zoom: number };
export const initialGraphView = (): GraphView => ({
  yaw: 0.25,
  pitch: -0.15,
  zoom: 1.3,
});
export type GraphTheme = {
  foreground: string;
  background: string;
  accent: string;
  muted: string;
};
type Projected = {
  x: number;
  y: number;
  z: number;
  scale: number;
  index: number;
};
export type GraphScene = {
  graph: RoomGraph;
  links: GraphLink[];
  selected: string | null;
  presence: Record<string, string>;
};

/** Pure Canvas projection: no physics, framework state or network work in the frame loop. */
export function drawRoomGraph(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scene: GraphScene,
  view: GraphView,
  theme: GraphTheme,
  logos: Map<string, HTMLImageElement>,
): Projected[] {
  ctx.clearRect(0, 0, width, height);
  const radius = Math.min(width * 0.34, height * 0.34) * view.zoom;
  const cy = Math.cos(view.yaw),
    sy = Math.sin(view.yaw),
    cp = Math.cos(view.pitch),
    sp = Math.sin(view.pitch);
  const points = scene.graph.nodes.map((node, index) => {
    const [x, y, z] = node.position,
      rx = x * cy + z * sy,
      rz = z * cy - x * sy;
    const ry = y * cp - rz * sp,
      depth = y * sp + rz * cp,
      scale = 3.5 / (3.5 - depth);
    return {
      x: width / 2 + rx * radius * scale,
      y: height / 2 + ry * radius * scale,
      z: depth,
      scale,
      index,
    };
  });
  ctx.lineWidth = 0.8;
  const arrow = (from: Projected, to: Projected) => {
    const dx = to.x - from.x,
      dy = to.y - from.y,
      length = Math.hypot(dx, dy);
    if (length < 32) return;
    const x = to.x - (dx / length) * 19,
      y = to.y - (dy / length) * 19;
    const ux = (dx / length) * 4,
      uy = (dy / length) * 4;
    ctx.beginPath();
    ctx.moveTo(x - ux + uy * 0.65, y - uy - ux * 0.65);
    ctx.lineTo(x, y);
    ctx.lineTo(x - ux - uy * 0.65, y - uy + ux * 0.65);
    ctx.stroke();
  };
  for (const link of scene.links) {
    const a = points[link.source]!,
      b = points[link.target]!;
    const focused =
      scene.graph.nodes[link.source]!.id === scene.selected ||
      scene.graph.nodes[link.target]!.id === scene.selected;
    ctx.strokeStyle = focused ? theme.accent : theme.muted;
    ctx.globalAlpha = focused ? 0.7 : 0.24 + (a.z + b.z + 2) * 0.05;
    ctx.setLineDash(link.forward.length && link.reverse.length ? [] : [2, 5]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (link.forward.length) arrow(a, b);
    if (link.reverse.length) arrow(b, a);
  }
  for (const point of [...points].sort((a, b) => a.z - b.z)) {
    const node = scene.graph.nodes[point.index]!,
      selected = node.id === scene.selected;
    const online = scene.presence[node.id] === "online" && node.active;
    const size =
      (node.kind === "storage" ? 12 : node.kind === "service" ? 6 : 4.5) *
      point.scale;
    const color = node.send || node.receive ? theme.accent : theme.muted;
    ctx.globalAlpha = (online ? 0.8 : 0.42) * (0.78 + (point.z + 1) * 0.11);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = selected ? 1.8 : 1.2;
    if (selected || node.privileged) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, size + (selected ? 7 : 4), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (node.kind === "storage") {
      const logo = node.logo ? logos.get(node.logo) : null;
      if (logo?.complete && logo.naturalWidth)
        ctx.drawImage(logo, point.x - size, point.y - size, size * 2, size * 2);
      else {
        ctx.strokeRect(point.x - size / 2, point.y - size / 2, size, size);
      }
    } else if (node.kind === "service") {
      ctx.beginPath();
      ctx.moveTo(point.x, point.y - size);
      ctx.lineTo(point.x + size, point.y);
      ctx.lineTo(point.x, point.y + size);
      ctx.lineTo(point.x - size, point.y);
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(point.x, point.y, size, 0, Math.PI * 2);
      ctx.stroke();
      if (node.send && node.receive) ctx.fill();
      else if (node.send) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, size, -Math.PI / 2, Math.PI / 2);
        ctx.closePath();
        ctx.fill();
      } else if (!node.receive) {
        ctx.beginPath();
        ctx.moveTo(point.x - size, point.y + size);
        ctx.lineTo(point.x + size, point.y - size);
        ctx.stroke();
      }
    }
    // Availability is independent from authorization and depth.
    ctx.globalAlpha = 1;
    ctx.fillStyle = online ? theme.accent : theme.muted;
    ctx.beginPath();
    ctx.arc(point.x + size + 4, point.y - size - 2, 1.8, 0, Math.PI * 2);
    ctx.fill();
    if (selected || scene.graph.nodes.length <= 16) {
      ctx.globalAlpha = selected ? 1 : online ? 0.75 : 0.48;
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      const label =
        node.name.length > 30 ? `${node.name.slice(0, 28)}…` : node.name;
      ctx.lineWidth = 4;
      ctx.strokeStyle = theme.background;
      const halfLabel = ctx.measureText(label).width / 2 + 8;
      const labelX = Math.max(halfLabel, Math.min(width - halfLabel, point.x));
      ctx.strokeText(label, labelX, point.y + size + 18);
      ctx.fillStyle = theme.foreground;
      ctx.fillText(label, labelX, point.y + size + 18);
    }
  }
  ctx.globalAlpha = 1;
  return points;
}

export function mountRoomGraph(
  canvas: HTMLCanvasElement,
  onSelect: (id: string | null) => void,
  onHover: (id: string | null) => void,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let scene: GraphScene = {
    graph: { nodes: [], links: [], channels: [] },
    links: [],
    selected: null,
    presence: {},
  };
  let view = initialGraphView(),
    width = 0,
    height = 0,
    frame = 0,
    last = 0;
  let visible = false,
    paused = false,
    disposed = false,
    hovered: string | null = null;
  let points: Projected[] = [],
    drag: { x: number; y: number; moved: boolean } | null = null;
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const logos = new Map<string, HTMLImageElement>();
  const theme = () => {
    const css = getComputedStyle(canvas);
    return {
      foreground: css.color,
      background: `hsl(${css.getPropertyValue("--card")})`,
      accent: `hsl(${css.getPropertyValue("--primary")})`,
      muted: `hsl(${css.getPropertyValue("--muted-foreground")})`,
    };
  };
  let colors = theme();
  function draw() {
    if (!disposed && visible && !document.hidden && width && height)
      points = drawRoomGraph(ctx!, width, height, scene, view, colors, logos);
  }
  function tick(now: number) {
    frame = 0;
    if (!last || now - last >= 1000 / 30) {
      if (!drag) view.yaw += Math.min(last ? now - last : 0, 100) * 0.00012;
      last = now;
      draw();
    }
    schedule();
  }
  function schedule() {
    const running =
      visible && !document.hidden && !media.matches && !paused && !disposed;
    canvas.dataset.motion = running ? "running" : "paused";
    if (!running) {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
    } else if (!frame) frame = requestAnimationFrame(tick);
  }
  function refresh() {
    colors = theme();
    draw();
    schedule();
  }
  const resize = new ResizeObserver(() => {
    const box = canvas.getBoundingClientRect();
    width = box.width;
    height = box.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
    refresh();
  });
  resize.observe(canvas);
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    refresh();
  });
  intersection.observe(canvas);
  const themeObserver = new MutationObserver(refresh);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  document.addEventListener("visibilitychange", refresh);
  media.addEventListener("change", refresh);
  function hit(event: PointerEvent) {
    const box = canvas.getBoundingClientRect(),
      x = event.clientX - box.left,
      y = event.clientY - box.top;
    return [...points]
      .sort((a, b) => b.z - a.z)
      .find((p) => Math.hypot(p.x - x, p.y - y) <= 18 * p.scale);
  }
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, moved: false };
  };
  const move = (event: PointerEvent) => {
    if (drag) {
      const dx = event.clientX - drag.x,
        dy = event.clientY - drag.y;
      drag.moved ||= Math.abs(dx) + Math.abs(dy) > 2;
      view.yaw += dx * 0.007;
      view.pitch = Math.max(-1.3, Math.min(1.3, view.pitch - dy * 0.007));
      drag.x = event.clientX;
      drag.y = event.clientY;
      draw();
    } else {
      const point = hit(event),
        id = point ? scene.graph.nodes[point.index]!.id : null;
      if (id !== hovered) {
        hovered = id;
        onHover(id);
      }
    }
  };
  const up = (event: PointerEvent) => {
    if (drag && !drag.moved) {
      const point = hit(event);
      onSelect(point ? scene.graph.nodes[point.index]!.id : null);
    }
    drag = null;
    if (canvas.hasPointerCapture(event.pointerId))
      canvas.releasePointerCapture(event.pointerId);
  };
  const cancel = () => {
    drag = null;
    hovered = null;
    onHover(null);
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    zoom(Math.exp(-event.deltaY * 0.001));
  };
  function zoom(factor: number) {
    view.zoom = Math.max(0.6, Math.min(1.7, view.zoom * factor));
    draw();
  }
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  canvas.addEventListener("pointerleave", cancel);
  canvas.addEventListener("wheel", wheel, { passive: false });
  return {
    update(
      graph: RoomGraph,
      presence: Record<string, string>,
      selected: string | null,
      manualPause: boolean,
    ) {
      scene = {
        graph,
        presence,
        selected,
        links: visibleGraphLinks(graph, selected),
      };
      paused = manualPause;
      for (const node of graph.nodes)
        if (node.logo && !logos.has(node.logo)) {
          const img = new Image();
          img.onload = draw;
          img.src = node.logo;
          logos.set(node.logo, img);
        }
      refresh();
    },
    reset() {
      view = initialGraphView();
      draw();
    },
    zoom,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", refresh);
      media.removeEventListener("change", refresh);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("pointerleave", cancel);
      canvas.removeEventListener("wheel", wheel);
      for (const img of logos.values()) img.onload = null;
    },
  };
}
